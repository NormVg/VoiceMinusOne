/**
 * Sarvam Bulbul TTS provider.
 *
 * Implements the VoiceMinusOne TTSProvider interface.
 * Uses WebSocket streaming (wss://api.sarvam.ai/text-to-speech/ws) as the
 * primary transport — connect once, send config, stream text, receive audio.
 * Falls back to REST for environments without WebSocket support.
 *
 * WebSocket protocol (per Sarvam docs):
 * 1. Connect: wss://api.sarvam.ai/text-to-speech/ws?api-subscription-key=KEY
 * 2. Send config: { type: "config", data: { speaker, language_code } }
 * 3. Send text:   { type: "convert", data: { text } }
 * 4. Send flush:  { type: "flush" }
 * 5. Receive:     { type: "audio", data: { audio: "<base64>" } }
 */

import type {
  AudioChunk,
  TTSConfig,
  TTSProvider,
  PluginContext,
} from '@voiceminusone/core'
import { PluginError } from '@voiceminusone/core'
import {
  authHeaders,
  resolveApiKey,
  stripWavHeader,
  SARVAM_BASE_URL,
  type SarvamCredentials,
} from './shared'

export interface SarvamTTSOptions extends SarvamCredentials {
  /** Default speaker. bulbul:v3 default is `shubh`. */
  speaker?: string
  language?: string
  model?: string
  pace?: number
  sampleRate?: number
}

/** Message types for the Sarvam TTS WebSocket protocol. */
type TTSWsMessage =
  | { type: 'config'; data: { speaker: string; language_code: string } }
  | { type: 'convert'; data: { text: string } }
  | { type: 'flush' }

/** Minimal WebSocket interface (works with both browser and ws package). */
interface TTSWebSocketLike {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}

/** WebSocket readyState.OPEN constant. */
const WS_OPEN = 1

/**
 * Sarvam Bulbul TTS — streams audio via WebSocket.
 *
 * Implements the TTSProvider interface with `synthesize()` returning an
 * AsyncIterable<AudioChunk>. Each call to `synthesize()` opens a fresh
 * WebSocket connection, sends config + text + flush, and yields audio
 * chunks as they arrive.
 */
export class SarvamTTS implements TTSProvider {
  readonly name = 'sarvam-tts'
  private readonly options: SarvamTTSOptions
  private readonly apiKey: string
  private readonly baseUrl: string
  private ctx: PluginContext | undefined
  private activeControllers = new Set<AbortController>()

  constructor(options: SarvamTTSOptions = {}) {
    this.options = options
    this.apiKey = resolveApiKey(options.apiKey)
    this.baseUrl = options.baseUrl ?? SARVAM_BASE_URL
  }

  async init(context: PluginContext): Promise<void> {
    this.ctx = context
    this.ctx.logger.debug('sarvam-tts', 'Initialized')
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.abort()
  }

  async destroy(): Promise<void> {
    this.abort()
  }

  abort(): void {
    for (const controller of this.activeControllers) {
      controller.abort()
    }
    this.activeControllers.clear()
  }

  /**
   * Synthesize text to audio via WebSocket streaming.
   *
   * Opens a WebSocket connection to the Sarvam TTS endpoint, sends a config
   * message, then the text, then a flush signal. Audio chunks arrive as
   * base64-encoded messages and are yielded as AudioChunk.
   *
   * Falls back to REST if WebSocket is unavailable.
   */
  async *synthesize(
    text: string,
    config: TTSConfig,
  ): AsyncIterable<AudioChunk> {
    const trimmed = text.trim()
    if (!trimmed) return

    const controller = new AbortController()
    this.activeControllers.add(controller)
    const signal = controller.signal

    const sampleRate = this.options.sampleRate ?? 16000
    const numChannels = 1
    const speaker = config.speaker ?? this.options.speaker ?? 'shubh'
    const language = config.language ?? this.options.language ?? 'en-IN'
    const model = config.model ?? this.options.model ?? 'bulbul:v3'
    const pace = config.pace ?? this.options.pace ?? 1.0

    try {
      yield* this.synthesizeWs(trimmed, {
        speaker,
        language,
        model,
        pace,
        sampleRate,
        numChannels,
        signal,
      })
    } catch (err) {
      if (signal.aborted) return
      this.ctx?.logger.warn(
        'sarvam-tts',
        `WebSocket synthesis failed: ${(err as Error).message}. Falling back to REST.`,
      )
      yield* this.synthesizeRest(trimmed, {
        speaker,
        language,
        model,
        pace,
        sampleRate,
        numChannels,
        signal,
      })
    } finally {
      this.activeControllers.delete(controller)
    }
  }

