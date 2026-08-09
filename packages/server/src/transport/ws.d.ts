/**
 * Ambient type declarations for the `ws` package.
 *
 * This file allows the transport module to type-check without `@types/ws`
 * installed. The `ws` package is a declared runtime dependency in
 * package.json. When `@types/ws` is present, its richer types take
 * precedence over these minimal declarations.
 */

declare module 'ws' {
  export interface WebSocket {
    readonly OPEN: number
    readonly CLOSED: number
    readonly readyState: number
    send(data: unknown): void
    close(code?: number, reason?: string): void
    on(event: 'open', listener: () => void): this
    on(event: 'close', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this
    once(event: 'open', listener: () => void): this
    once(event: 'close', listener: () => void): this
    once(event: 'error', listener: (err: Error) => void): this
    off(event: 'open', listener: () => void): this
    off(event: 'close', listener: () => void): this
    off(event: 'error', listener: (err: Error) => void): this
    removeAllListeners(event: string): this
  }

  export interface WebSocketConstructor {
    readonly OPEN: number
    readonly CLOSED: number
    new (url: string, protocols?: string | string[]): WebSocket
  }

  export const WebSocket: WebSocketConstructor

  export interface WebSocketServer {
    on(event: 'connection', listener: (socket: WebSocket) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'close', listener: () => void): this
    close(cb?: (err?: Error) => void): void
    address(): { port: number; host: string } | string
  }

  export interface WebSocketServerConstructor {
    new (opts?: Record<string, unknown>): WebSocketServer
  }

  export const WebSocketServer: WebSocketServerConstructor
}
