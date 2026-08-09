/**
 * @voiceminusone/transport-ably
 *
 * Ably pub/sub transport for VoiceMinusOne.
 *
 * Uses Ably channels for bidirectional communication. Audio is sent as
 * binary extras (never base64), wire protocol events as JSON messages.
 *
 * @example
 * ```typescript
 * import { ablyTransport } from '@voiceminusone/transport-ably'
 *
 * const transport = ablyTransport({
 *   key: process.env.ABLY_API_KEY,
 *   channelName: 'voice-session-1',
 * })
 * ```
 */

import type {
  Logger,
  Transport,
  TransportState,
  Unsubscribe,
} from '@voiceminusone/core'
import { ConsoleLogger, LogLevel, TransportError } from '@voiceminusone/core'

/**
 * Minimal Ably client interface (type shim).
 * We don't depend on `ably` at compile time — the user passes the client
 * or we dynamically import it.
 */
export interface AblyClientLike {
  channels: {
    get(name: string, options?: Record<string, unknown>): AblyChannelLike
  }
  connection: {
    on(event: 'connected', listener: () => void): void
    on(event: 'disconnected', listener: () => void): void
    on(event: 'suspended', listener: () => void): void
    on(event: 'failed', listener: (err: Error) => void): void
    close(): void
  }
}

export interface AblyChannelLike {
  subscribe(name: string, listener: (message: AblyMessageLike) => void): void
  unsubscribe(name: string, listener?: (message: AblyMessageLike) => void): void
  publish(name: string, data: unknown, extras?: Record<string, unknown>): Promise<void>
  presence: {
    enter(data?: unknown): Promise<void>
    leave(data?: unknown): Promise<void>
  }
}

export interface AblyMessageLike {
  name: string
  data: unknown
  extras?: { binary?: ArrayBuffer }
}

export interface AblyTransportOptions {
  /** Ably API key. Falls back to ABLY_API_KEY env. */
  key?: string
  /** An existing Ably client instance. Mutually exclusive with `key`. */
  client?: AblyClientLike
  /** Channel name for this session. Defaults to `voice:{sessionId}`. */
  channelName?: string
  /** Channel options (e.g. for encrypted channels). */
  channelOptions?: Record<string, unknown>
  /** Custom logger. */
  logger?: Logger
  /** Base channel name prefix when using auto-generated names. */
  channelPrefix?: string
}

/** Event names on the Ably channel. */
const AUDIO_EVENT = 'audio'
const EVENT_EVENT = 'event'

/**
 * Ably pub/sub transport.
 *
 * Audio flows as binary extras (ArrayBuffer, never base64).
 * Wire protocol events flow as JSON message data.
 */
export class AblyTransport implements Transport {
  readonly name = 'ably-transport'

  private readonly logger: Logger
  private readonly key: string | undefined
  private readonly channelName: string | undefined
  private readonly channelOptions: Record<string, unknown> | undefined
  private readonly channelPrefix: string
  private client: AblyClientLike | null = null
  private channel: AblyChannelLike | null = null
  private connected = false
  private connecting = false
  private errorMsg: string | undefined
  private disposed = false

  private audioHandlers: Array<(chunk: ArrayBuffer) => void> = []
  private eventHandlers: Array<(event: unknown) => void> = []

  constructor(options: AblyTransportOptions = {}) {
    this.logger = options.logger ?? new ConsoleLogger(LogLevel.Info)
    const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
    this.key = options.key ?? env?.env?.ABLY_API_KEY
    this.channelName = options.channelName
    this.channelOptions = options.channelOptions
    this.channelPrefix = options.channelPrefix ?? 'voice'
    this.client = options.client ?? null
  }

