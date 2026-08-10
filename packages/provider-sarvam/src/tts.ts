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
  TTSStream,
  PluginContext,
} from '@voiceminusone/core'
import { BoundedChannel, PluginError } from '@voiceminusone/core'
import {
  authHeaders,
  resolveApiKey,
  stripWavHeader,
  SARVAM_BASE_URL,
  createSarvamWebSocket,
  type SarvamWebSocket,
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

/** Message types for the Sarvam TTS WebSocket protocol.
 *
 *  Per the Sarvam SDK source:
 *  - config: { type: "config", data: { language_code, speaker, pitch, pace, loudness,
 *           speech_sample_rate, enable_preprocessing, output_audio_codec,
 *           output_audio_bitrate, dict_id, min_buffer_size, max_chunk_length } }
 *  - text:   { type: "text", data: { text } }  (NOT "convert"!)
 *  - flush:  { type: "flush" }
 *  - ping:   { type: "ping" }
 */
type TTSWsMessage =
  | { type: 'config'; data: Record<string, unknown> }
  | { type: 'text'; data: { text: string } }
  | { type: 'flush' }
  | { type: 'ping' }

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
   * Open one WebSocket for a turn and feed it incrementally. This is the V2
   * path used by the session runtime; `synthesize` remains the compatibility
   * adapter for batch providers and existing applications.
   */
  async openStream(config: TTSConfig, signal: AbortSignal): Promise<TTSStream> {
    const sampleRate = this.options.sampleRate ?? 22050
    const speaker = config.speaker ?? this.options.speaker ?? 'shubh'
    const language = config.language ?? this.options.language ?? 'en-IN'
    const model = config.model ?? this.options.model ?? 'bulbul:v3'
    const pace = config.pace ?? this.options.pace ?? 1
    const url = `${this.baseUrl.replace('https', 'wss')}/text-to-speech/ws?${new URLSearchParams({ model })}`
    const ws = await this.openWebSocket(url, this.apiKey)
    if (!ws) throw new PluginError('TTS_FAILED', 'Failed to connect to Sarvam TTS WebSocket')

    const audio = new BoundedChannel<AudioChunk>({ capacity: 64 })
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      audio.close()
      this.closeWebSocket(ws)
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        if (message.type === 'complete' || message.type === 'finished') {
          close()
          return
        }
        if (message.type !== 'audio') return
        const data = message.data as Record<string, unknown> | undefined
        if (typeof data?.audio !== 'string') return
        const pcm = stripWavHeader(base64ToArrayBuffer(data.audio))
        if (pcm.byteLength > 0) {
          void audio.write({ data: pcm, sampleRate, numChannels: 1 }).catch((error: unknown) => {
            this.ctx?.logger.warn('sarvam-tts', `Live audio queue rejected a chunk: ${(error as Error).message}`)
          })
        }
      } catch (error) {
        this.ctx?.logger.warn('sarvam-tts', `Failed to parse live WS message: ${(error as Error).message}`)
      }
    }
    ws.onerror = (error?: unknown) => {
      audio.abort(new PluginError('TTS_FAILED', `Sarvam TTS WebSocket error: ${String(error ?? 'unknown error')}`))
      close()
    }
    ws.onclose = close
    signal.addEventListener('abort', close, { once: true })

    ws.send(JSON.stringify({
      type: 'config',
      data: {
        language_code: language,
        speaker,
        pitch: 0,
        pace,
        loudness: 1,
        speech_sample_rate: sampleRate,
        enable_preprocessing: false,
        output_audio_codec: 'wav',
        output_audio_bitrate: '128k',
        min_buffer_size: 50,
        max_chunk_length: 150,
      },
    } satisfies TTSWsMessage))

    return {
      audio,
      async write(text: string): Promise<void> {
        if (closed) throw new PluginError('TTS_FAILED', 'Cannot write to a closed Sarvam TTS stream')
        const phrase = text.trim()
        if (phrase) ws.send(JSON.stringify({ type: 'text', data: { text: phrase } } satisfies TTSWsMessage))
      },
      async flush(): Promise<void> {
        if (!closed) ws.send(JSON.stringify({ type: 'flush' } satisfies TTSWsMessage))
      },
      async abort(): Promise<void> { close() },
      async close(): Promise<void> { close() },
    }
  }

  /**
   * Synthesize text to audio.
   *
   * Uses REST by default — it's faster per-sentence than WebSocket
   * because there's no connection overhead. The WebSocket path opens
   * a new connection per call, adding ~1s latency per sentence.
   *
   * Set `streaming: true` in options to use WebSocket streaming instead
   * (better for long text on a persistent connection).
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

    const sampleRate = this.options.sampleRate ?? 22050
    const numChannels = 1
    const speaker = config.speaker ?? this.options.speaker ?? 'shubh'
    const language = config.language ?? this.options.language ?? 'en-IN'
    const model = config.model ?? this.options.model ?? 'bulbul:v3'
    const pace = config.pace ?? this.options.pace ?? 1.0

    try {
      // REST is faster for sentence-level synthesis (no WS connection overhead)
      yield* this.synthesizeRest(trimmed, {
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
        `REST synthesis failed: ${(err as Error).message}. Trying WebSocket.`,
      )
      yield* this.synthesizeWs(trimmed, {
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
      model: opts.model,
    })

    const wsUrl = `${this.baseUrl.replace('https', 'wss')}/text-to-speech/ws?${params}`

    const ws = await this.openWebSocket(wsUrl, this.apiKey)
    if (!ws) {
      throw new PluginError('TTS_FAILED', 'Failed to connect to Sarvam TTS WebSocket')
    }

    const audioQueue: ArrayBuffer[] = []
    let resolveAudio: (() => void) | null = null
    let wsClosed = false
    let wsError: Error | null = null
    let configSent = false
    let flushSent = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    /** Reset the idle timer. After flush, if no message arrives within
     *  the timeout, we consider synthesis complete and close the socket. */
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      if (flushSent) {
        idleTimer = setTimeout(() => {
          wsClosed = true
          resolveAudio?.()
        }, 5000)
      }
    }

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
            // Skip empty chunks (e.g. WAV header-only chunks that strip to 0 bytes)
            if (pcm.byteLength > 0) {
              audioQueue.push(pcm)
              resolveAudio?.()
            }
          }
        } else if (msgType === 'complete' || msgType === 'finished' || msgType === 'event') {
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
      resetIdleTimer()
    }

    ws.onerror = (err?: unknown) => {
      const errMsg = err ? String(err) : 'unknown error'
      wsError = new PluginError('TTS_FAILED', `Sarvam TTS WebSocket error: ${errMsg}`)
      wsClosed = true
      if (idleTimer) clearTimeout(idleTimer)
      resolveAudio?.()
    }

    ws.onclose = () => {
      wsClosed = true
      if (idleTimer) clearTimeout(idleTimer)
      resolveAudio?.()
    }

    // Wait for connection to open
    await this.waitForOpen(ws)

    // 1. Send config message (full format per Sarvam SDK)
    const configMsg: TTSWsMessage = {
      type: 'config',
      data: {
        language_code: opts.language,
        speaker: opts.speaker,
        pitch: 0.0,
        pace: opts.pace,
        loudness: 1.0,
        speech_sample_rate: opts.sampleRate,
        enable_preprocessing: false,
        output_audio_codec: 'wav',
        output_audio_bitrate: '128k',
        min_buffer_size: 50,
        max_chunk_length: 150,
      },
    }
    ws.send(JSON.stringify(configMsg))
    configSent = true
    this.ctx?.logger.debug('sarvam-tts', 'Sent config message')

    // 2. Send text message (type is "text", NOT "convert")
    const convertMsg: TTSWsMessage = {
      type: 'text',
      data: { text },
    }
    ws.send(JSON.stringify(convertMsg))
    this.ctx?.logger.debug('sarvam-tts', `Sent text (${text.length} chars)`)

    // 3. Send flush to signal end of input
    const flushMsg: TTSWsMessage = { type: 'flush' }
    ws.send(JSON.stringify(flushMsg))
    flushSent = true
    resetIdleTimer()
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
      if (idleTimer) clearTimeout(idleTimer)
      this.closeWebSocket(ws)
    }

    void configSent
  }

  /** REST synthesis — uses the streaming HTTP endpoint for lower latency.
   *
   *  The /text-to-speech/stream endpoint returns raw binary audio as a
   *  stream (no base64, no JSON parsing). Audio starts arriving as soon
   *  as the first chunk is synthesized.
   */
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
      output_audio_codec: 'wav',
    }

    const res = await fetch(`${this.baseUrl}/text-to-speech/stream`, {
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

    // Stream the binary audio response
    if (!res.body) {
      // Fallback: read full response as arraybuffer
      const buf = await res.arrayBuffer()
      const pcm = stripWavHeader(buf)
      if (pcm.byteLength > 0) {
        yield { data: pcm, sampleRate: opts.sampleRate, numChannels: opts.numChannels }
      }
      return
    }

    // Read the stream in chunks
    const reader = res.body.getReader()
    const chunks: ArrayBuffer[] = []
    let totalBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (opts.signal.aborted) break

        chunks.push(value.buffer)
        totalBytes += value.byteLength
      }
    } finally {
      reader.releaseLock()
    }

    if (totalBytes === 0) return

    // Concatenate all chunks
    const combined = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }

    // Strip WAV header if present
    const pcm = stripWavHeader(combined.buffer)
    if (pcm.byteLength > 0) {
      yield { data: pcm, sampleRate: opts.sampleRate, numChannels: opts.numChannels }
    }
  }

  /** Wait for a WebSocket to reach OPEN state.
   *
   *  createSarvamWebSocket already awaits the connection open before
   *  returning, so by the time we get the wrapper the connection is
   *  already open (readyState === 1). We just verify and return.
   *  Setting onopen here would race — the event has already fired.
   */
  private async waitForOpen(ws: SarvamWebSocket): Promise<void> {
    if (ws.readyState === WS_OPEN) return
    // Connection not yet open — this shouldn't happen since
    // createSarvamWebSocket awaits open, but handle gracefully
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

  /** Open a WebSocket connection, returning null on failure.
   *  Uses the shared createSarvamWebSocket helper.
   */
  private async openWebSocket(url: string, apiKey: string): Promise<SarvamWebSocket | null> {
    try {
      return await createSarvamWebSocket(url, apiKey)
    } catch (err) {
      this.ctx?.logger.warn(
        'sarvam-tts',
        `WS create failed: ${(err as Error).message}`,
      )
      return null
    }
  }

  /** Close a WebSocket connection. */
  private closeWebSocket(ws: SarvamWebSocket): void {
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
