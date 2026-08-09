/**
 * Sarvam Saaras STT provider.
 *
 * Implements the VoiceMinusOne STTProvider interface.
 * Uses WebSocket streaming when available, falls back to REST.
 */

import type {
  AudioChunk,
  STTConfig,
  STTProvider,
  TranscriptResult,
  PluginContext,
} from '@voiceminusone/core'
import { PluginError } from '@voiceminusone/core'
import {
  authHeaders,
  concatBuffers,
  pcm16ToWav,
  resolveApiKey,
  SARVAM_BASE_URL,
  type SarvamCredentials,
} from './shared'

export interface SarvamSTTOptions extends SarvamCredentials {
  language?: string
  model?: string
  mode?: 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix'
  /** Prefer WebSocket streaming when available (default true). */
  streaming?: boolean
  sampleRate?: number
}

/**
 * Sarvam Saaras STT — streams audio via WebSocket, falls back to REST.
 *
 * Implements the STTProvider interface with `transcribe()` returning an
 * AsyncIterable<TranscriptResult>.
 */
export class SarvamSTT implements STTProvider {
  readonly name = 'sarvam-stt'
  private readonly options: SarvamSTTOptions
  private readonly apiKey: string
  private readonly baseUrl: string
  private ctx?: PluginContext
  private abortController?: AbortController

  constructor(options: SarvamSTTOptions = {}) {
    this.options = options
    this.apiKey = resolveApiKey(options.apiKey)
    this.baseUrl = options.baseUrl ?? SARVAM_BASE_URL
  }

  async init(context: PluginContext): Promise<void> {
    this.ctx = context
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.abort()
  }

  async destroy(): Promise<void> {
    this.abort()
  }

  abort(): void {
    this.abortController?.abort()
  }

