/**
 * WebSocketTransport — bridges a real `ws` WebSocket connection to the
 * Transport interface from @voiceminusone/core.
 *
 * Binary WebSocket frames carry audio as raw ArrayBuffer (never base64).
 * Text WebSocket frames carry JSON wire protocol events.
 *
 * Per R-017: frame type is determined by the WebSocket message type itself,
 * never by heuristic byte inspection.
 */

import type { Logger } from '@voiceminusone/core'
import { ConsoleLogger, LogLevel, TransportError } from '@voiceminusone/core'
import type { Transport, TransportState, Unsubscribe } from '@voiceminusone/core'

/**
 * Minimal interface that a `ws` WebSocket (or compatible mock) satisfies.
 *
 * We define this locally so the module compiles without `@types/ws` at
 * type-check time. At runtime, the real `ws` WebSocket is used.
 */
export interface WsSocket {
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

/**
 * Options for constructing a WebSocketTransport.
 */
export interface WebSocketTransportOptions {
  /** An existing WebSocket instance to wrap. Mutually exclusive with `url`. */
  socket?: WsSocket
  /** URL to connect to when no socket is provided. */
  url?: string
  /** Optional factory to create the WebSocket (useful for testing). */
  createSocket?: (url: string) => WsSocket
  /** Sub-protocol(s) to negotiate. */
  protocols?: string | string[]
  /** Custom logger. Defaults to a ConsoleLogger at Info level. */
  logger?: Logger
}

/**
 * Adapter that bridges a `ws` WebSocket to the Transport interface.
 *
 * Audio flows as binary frames (ArrayBuffer); wire protocol events flow as
 * text frames (JSON). The adapter never inspects byte values to distinguish
 * them — it relies on the WebSocket binary/text type directly.
 */
export class WebSocketTransport implements Transport {
  readonly name = 'websocket-transport'

  private socket: WsSocket | null
  private readonly url: string | undefined
  private readonly createSocket: ((url: string) => WsSocket) | undefined
  private readonly protocols: string | string[] | undefined
  private readonly logger: Logger

  private audioHandlers: Array<(chunk: ArrayBuffer) => void> = []
  private eventHandlers: Array<(event: unknown) => void> = []
  private connected = false
  private connecting = false
  private errorMsg: string | undefined
  private disposed = false

  constructor(options: WebSocketTransportOptions = {}) {
    this.socket = options.socket ?? null
    this.url = options.url
    this.createSocket = options.createSocket
    this.protocols = options.protocols
    this.logger = options.logger ?? new ConsoleLogger(LogLevel.Info)

    if (this.socket) {
      this.attach(this.socket)
    }
  }

  async connect(sessionId: string): Promise<void> {
    if (this.disposed) {
      throw new TransportError('TRANSPORT_DISCONNECTED', 'Transport has been disposed')
    }

    this.connecting = true
    this.errorMsg = undefined

    try {
      if (!this.socket) {
        const url = this.url
        if (!url && !this.createSocket) {
          throw new TransportError(
            'TRANSPORT_CONNECTION_FAILED',
            'No socket and no url/createSocket provided — cannot connect',
          )
        }
        const targetUrl = url ?? sessionId
        if (this.createSocket) {
          this.socket = this.createSocket(targetUrl)
        } else {
          // Lazy import so that `ws` is only required when actually connecting.
          const ws = await import('ws')
          this.socket = this.protocols
            ? (new ws.WebSocket(targetUrl, this.protocols) as unknown as WsSocket)
            : (new ws.WebSocket(targetUrl) as unknown as WsSocket)
        }
        this.attach(this.socket)
      }

      // If the socket is already open, mark connected immediately.
      // Otherwise wait for the open event (or close/error).
      if (this.socket.readyState === this.socket.OPEN) {
        this.connected = true
        this.connecting = false
        return
      }

      await this.waitForOpen(this.socket)
      this.connected = true
      this.connecting = false
      this.logger.info('ws-transport', `Connected (session=${sessionId})`)
    } catch (err) {
      this.connecting = false
      this.connected = false
      const msg = err instanceof Error ? err.message : String(err)
      this.errorMsg = msg
      throw new TransportError('TRANSPORT_CONNECTION_FAILED', `WebSocket connect failed: ${msg}`)
    }
  }