  /**
   * WebSocket-based synthesis.
   *
   * Connects to wss://api.sarvam.ai/text-to-speech/ws, sends config + text +
   * flush, and yields audio chunks from the response messages.
   */
  private async *synthesizeWs(
    text: string,
    opts: {
      speaker: string
      language: string
      model: string
      pace: number
      sampleRate: number
      numChannels: number
      signal: AbortSignal
    },
  ): AsyncIterable<AudioChunk> {
    const params = new URLSearchParams({
      'api-subscription-key': this.apiKey,
      model: opts.model,
    })

    const wsUrl = `${this.baseUrl.replace('https', 'wss')}/text-to-speech/ws?${params}`

    const ws = await this.openWebSocket(wsUrl)
    if (!ws) {
      throw new PluginError('TTS_FAILED', 'Failed to connect to Sarvam TTS WebSocket')
    }

    const audioQueue: ArrayBuffer[] = []
    let resolveAudio: (() => void) | null = null
    let wsClosed = false
    let wsError: Error | null = null
    let configSent = false

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>
        const msgType = msg.type

        if (msgType === 'audio') {
          const data = msg.data as Record<string, unknown> | undefined
          const b64 = data?.audio
          if (typeof b64 === 'string' && b64.length > 0) {
            const audioData = base64ToArrayBuffer(b64)
            const pcm = stripWavHeader(audioData)
            audioQueue.push(pcm)
            resolveAudio?.()
          }
        } else if (msgType === 'event' || msgType === 'complete') {
          // Completion event — mark as done
          wsClosed = true
          resolveAudio?.()
        }
      } catch (err) {
        this.ctx?.logger.warn(
          'sarvam-tts',
          `Failed to parse WS message: ${(err as Error).message}`,
        )
      }
    }

    ws.onerror = () => {
      wsError = new PluginError('TTS_FAILED', 'Sarvam TTS WebSocket error')
      wsClosed = true
      resolveAudio?.()
    }

    ws.onclose = () => {
      wsClosed = true
      resolveAudio?.()
    }

    // Wait for connection to open
    await this.waitForOpen(ws)

    // 1. Send config message
    const configMsg: TTSWsMessage = {
      type: 'config',
      data: {
        speaker: opts.speaker,
        language_code: opts.language,
      },
    }
    ws.send(JSON.stringify(configMsg))
    configSent = true
    this.ctx?.logger.debug('sarvam-tts', 'Sent config message')

    // 2. Send text message
    const convertMsg: TTSWsMessage = {
      type: 'convert',
      data: { text },
    }
    ws.send(JSON.stringify(convertMsg))
    this.ctx?.logger.debug('sarvam-tts', `Sent text (${text.length} chars)`)

    // 3. Send flush to signal end of input
    const flushMsg: TTSWsMessage = { type: 'flush' }
    ws.send(JSON.stringify(flushMsg))
    this.ctx?.logger.debug('sarvam-tts', 'Sent flush')

    // 4. Yield audio chunks as they arrive
    try {
      while (!wsClosed || audioQueue.length > 0) {
        if (audioQueue.length > 0) {
          const chunk = audioQueue.shift()!
          yield {
            data: chunk,
            sampleRate: opts.sampleRate,
            numChannels: opts.numChannels,
          }
        } else {
          if (wsClosed) break
          if (opts.signal.aborted) break
          await new Promise<void>((resolve) => {
            resolveAudio = resolve
          })
          resolveAudio = null
          if (wsError) throw wsError
        }
      }
    } finally {
      this.closeWebSocket(ws)
    }

    void configSent
  }

  /** REST fallback synthesis. */
  private async *synthesizeRest(
    text: string,
    opts: {
      speaker: string
      language: string
      model: string
      pace: number
      sampleRate: number
      numChannels: number
      signal: AbortSignal
    },
  ): AsyncIterable<AudioChunk> {
    const body = {
      text,
      target_language_code: opts.language,
      model: opts.model,
      speaker: opts.speaker,
      pace: opts.pace,
      speech_sample_rate: String(opts.sampleRate),
    }

    const res = await fetch(`${this.baseUrl}/text-to-speech`, {
      method: 'POST',
      headers: {
        ...authHeaders(this.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new PluginError('TTS_FAILED', `Sarvam TTS ${res.status}: ${errBody}`)
    }

    const json = (await res.json()) as { audios?: string[] }
    const b64 = json.audios?.[0]
    if (!b64) return

    const data = base64ToArrayBuffer(b64)
    const pcm = stripWavHeader(data)

    yield {
      data: pcm,
      sampleRate: opts.sampleRate,
      numChannels: opts.numChannels,
    }
  }

  /** Wait for a WebSocket to reach OPEN state. */
  private async waitForOpen(ws: TTSWebSocketLike): Promise<void> {
    if (ws.readyState === WS_OPEN) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new PluginError('TTS_FAILED', 'Sarvam TTS WebSocket connect timeout'))
      }, 10_000)

      const originalOnOpen = ws.onopen
      ws.onopen = () => {
        clearTimeout(timer)
        if (originalOnOpen) originalOnOpen()
        resolve()
      }

      const originalOnError = ws.onerror
      ws.onerror = () => {
        clearTimeout(timer)
        if (originalOnError) originalOnError()
        reject(new PluginError('TTS_FAILED', 'Sarvam TTS WebSocket failed to connect'))
      }
    })
  }

  /** Open a WebSocket connection, returning null on failure. */
  private async openWebSocket(url: string): Promise<TTSWebSocketLike | null> {
    try {
      return this.createWebSocket(url)
    } catch (err) {
      this.ctx?.logger.warn(
        'sarvam-tts',
        `WS create failed: ${(err as Error).message}`,
      )
      return null
    }
  }

  /** Create a WebSocket — overridable for testing. */
  protected createWebSocket(url: string): TTSWebSocketLike {
    const globalWs = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket
    if (globalWs) {
      return new globalWs(url) as unknown as TTSWebSocketLike
    }
    throw new PluginError(
      'TTS_FAILED',
      'No WebSocket implementation available',
    )
  }

  /** Close a WebSocket connection. */
  private closeWebSocket(ws: TTSWebSocketLike): void {
    try {
      ws.close()
    } catch (err) {
      this.ctx?.logger?.debug('sarvam-tts', `WS close error: ${(err as Error).message}`)
    }
  }
}

