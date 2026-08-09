/**
 * Shared Sarvam credentials and helpers.
 */

export const SARVAM_BASE_URL = 'https://api.sarvam.ai'

export interface SarvamCredentials {
  /** API subscription key. Falls back to `SARVAM_API_KEY` env. */
  apiKey?: string
  baseUrl?: string
}

/** Resolve the API key from explicit value or environment. */
export function resolveApiKey(explicit?: string): string {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
  const key = explicit ?? env?.env?.SARVAM_API_KEY
  if (!key) {
    throw new Error('Sarvam API key missing. Pass apiKey or set SARVAM_API_KEY.')
  }
  return key
}

/** Auth headers for Sarvam REST endpoints. */
export function authHeaders(apiKey: string): Record<string, string> {
  return { 'api-subscription-key': apiKey }
}

/** Concatenate multiple ArrayBuffers into one. */
export function concatBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const buf of buffers) {
    out.set(new Uint8Array(buf), offset)
    offset += buf.byteLength
  }
  return out.buffer
}

/** Convert a PCM ArrayBuffer into a WAV ArrayBuffer (16-bit, mono). */
export function pcm16ToWav(pcm: ArrayBuffer, sampleRate: number): ArrayBuffer {
  const dataLength = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, dataLength, true)

  const pcmBytes = new Uint8Array(pcm)
  const outBytes = new Uint8Array(buffer, 44)
  outBytes.set(pcmBytes)

  return buffer
}

/** Strip a WAV header (44 bytes) if present, returning raw PCM. */
export function stripWavHeader(data: ArrayBuffer): ArrayBuffer {
  const view = new Uint8Array(data)
  if (
    view.length >= 44 &&
    view[0] === 0x52 && // R
    view[1] === 0x49 && // I
    view[2] === 0x46 && // F
    view[3] === 0x46 // F
  ) {
    return data.slice(44)
  }
  return data
}