  async disconnect(): Promise<void> {
    this.connecting = false
    this.connected = false

    if (this.socket) {
      const sock = this.socket
      this.detach(sock)
      try {
        sock.close(1000, 'disconnect')
      } catch {
        // Best-effort close — ignore errors on teardown.
      }
    }
    this.socket = null
    this.audioHandlers = []
    this.eventHandlers = []
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.socket || !this.connected) {
      this.logger.warn('ws-transport', 'sendAudio called while not connected — dropping')
      return
    }
    try {
      this.socket.send(chunk)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error('ws-transport', `sendAudio failed: ${msg}`)
      this.errorMsg = msg
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
    if (!this.socket || !this.connected) {
      this.logger.warn('ws-transport', 'sendEvent called while not connected — dropping')
      return
    }
    try {
      const text = typeof event === 'string' ? event : JSON.stringify(event)
      this.socket.send(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error('ws-transport', `sendEvent failed: ${msg}`)
      this.errorMsg = msg
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

  // --- PluginLifecycle ---

  async init(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    await this.disconnect()
  }
  async destroy(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.disconnect()
  }

  // --- Internals ---

  private waitForOpen(socket: WsSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      if (socket.readyState === socket.OPEN) {
        resolve()
        return
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const onClose = () => {
        cleanup()
        reject(new Error('Connection closed before open'))
      }
      const cleanup = () => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
  }

  private attach(socket: WsSocket): void {
    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame → audio (raw ArrayBuffer).
        const buf = toArrayBuffer(data)
        for (const handler of [...this.audioHandlers]) {
          handler(buf)
        }
      } else {
        // Text frame → JSON wire protocol event.
        const text = typeof data === 'string' ? data : uint8ToString(data as Uint8Array)
        let event: unknown
        try {
          event = JSON.parse(text)
        } catch {
          this.logger.warn('ws-transport', `Received non-JSON text frame, passing raw: ${text}`)
          event = text
        }
        for (const handler of [...this.eventHandlers]) {
          handler(event)
        }
      }
    })

    socket.on('close', () => {
      this.connected = false
      this.connecting = false
      this.logger.info('ws-transport', 'Socket closed')
    })

    socket.on('error', (err: Error) => {
      this.logger.error('ws-transport', `Socket error: ${err.message}`)
      this.errorMsg = err.message
    })
  }

  private detach(socket: WsSocket): void {
    socket.removeAllListeners('message')
    socket.removeAllListeners('close')
    socket.removeAllListeners('error')
  }
}

// --- Helpers ---

/** Convert various binary data representations to an ArrayBuffer. */
function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data
  }
  if (data instanceof Uint8Array) {
    // Slice to get a proper ArrayBuffer copy (handles byteOffset/byteLength).
    const { buffer, byteOffset, byteLength } = data
    return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  // Fallback: treat as a single byte.
  return new ArrayBuffer(0)
}

/** Convert a Uint8Array (or similar) to a UTF-8 string without Buffer. */
function uint8ToString(data: Uint8Array): string {
  let result = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    const slice = data.subarray(i, Math.min(i + chunk, data.length))
    result += String.fromCharCode(...slice)
  }
  // Use TextDecoder if available for proper UTF-8.
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8').decode(data)
    } catch {
      // Fall through to manual result.
    }
  }
  return result
}

// --- WebSocketServer ---

/**
 * Minimal interface for a `ws` WebSocketServer (or compatible mock).
 */
export interface WsServerLike {
  on(event: 'connection', listener: (socket: WsSocket) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: () => void): void
  close(cb?: (err?: Error) => void): void
  address?(): { port: number; host: string } | string
}

/**
 * Options for constructing a WebSocketServer.
 */
export interface WebSocketServerOptions {
  /** Port to listen on. */
  port?: number
  /** Host to bind to. */
  host?: string
  /** Path to listen on (for upgrade-based servers). */
  path?: string
  /** Existing HTTP server to attach to. */
  server?: unknown
  /** Custom logger. */
  logger?: Logger
  /** Optional factory to create the WebSocketServer (useful for testing). */
  createServer?: (opts: Record<string, unknown>) => WsServerLike
}

/**
 * Accepts incoming WebSocket connections and produces a WebSocketTransport
 * for each. Callers subscribe via `onConnection`.
 *
 * This is a thin wrapper around `ws`'s WebSocketServer that bridges each
 * accepted connection into a Transport instance.
 */
export class WebSocketServer {
  private server: WsServerLike | null = null
  private readonly logger: Logger
  private readonly connectionListeners: Array<(transport: WebSocketTransport) => void> = []
  private readonly options: WebSocketServerOptions

  constructor(options: WebSocketServerOptions = {}) {
    this.options = options
    this.logger = options.logger ?? new ConsoleLogger(LogLevel.Info)
  }

  /**
   * Start listening. Returns the bound port (useful when port 0 is given).
   */
  async start(): Promise<number> {
    if (this.server) {
      throw new TransportError('TRANSPORT_CONNECTION_FAILED', 'WebSocketServer already started')
    }

    const opts: Record<string, unknown> = {}
    if (this.options.port !== undefined) opts.port = this.options.port
    if (this.options.host !== undefined) opts.host = this.options.host
    if (this.options.path !== undefined) opts.path = this.options.path
    if (this.options.server !== undefined) opts.server = this.options.server

    if (this.options.createServer) {
      this.server = this.options.createServer(opts)
    } else {
      const ws = await import('ws')
      this.server = new ws.WebSocketServer(opts) as unknown as WsServerLike
    }

    this.server.on('connection', (socket: WsSocket) => {
      const transport = new WebSocketTransport({
        socket,
        logger: this.logger,
      })
      // The socket is already open when the server hands it to us.
      // Mark connected by going through connect() which short-circuits on OPEN.
      void transport.connect('incoming').catch((err) => {
        this.logger.error('ws-server', `Failed to init incoming transport: ${(err as Error).message}`)
      })
      for (const listener of [...this.connectionListeners]) {
        listener(transport)
      }
    })

    this.server.on('error', (err: Error) => {
      this.logger.error('ws-server', `Server error: ${err.message}`)
    })

    // Resolve the actual port (for port: 0).
    const addr = this.server.address?.()
    if (typeof addr === 'object' && addr !== null && 'port' in addr) {
      return addr.port
    }
    return this.options.port ?? 0
  }

  /** Register a handler for new incoming connections. */
  onConnection(handler: (transport: WebSocketTransport) => void): Unsubscribe {
    this.connectionListeners.push(handler)
    return () => {
      const idx = this.connectionListeners.indexOf(handler)
      if (idx >= 0) this.connectionListeners.splice(idx, 1)
    }
  }

  /** Stop the server and release the port. */
  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = null
  }
}