  async connect(sessionId: string): Promise<void> {
    if (this.disposed) {
      throw new TransportError('TRANSPORT_DISCONNECTED', 'Transport has been disposed')
    }
    if (this.connected) return

    this.connecting = true
    this.errorMsg = undefined

    try {
      // Create or reuse the Ably client
      if (!this.client) {
        if (!this.key) {
          throw new TransportError(
            'TRANSPORT_CONNECTION_FAILED',
            'No Ably key provided. Pass key or set ABLY_API_KEY.',
          )
        }
        this.client = await this.createClient(this.key)
      }

      // Get the channel
      const name = this.channelName ?? `${this.channelPrefix}:${sessionId}`
      this.channel = this.client.channels.get(name, this.channelOptions)

      // Subscribe to audio and events
      this.channel.subscribe(AUDIO_EVENT, (msg) => this.handleAudioMessage(msg))
      this.channel.subscribe(EVENT_EVENT, (msg) => this.handleEventMessage(msg))

      // Enter presence
      await this.channel.presence.enter({ sessionId })

      this.connected = true
      this.connecting = false
      this.logger.info('ably-transport', `Connected to channel: ${name}`)
    } catch (err) {
      this.connecting = false
      this.connected = false
      const msg = err instanceof Error ? err.message : String(err)
      this.errorMsg = msg
      throw new TransportError('TRANSPORT_CONNECTION_FAILED', `Ably connect failed: ${msg}`)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client || !this.channel) return

    try {
      this.channel.unsubscribe(AUDIO_EVENT)
      this.channel.unsubscribe(EVENT_EVENT)
      await this.channel.presence.leave()
    } catch (err) {
      this.logger.warn('ably-transport', `Error during disconnect: ${(err as Error).message}`)
    }

    this.channel = null
    this.connected = false
    this.logger.info('ably-transport', 'Disconnected')
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.channel || !this.connected) {
      this.logger.warn('ably-transport', 'Cannot send audio: not connected')
      return
    }
    // Send as binary extras — never base64
    void this.channel
      .publish(AUDIO_EVENT, null, { binary: chunk })
      .catch((err) => {
        this.logger.error('ably-transport', `Failed to publish audio: ${(err as Error).message}`)
      })
  }

  onAudio(handler: (chunk: ArrayBuffer) => void): Unsubscribe {
    this.audioHandlers.push(handler)
    return () => {
      const idx = this.audioHandlers.indexOf(handler)
      if (idx >= 0) this.audioHandlers.splice(idx, 1)
    }
  }

  sendEvent(event: unknown): void {
    if (!this.channel || !this.connected) {
      this.logger.warn('ably-transport', 'Cannot send event: not connected')
      return
    }
    void this.channel
      .publish(EVENT_EVENT, event)
      .catch((err) => {
        this.logger.error('ably-transport', `Failed to publish event: ${(err as Error).message}`)
      })
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

  async destroy(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.disconnect()
    if (this.client) {
      try {
        this.client.connection.close()
      } catch {
        // ignore
      }
    }
    this.client = null
  }

  // --- Internal handlers ---

  private handleAudioMessage(msg: AblyMessageLike): void {
    const audio = msg.extras?.binary
    if (audio && audio.byteLength > 0) {
      for (const handler of [...this.audioHandlers]) {
        try {
          handler(audio)
        } catch (err) {
          this.logger.error('ably-transport', `Audio handler error: ${(err as Error).message}`)
        }
      }
    }
  }

  private handleEventMessage(msg: AblyMessageLike): void {
    const event = msg.data
    if (event) {
      for (const handler of [...this.eventHandlers]) {
        try {
          handler(event)
        } catch (err) {
          this.logger.error('ably-transport', `Event handler error: ${(err as Error).message}`)
        }
      }
    }
  }

  /** Create an Ably client — overridable for testing. */
  protected async createClient(key: string): Promise<AblyClientLike> {
    const { Realtime } = await import('ably')
    return new Realtime({ key }) as unknown as AblyClientLike
  }
}

/**
 * Factory for creating an Ably transport.
 *
 * @example
 * ```typescript
 * import { ablyTransport } from '@voiceminusone/transport-ably'
 *
 * const transport = ablyTransport({
 *   key: process.env.ABLY_API_KEY,
 *   channelName: 'voice-session-1',
 * })
 * ```
 */
export function ablyTransport(options: AblyTransportOptions): Transport {
  return new AblyTransport(options)
}
