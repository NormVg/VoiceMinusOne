/**
 * Event bus — typed pub/sub for plugin communication.
 *
 * Plugins use this to emit and listen for events without direct coupling.
 */

import { EventEmitter } from 'eventemitter3'

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>
export type Unsubscribe = () => void

export interface EventBus {
  on<T>(event: string, handler: EventHandler<T>): Unsubscribe
  once<T>(event: string, handler: EventHandler<T>): Unsubscribe
  emit<T>(event: string, payload: T): void
  off(event: string): void
  clear(): void
}

export class TypedEventBus implements EventBus {
  private emitter = new EventEmitter()

  on<T>(event: string, handler: EventHandler<T>): Unsubscribe {
    this.emitter.on(event, handler as EventHandler)
    return () => this.emitter.off(event, handler as EventHandler)
  }

  once<T>(event: string, handler: EventHandler<T>): Unsubscribe {
    this.emitter.once(event, handler as EventHandler)
    return () => this.emitter.off(event, handler as EventHandler)
  }

  emit<T>(event: string, payload: T): void {
    this.emitter.emit(event, payload)
  }

  off(event: string): void {
    this.emitter.removeAllListeners(event)
  }

  clear(): void {
    this.emitter.removeAllListeners()
  }
}
