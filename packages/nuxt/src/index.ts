/**
 * @voiceminusone/nuxt
 *
 * Nuxt v4 server module for VoiceMinusOne.
 *
 * Provides a Nuxt module that registers a crossws WebSocket handler
 * in Nitro, creating a VoiceMinusOne session for each connection.
 *
 * @example
 * ```typescript
 * // nuxt.config.ts
 * export default defineNuxtConfig({
 *   modules: ['@voiceminusone/nuxt'],
 *   voice: {
 *     stt: sarvam.stt({ apiKey: process.env.SARVAM_API_KEY }),
 *     tts: sarvam.tts({ apiKey: process.env.SARVAM_API_KEY }),
 *     brain: aiSdkBrain({ model: openai('gpt-4o') }),
 *   },
 * })
 * ```
 */

import type {
  STTProvider,
  TTSProvider,
  Brain,
  Logger,
} from '@voiceminusone/core'
import { ConsoleLogger, LogLevel } from '@voiceminusone/core'
import { SessionManager } from '@voiceminusone/server'
import type { WebSocketTransport } from '@voiceminusone/server'

/**
 * Minimal crossws Peer interface (type shim).
 * We don't depend on crossws at compile time.
 */
export interface CrossWSPeer {
  id: string
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  publish(topic: string, data: string | ArrayBuffer): void
  readonly readyState: number
}

export interface CrossWSAdapter {
  toWebSocket(peer: CrossWSPeer): WebSocketTransport
}

/**
 * Configuration for the VoiceMinusOne Nuxt module.
 */
export interface VoiceModuleOptions {
  /** STT provider. */
  stt?: STTProvider
  /** TTS provider. */
  tts?: TTSProvider
  /** Brain (LLM) function. */
  brain?: Brain
  /** Sample rate for audio (default: 16000). */
  sampleRate?: number
  /** WebSocket path (default: /ws). */
  path?: string
  /** Custom logger. */
  logger?: Logger
  /**
   * Factory functions for creating providers per-session.
   * Useful when providers need per-session state.
   */
  sttFactory?: () => STTProvider
  ttsFactory?: () => TTSProvider
  brainFactory?: () => Brain
}

/**
 * Create a crossws WebSocket handler for VoiceMinusOne sessions.
 *
 * This function bridges crossws peers to VoiceMinusOne transports and
 * creates a SessionManager for each connection.
 *
 * @example
 * ```typescript
 * // server/routes/voice.ts
 * import { createVoiceHandler } from '@voiceminusone/nuxt'
 *
 * export default defineWebSocketHandler(createVoiceHandler({
 *   stt: sarvam.stt({ apiKey: process.env.SARVAM_API_KEY }),
 *   tts: sarvam.tts({ apiKey: process.env.SARVAM_API_KEY }),
 *   brain: aiSdkBrain({ model: openai('gpt-4o') }),
 * }))
 * ```
 */
export function createVoiceHandler(options: VoiceModuleOptions) {
  const logger = options.logger ?? new ConsoleLogger(LogLevel.Info)
  const sessions = new Map<string, SessionManager>()

  return {
    open(peer: CrossWSPeer) {
      logger.info('nuxt-voice', `New connection: ${peer.id}`)

      // Create a transport adapter for this peer
      const transport = createPeerTransport(peer, logger)

      // Create providers (factory or static)
      const stt = options.sttFactory?.() ?? options.stt
      const tts = options.ttsFactory?.() ?? options.tts
      const brain = options.brainFactory?.() ?? options.brain

      if (!stt || !tts || !brain) {
        logger.error('nuxt-voice', 'Missing STT, TTS, or Brain provider')
        peer.close(1000, 'Configuration error')
        return
      }

      // Create the session
      const session = new SessionManager({
        transport,
        stt,
        tts,
        brain,
        sampleRate: options.sampleRate ?? 16000,
        logger,
        sessionId: peer.id,
      })

      sessions.set(peer.id, session)

      session.start().catch((err) => {
        logger.error('nuxt-voice', `Session start failed: ${(err as Error).message}`)
      })
    },

    message(peer: CrossWSPeer, message: { type: 'text' | 'binary'; data: string | ArrayBuffer }) {
      const session = sessions.get(peer.id)
      if (!session) return

      // Route the message to the transport
      const transport = (session as unknown as { transport: PeerTransport }).transport
      if (transport) {
        transport.handleMessage(message.data)
      }
    },

    close(peer: CrossWSPeer) {
      logger.info('nuxt-voice', `Connection closed: ${peer.id}`)
      const session = sessions.get(peer.id)
      if (session) {
        session.destroy().catch((err) => {
          logger.error('nuxt-voice', `Session destroy failed: ${(err as Error).message}`)
        })
        sessions.delete(peer.id)
      }
    },

    error(_peer: CrossWSPeer, error: Error) {
      logger.error('nuxt-voice', `Connection error: ${error.message}`)
    },
  }
}

/**
 * Create a Transport adapter for a crossws peer.
 */
function createPeerTransport(peer: CrossWSPeer, logger: Logger): PeerTransport {
  return new PeerTransport(peer, logger)
}

/**
 * Transport adapter that bridges a crossws peer to the Transport interface.
 */
class PeerTransport implements Transport {
  readonly name = 'crossws-transport'
  private readonly peer: CrossWSPeer
  private readonly logger: Logger
  private audioHandlers: Array<(chunk: ArrayBuffer) => void> = []
  private eventHandlers: Array<(event: unknown) => void> = []
  private connected = true
  private errorMsg: string | undefined

  constructor(peer: CrossWSPeer, logger: Logger) {
    this.peer = peer
    this.logger = logger
  }

  async connect(_sessionId: string): Promise<void> {
    // Already connected via crossws
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.connected) return
    this.peer.send(chunk)
  }

  onAudio(handler: (chunk: ArrayBuffer) => void): () => void {
    this.audioHandlers.push(handler)
    return () => {
      const idx = this.audioHandlers.indexOf(handler)
      if (idx >= 0) this.audioHandlers.splice(idx, 1)
    }
  }

  sendEvent(event: unknown): void {
    if (!this.connected) return
    this.peer.send(JSON.stringify(event))
  }

  onEvent(handler: (event: unknown) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      const idx = this.eventHandlers.indexOf(handler)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
    }
  }

  get state() {
    return {
      connected: this.connected,
      connecting: false,
      ...(this.errorMsg !== undefined ? { error: this.errorMsg } : {}),
    }
  }

  async destroy(): Promise<void> {
    this.connected = false
    this.audioHandlers = []
    this.eventHandlers = []
  }

  /** Handle an incoming message from the peer. */
  handleMessage(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      // JSON event
      try {
        const event = JSON.parse(data)
        for (const handler of [...this.eventHandlers]) {
          try {
            handler(event)
          } catch (err) {
            this.logger.error('crossws-transport', `Event handler error: ${(err as Error).message}`)
          }
        }
      } catch (err) {
        this.logger.warn('crossws-transport', `Invalid JSON: ${(err as Error).message}`)
      }
    } else {
      // Binary audio
      for (const handler of [...this.audioHandlers]) {
        try {
          handler(data)
        } catch (err) {
          this.logger.error('crossws-transport', `Audio handler error: ${(err as Error).message}`)
        }
      }
    }
  }
}

// Re-export types for the Transport interface
import type { Transport } from '@voiceminusone/core'
