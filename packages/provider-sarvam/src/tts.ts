/**
 * Sarvam Bulbul TTS provider.
 *
 * Implements the VoiceMinusOne TTSProvider interface.
 * Uses HTTP streaming when available, REST fallback.
 */

import type {
  AudioChunk,
  TTSConfig,
  TTSProvider,
  PluginContext,
} from '@voiceminusone/core'
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

/**
 * Sarvam Bulbul TTS — streams audio via HTTP, falls back to REST.
 *
 * Implements the TTSProvider interface with `synthesize()` returning an
 * AsyncIterable<AudioChunk>.
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
   * Synthesize text to audio. Streams via HTTP when available.
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

    const body = {
      text: trimmed,
      target_language_code: config.language ?? this.options.language ?? 'en-IN',
      model: config.model ?? this.options.model ?? 'bulbul:v3',
      speaker: config.speaker ?? this.options.speaker ?? 'shubh',
      pace: config.pace ?? this.options.pace ?? 1.0,
      speech_sample_rate: String(sampleRate),
    }

    try {
      // Prefer HTTP stream endpoint
      const streamRes = await fetch(`${this.baseUrl}/text-to-speech/stream`, {
        method: 'POST',
        headers: {
          ...authHeaders(this.apiKey),
          'Content-Type': 'application/json',
          Accept: 'audio/wav, application/octet-stream',
        },
        body: JSON.stringify(body),
        signal,
      })

      if (streamRes.ok && streamRes.body) {
        yield* this.readStream(streamRes.body, sampleRate, numChannels)
        return
      }

      // REST fallback
      const res = await fetch(`${this.baseUrl}/text-to-speech`, {
        method: 'POST',
        headers: {
          ...authHeaders(this.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!res.ok) {
        const errBody = await res.text()
        throw new Error(`Sarvam TTS ${res.status}: ${errBody}`)
      }

      const json = (await res.json()) as { audios?: string[] }
      const b64 = json.audios?.[0]
      if (!b64) return

      const data = base64ToArrayBuffer(b64)
      const pcm = stripWavHeader(data)

      yield {
        data: pcm,
        sampleRate,
        numChannels,
      }
    } catch (err) {
      if (signal.aborted) return
      throw err
    } finally {
      this.activeControllers.delete(controller)
    }
  }

  /** Read an HTTP stream, stripping WAV header, yielding PCM chunks. */
  private async *readStream(
    body: ReadableStream<Uint8Array>,
    sampleRate: number,
    numChannels: number,
  ): AsyncIterable<AudioChunk> {
    const reader = body.getReader()
    let pending = new Uint8Array(0)
    let headerHandled = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue

        let currentChunk = value

        // On first data: detect and skip WAV header if present
        if (!headerHandled) {
          headerHandled = true
          if (
            currentChunk.length >= 4 &&
            currentChunk[0] === 0x52 && // R
            currentChunk[1] === 0x49 && // I
            currentChunk[2] === 0x46 && // F
            currentChunk[3] === 0x46 // F
          ) {
            const headerSize = 44
            if (currentChunk.length <= headerSize) continue
            currentChunk = currentChunk.subarray(headerSize)
          }
        }

        const totalLength = pending.length + currentChunk.length
        const validBytes = totalLength - (totalLength % 2)

        if (validBytes === 0) {
          const newPending = new Uint8Array(totalLength)
          newPending.set(pending)
          newPending.set(currentChunk, pending.length)
          pending = newPending
          continue
        }

        const toYield = new Uint8Array(validBytes)
        const nextPending = new Uint8Array(totalLength - validBytes)

        if (pending.length > 0) {
          toYield.set(pending)
          toYield.set(currentChunk.subarray(0, validBytes - pending.length), pending.length)
          nextPending.set(currentChunk.subarray(validBytes - pending.length))
        } else {
          toYield.set(currentChunk.subarray(0, validBytes))
          nextPending.set(currentChunk.subarray(validBytes))
        }

        pending = nextPending
        yield {
          data: toYield.buffer,
          sampleRate,
          numChannels,
        }
      }
    } finally {
      reader.releaseLock()
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
  const out = new Uint8Array(Math.floor(binary.length * 3 / 4))
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
