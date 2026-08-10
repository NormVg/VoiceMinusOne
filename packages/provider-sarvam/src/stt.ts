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
  STTStream,
  TranscriptResult,
  PluginContext,
} from '@voiceminusone/core'
import { BoundedChannel, PluginError } from '@voiceminusone/core'
import {
  authHeaders,
  concatBuffers,
  pcm16ToWav,
  resolveApiKey,
  SARVAM_BASE_URL,
  createSarvamWebSocket,
  type SarvamWebSocket,
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

  /** Open a frame-fed Saaras WebSocket for one speech turn. */
  async openStream(config: STTConfig, signal: AbortSignal): Promise<STTStream> {
    const model = config.model ?? this.options.model ?? 'saaras:v3'
    const params = new URLSearchParams({ model, sample_rate: String(this.options.sampleRate ?? 16000), flush_signal: 'true' })
    const language = config.language ?? this.options.language
    if (language) params.set('language_code', language)
    const ws = await this.openWebSocket(`${this.baseUrl.replace('https', 'wss')}/speech-to-text/ws?${params}`, this.apiKey)
    if (!ws) throw new PluginError('STT_FAILED', 'Failed to connect to Sarvam STT WebSocket')

    const results = new BoundedChannel<TranscriptResult>({ capacity: 32 })
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      results.close()
      this.closeWebSocket(ws)
    }
    ws.onmessage = (event) => {
      try {
        const result = this.parseWsMessage(JSON.parse(String(event.data)) as Record<string, unknown>)
        if (result) {
          void results.write(result).catch((error: unknown) => {
            this.ctx?.logger.warn('sarvam-stt', `Live transcript queue rejected a result: ${(error as Error).message}`)
          })
        }
      } catch (error) {
        this.ctx?.logger.warn('sarvam-stt', `Failed to parse live WS message: ${(error as Error).message}`)
      }
    }
    ws.onerror = (error?: unknown) => {
      results.abort(new PluginError('STT_FAILED', `Sarvam STT WebSocket error: ${String(error ?? 'unknown error')}`))
      close()
    }
    ws.onclose = close
    signal.addEventListener('abort', close, { once: true })

    return {
      results,
      async write(chunk: AudioChunk): Promise<void> {
        if (closed) throw new PluginError('STT_FAILED', 'Cannot write to a closed Sarvam STT stream')
        // Sarvam requires provider-local base64; application transport remains binary.
        ws.send(JSON.stringify({ audio: { data: arrayBufferToBase64(chunk.data), sample_rate: chunk.sampleRate, encoding: 'audio/wav' } }))
      },
      async flush(): Promise<void> {
        if (!closed) ws.send(JSON.stringify({ type: 'flush' }))
      },
      async abort(): Promise<void> { close() },
      async close(): Promise<void> { close() },
    }
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
      model,
      high_vad_sensitivity: 'true',
      flush_signal: 'true',
    })
    const language = config.language ?? this.options.language
    if (language) params.set('language_code', language)

    const url = `${this.baseUrl.replace('https', 'wss')}/speech-to-text/ws?${params}`

    // Use the shared createSarvamWebSocket helper which handles both
    // Node.js (ws package with header auth) and browser (query param auth).
    // It already awaits the connection open before returning.
    this.ctx?.logger?.info('sarvam-stt', `Opening WS: ${url.replace(/api_key=[^&]+/, 'api_key=***')}`)
    const ws = await this.openWebSocket(url, this.apiKey)
    if (!ws) {
      this.ctx?.logger?.warn('sarvam-stt', 'WS open failed, falling back to REST')
      // Fallback to REST
      yield* this.transcribeRest(audio, config)
      return
    }
    this.ctx?.logger?.info('sarvam-stt', `WS opened, readyState=${ws.readyState}`)

    const abortController = new AbortController()
    this.abortController = abortController
    const signal = abortController.signal

    const messageQueue: TranscriptResult[] = []
    let resolveMessage: (() => void) | null = null
    let wsClosed = false
    let wsError: Error | null = null
    let flushSent = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    /** Reset the idle timer. After flush, if no message arrives within
     *  the timeout, we consider transcription complete and close the socket.
     *  3s safety net — Sarvam typically responds within 1-2s of flush.
     *  We close immediately on receiving a final transcript, so this only
     *  fires if Sarvam fails to respond. */
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      if (flushSent) {
        idleTimer = setTimeout(() => {
          wsClosed = true
          resolveMessage?.()
        }, 3000)
      }
    }

    ws.onmessage = (event) => {
      try {
        const raw = String(event.data)
        this.ctx?.logger?.debug('sarvam-stt', `WS message: ${raw.substring(0, 200)}`)
        const msg = JSON.parse(raw) as Record<string, unknown>
        const result = this.parseWsMessage(msg)
        if (result) {
          this.ctx?.logger?.info('sarvam-stt', `Parsed transcript: isFinal=${result.isFinal} text="${result.text.substring(0, 60)}"`)
          messageQueue.push(result)
          resolveMessage?.()
          // If we got a final transcript after flush, close immediately
          // instead of waiting for the idle timer — saves ~500ms latency
          if (result.isFinal && flushSent) {
            if (idleTimer) clearTimeout(idleTimer)
            wsClosed = true
            resolveMessage?.()
          }
        }
      } catch (err) {
        this.ctx?.logger.warn('sarvam-stt', `Failed to parse WS message: ${(err as Error).message}`)
      }
      resetIdleTimer()
    }

    ws.onerror = (err?: unknown) => {
      const errMsg = err ? String(err) : 'unknown error'
      this.ctx?.logger?.error('sarvam-stt', `WS error: ${errMsg}`)
      wsError = new PluginError('STT_FAILED', `Sarvam STT WebSocket error: ${errMsg}`)
      wsClosed = true
      if (idleTimer) clearTimeout(idleTimer)
      resolveMessage?.()
    }

    ws.onclose = (ev?: { code?: number; reason?: string }) => {
      this.ctx?.logger?.info('sarvam-stt', `WS closed: code=${ev?.code} reason=${ev?.reason ?? ''}`)
      wsClosed = true
      if (idleTimer) clearTimeout(idleTimer)
      resolveMessage?.()
    }

    // Buffer audio chunks, wrap as WAV, and send in chunks to avoid
    // exceeding WebSocket message size limits. Sarvam accepts multiple
    // audio messages before flush.
    const sendPromise = (async () => {
      const chunks: ArrayBuffer[] = []
      let sampleRate = 16000
      for await (const chunk of audio) {
        if (signal.aborted) break
        chunks.push(chunk.data)
        sampleRate = chunk.sampleRate
      }
      if (signal.aborted || chunks.length === 0) return

      // Concatenate all PCM
      const pcm = concatBuffers(chunks)
      this.ctx?.logger?.info('sarvam-stt', `Sending ${chunks.length} chunks, ${pcm.byteLength} bytes PCM, sampleRate=${sampleRate}`)

      if (ws.readyState !== 1) {
        this.ctx?.logger?.warn('sarvam-stt', `WS not open when trying to send (readyState=${ws.readyState})`)
        return
      }

      // Send in ~100KB chunks (about 3 seconds at 16kHz 16-bit)
      const MAX_CHUNK_BYTES = 100000
      const sentCount = Math.ceil(pcm.byteLength / MAX_CHUNK_BYTES)
      for (let i = 0; i < sentCount; i++) {
        if (ws.readyState !== 1) return
        const offset = i * MAX_CHUNK_BYTES
        const end = Math.min(offset + MAX_CHUNK_BYTES, pcm.byteLength)
        const chunkPcm = pcm.slice(offset, end)
        const wav = pcm16ToWav(chunkPcm, sampleRate)
        const b64 = arrayBufferToBase64(wav)
        ws.send(JSON.stringify({
          audio: {
            data: b64,
            sample_rate: sampleRate,
            encoding: 'audio/wav',
          },
        }))
      }
      this.ctx?.logger?.info('sarvam-stt', `Sent audio in ${sentCount} chunks + flush`)

      // Send flush signal to finalize transcription
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'flush' }))
        flushSent = true
        resetIdleTimer()
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
      if (idleTimer) clearTimeout(idleTimer)
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

  /** Parse a WebSocket message into a TranscriptResult.
   *
   *  Sarvam STT WebSocket response format (per API docs):
   *  - { type: "data", data: { transcript: "...", language_code: "..." } }
   *  - { type: "events", data: { signal_type: "START_SPEECH" | "END_SPEECH" } }
   *  Also handles flat format as fallback.
   */
  private parseWsMessage(msg: Record<string, unknown>): TranscriptResult | null {
    const type = msg.type ?? msg.event

    // VAD events — not transcripts
    if (type === 'events' || type === 'event') {
      const data = msg.data as Record<string, unknown> | undefined
      const signalType = data?.signal_type ?? data?.signalType
      if (signalType === 'START_SPEECH' || signalType === 'END_SPEECH') return null
    }
    if (type === 'START_SPEECH' || type === 'speech_start') return null
    if (type === 'END_SPEECH' || type === 'speech_end') return null

    // Nested format: { type: "data", data: { transcript, language_code } }
    const nestedData = msg.data as Record<string, unknown> | undefined
    const text =
      (typeof nestedData?.transcript === 'string' && nestedData.transcript) ||
      (typeof nestedData?.text === 'string' && nestedData.text) ||
      (typeof msg.transcript === 'string' && msg.transcript) ||
      (typeof msg.text === 'string' && msg.text) ||
      ''
    if (!text) return null

    const isFinal =
      msg.is_final === true ||
      msg.isFinal === true ||
      type === 'data' ||
      type === 'transcript' ||
      msg.status === 'final'

    const lang =
      (typeof nestedData?.language_code === 'string' && nestedData.language_code) ||
      (typeof nestedData?.language === 'string' && nestedData.language) ||
      (typeof msg.language_code === 'string' && msg.language_code) ||
      (typeof msg.language === 'string' && msg.language) ||
      this.options.language ||
      'unknown'

    return {
      text,
      isFinal: Boolean(isFinal),
      language: String(lang),
    }
  }

  /** Open a WebSocket connection, returning null on failure.
   *  Uses the shared createSarvamWebSocket helper which handles both
   *  Node.js (ws package with header auth) and browser (query param auth).
   *
   *  createSarvamWebSocket already awaits the connection open before
   *  returning, so we must NOT re-wait on onopen here — doing so would
   *  hang until the 10-second timeout because the open event has already
   *  fired by the time we set the handler.
   */
  private async openWebSocket(url: string, apiKey: string): Promise<SarvamWebSocket | null> {
    try {
      return await createSarvamWebSocket(url, apiKey)
    } catch (err) {
      this.ctx?.logger.warn('sarvam-stt', `WS connect failed: ${(err as Error).message}`)
      return null
    }
  }

  /** Close a WebSocket connection. */
  private closeWebSocket(ws: SarvamWebSocket): void {
    try {
      ws.close()
    } catch (err) {
      this.ctx?.logger?.debug('sarvam-stt', `WS close error: ${(err as Error).message}`)
    }
  }
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