/** Convert base64 string to ArrayBuffer. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  if (typeof atob === 'function') {
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i)
    }
    return out.buffer
  }
  // Node.js fallback without using Buffer type directly
  const globalBuffer = (globalThis as unknown as { Buffer?: { from: (data: string, encoding: string) => { buffer: ArrayBuffer; byteOffset: number; byteLength: number } } }).Buffer
  if (globalBuffer) {
    const buf = globalBuffer.from(b64, 'base64')
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  // Last resort: manual decode
  const binary = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((binary.length * 3) / 4))
  let outIdx = 0
  for (let i = 0; i < binary.length; i += 4) {
    const c1 = b64CharToVal(binary[i]!)
    const c2 = b64CharToVal(binary[i + 1]!)
    const c3 = b64CharToVal(binary[i + 2]!)
    const c4 = b64CharToVal(binary[i + 3]!)
    out[outIdx++] = (c1 << 2) | (c2 >> 4)
    if (c3 < 64) out[outIdx++] = ((c2 & 0x0f) << 4) | (c3 >> 2)
    if (c4 < 64) out[outIdx++] = ((c3 & 0x03) << 6) | c4
  }
  return out.buffer
}

function b64CharToVal(c: string): number {
  const code = c.charCodeAt(0)
  if (code >= 65 && code <= 90) return code - 65 // A-Z
  if (code >= 97 && code <= 122) return code - 71 // a-z
  if (code >= 48 && code <= 57) return code + 4 // 0-9
  if (c === '+') return 62
  if (c === '/') return 63
  return 64 // padding
}