  /**
   * Transcribe an audio stream. Buffers chunks, sends to Sarvam.
   * Tries WebSocket streaming first, falls back to REST.
   */
  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    const useStreaming = this.options.streaming !== false
    if (useStreaming) {
      yield* this.transcribeWs(audio, config)
    } else {
      yield* this.transcribeRest(audio, config)
    }
  }

  /** WebSocket streaming transcription. */
  private async *transcribeWs(
    audio: AsyncIterable<AudioChunk>,
    config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    const model = config.model ?? this.options.model ?? 'saaras:v3'
    const params = new URLSearchParams({
      'api-subscription-key': this.apiKey,
      model,
      'high-vad-sensitivity': 'true',
      'flush-signal': 'true',
    })
    const language = config.language ?? this.options.language
    if (language) params.set('language-code', language)

    const url = `${this.baseUrl.replace('https', 'wss')}/speech-to-text/ws?${params}`

    // Use the global WebSocket (browser) or ws package (Node)
    const ws = await this.openWebSocket(url)
    if (!ws) {
      // Fallback to REST
      yield* this.transcribeRest(audio, config)
      return
    }

    const abortController = new AbortController()
    this.abortController = abortController
    const signal = abortController.signal

    const messageQueue: TranscriptResult[] = []
    let resolveMessage: (() => void) | null = null
    let wsClosed = false
    let wsError: Error | null = null

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>
        const result = this.parseWsMessage(msg)
        if (result) {
          messageQueue.push(result)
          resolveMessage?.()
        }
      } catch (err) {
        this.ctx?.logger.warn('sarvam-stt', `Failed to parse WS message: ${(err as Error).message}`)
      }
    }

    ws.onerror = () => {
      wsError = new Error('Sarvam STT WebSocket error')
      wsClosed = true
      resolveMessage?.()
    }

    ws.onclose = () => {
      wsClosed = true
      resolveMessage?.()
    }

    // Send audio chunks
    const sendPromise = (async () => {
      for await (const chunk of audio) {
        if (signal.aborted) break
        if (ws.readyState !== this.OPEN_STATE) break
        this.sendWsChunk(ws, chunk)
      }
      // Send flush signal
      if (ws.readyState === this.OPEN_STATE) {
        ws.send(JSON.stringify({ type: 'flush' }))
      }
    })()

    // Yield transcripts as they arrive
    try {
      while (!wsClosed || messageQueue.length > 0) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!
        } else {
          if (wsClosed) break
          await new Promise<void>((resolve) => {
            resolveMessage = resolve
          })
          resolveMessage = null
          if (wsError) throw wsError
        }
      }
    } finally {
      abortController.abort()
      this.closeWebSocket(ws)
      await sendPromise.catch(() => {})
    }
  }

  /** REST transcription fallback. */
  private async *transcribeRest(
    audio: AsyncIterable<AudioChunk>,
    config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    const abortController = new AbortController()
    this.abortController = abortController
    const signal = abortController.signal

    const chunks: ArrayBuffer[] = []
    let sampleRate = 16000

    for await (const chunk of audio) {
      if (signal.aborted) return
      chunks.push(chunk.data)
      sampleRate = chunk.sampleRate
    }

    if (chunks.length === 0) return

    const pcm = concatBuffers(chunks)
    const wav = pcm16ToWav(pcm, sampleRate)

    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
      'audio.wav',
    )
    form.append('model', config.model ?? this.options.model ?? 'saaras:v3')
    form.append('mode', this.options.mode ?? 'transcribe')
    const language = config.language ?? this.options.language
    if (language) form.append('language_code', language)

    const res = await fetch(`${this.baseUrl}/speech-to-text`, {
      method: 'POST',
      headers: authHeaders(this.apiKey),
      body: form,
      signal,
    })

    if (!res.ok) {
      const body = await res.text()
      throw new PluginError('STT_FAILED', `Sarvam STT ${res.status}: ${body}`)
    }

    const json = (await res.json()) as {
      transcript?: string
      language_code?: string
    }

    const text = json.transcript ?? ''
    if (text) {
      yield {
        text,
        isFinal: true,
        language: json.language_code ?? language ?? 'unknown',
      }
    }
  }

  /** Parse a WebSocket message into a TranscriptResult. */
  private parseWsMessage(msg: Record<string, unknown>): TranscriptResult | null {
    const type = msg.type ?? msg.event
    if (type === 'START_SPEECH' || type === 'speech_start') return null
    if (type === 'END_SPEECH' || type === 'speech_end') return null

    const text =
      (typeof msg.transcript === 'string' && msg.transcript) ||
      (typeof msg.text === 'string' && msg.text) ||
      ''
    if (!text) return null

    const isFinal =
      msg.is_final === true ||
      msg.isFinal === true ||
      type === 'transcript' ||
      msg.status === 'final'

    return {
      text,
      isFinal: Boolean(isFinal),
      language: String(
        msg.language_code ?? msg.language ?? this.options.language ?? 'unknown',
      ),
    }
  }

  /** Send an audio chunk over WebSocket. */
  private sendWsChunk(ws: WebSocketLike, chunk: AudioChunk): void {
    const b64 = arrayBufferToBase64(chunk.data)
    ws.send(
      JSON.stringify({
        audio: b64,
        encoding: 'pcm_s16le',
        sample_rate: chunk.sampleRate,
      }),
    )
  }

  /** Open a WebSocket connection, returning null on failure. */
  private async openWebSocket(url: string): Promise<WebSocketLike | null> {
    try {
      const ws = this.createWebSocket(url)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10_000)
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('Sarvam STT WebSocket failed to connect'))
        }
      })
      return ws
    } catch (err) {
      this.ctx?.logger.warn('sarvam-stt', `WS connect failed: ${(err as Error).message}`)
      return null
    }
  }

  /** Create a WebSocket — overridable for testing. */
  protected createWebSocket(url: string): WebSocketLike {
    // In Node, use the 'ws' package; in browser, use global WebSocket
    const globalWs = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket
    if (globalWs) return new globalWs(url) as unknown as WebSocketLike
    throw new PluginError('TRANSPORT_CONNECTION_FAILED', 'No WebSocket implementation available')
  }

  /** Close a WebSocket connection. */
  private closeWebSocket(ws: WebSocketLike): void {
    try {
      ws.close()
    } catch (err) {
      this.ctx?.logger?.debug('sarvam-stt', `WS close error: ${(err as Error).message}`)
    }
  }

  /** ReadyState.OPEN constant — overridable for ws package vs browser. */
  protected get OPEN_STATE(): number {
    return 1
  }
}

/** Minimal WebSocket interface (works with both browser and ws package). */
export interface WebSocketLike {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}

/** Convert ArrayBuffer to base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (typeof btoa === 'function') {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }
  // Node.js fallback without using Buffer type directly
  const globalBuffer = (globalThis as unknown as { Buffer?: { from: (data: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer
  if (globalBuffer) {
    return globalBuffer.from(bytes).toString('base64')
  }
  // Last resort: manual encode
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i] ?? 0
    const b2 = bytes[i + 1] ?? 0
    const b3 = bytes[i + 2] ?? 0
    result += b64ValToChar(b1 >> 2)
    result += b64ValToChar(((b1 & 0x03) << 4) | (b2 >> 4))
    result += i + 1 < bytes.length ? b64ValToChar(((b2 & 0x0f) << 2) | (b3 >> 6)) : '='
    result += i + 2 < bytes.length ? b64ValToChar(b3 & 0x3f) : '='
  }
  return result
}

function b64ValToChar(val: number): string {
  if (val < 26) return String.fromCharCode(65 + val)
  if (val < 52) return String.fromCharCode(97 + val - 26)
  if (val < 62) return String.fromCharCode(48 + val - 52)
  if (val === 62) return '+'
  return '/'
}
