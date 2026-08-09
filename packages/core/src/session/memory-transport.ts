/**
 * MemoryTransport — linked transport pair for testing.
 *
 * Creates two transport endpoints that are connected in-memory.
 * What one side sends, the other receives — no network involved.
 *
 * This is the key testing pattern from voice-line that we keep.
 * It enables fast, deterministic integration tests.
 */

import type { Transport, TransportState, Unsubscribe } from '../interfaces'

export class MemoryTransport implements Transport {
  readonly name = 'memory-transport'

  private partner: MemoryTransport | null = null
  private audioHandlers: Array<(chunk: ArrayBuffer) => void> = []
  private eventHandlers: Array<(event: unknown) => void> = []
  private connected = false
  private connecting = false
  private errorMsg: string | undefined

  /** Link two transports together in-memory. */
  static pair(): [MemoryTransport, MemoryTransport] {
    const a = new MemoryTransport()
    const b = new MemoryTransport()
    a.partner = b
    b.partner = a
    return [a, b]
  }

  async connect(_sessionId: string): Promise<void> {
    this.connecting = true
    this.connected = true
    this.connecting = false
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.audioHandlers = []
    this.eventHandlers = []
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.partner || !this.connected) return
    for (const handler of this.partner.audioHandlers) {
      handler(chunk)
    }
  }

  onAudio(handler: (chunk: ArrayBuffer) => void): Unsubscribe {
    this.audioHandlers.push(handler)
    return () => {
      const idx = this.audioHandlers.indexOf(handler)
      if (idx >= 0) this.audioHandlers.splice(idx, 1)
    }
  }

  sendEvent(event: unknown): void {
    if (!this.partner) return
    for (const handler of this.partner.eventHandlers) {
      handler(event)
    }
  }

  onEvent(handler: (event: unknown) => void): Unsubscribe {
    this.eventHandlers.push(handler)
    return () => {
      const idx = this.eventHandlers.indexOf(handler)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
    }
  }

  get state(): TransportState {
    return {
      connected: this.connected,
      connecting: this.connecting,
      ...(this.errorMsg !== undefined ? { error: this.errorMsg } : {}),
    }
  }

  // Plugin lifecycle (no-ops for in-memory)
  async init(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}
