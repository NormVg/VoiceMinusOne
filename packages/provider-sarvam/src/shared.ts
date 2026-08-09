/**
 * Shared Sarvam credentials and helpers.
 */

import { PluginError } from '@voiceminusone/core'

export const SARVAM_BASE_URL = 'https://api.sarvam.ai'

export interface SarvamCredentials {
  /** API subscription key. Falls back to `SARVAM_API_KEY` env. */
  apiKey?: string
  baseUrl?: string
}

/** Browser-compatible WebSocket interface (works with both ws package and native). */
export interface SarvamWebSocket {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((error?: unknown) => void) | null
  onclose: (() => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}

/** WebSocket readyState.OPEN constant. */
const WS_OPEN = 1

/**
 * Create a Sarvam WebSocket connection.
 *
 * In Node.js, uses the 'ws' package with header-based auth (Api-Subscription-Key).
 * In browser, uses global WebSocket with query param auth.
 *
 * The returned object has a browser-compatible API (onopen, onmessage, etc.)
 * regardless of which underlying implementation is used.
 *
 * This function waits for the connection to open before returning, so
 * callers can immediately start sending data.
 */
export async function createSarvamWebSocket(url: string, apiKey: string): Promise<SarvamWebSocket> {
  // Try Node.js 'ws' package first (supports custom headers)
  try {
    const wsModule = await import('ws')
    const WsClass = (wsModule as unknown as { default?: unknown }).default
      ?? (wsModule as unknown as { WebSocket?: unknown }).WebSocket
      ?? wsModule
    if (typeof WsClass === 'function') {
      const rawWs = new (WsClass as new (url: string, opts: { headers: Record<string, string> }) => {
        on: (event: string, listener: (...args: unknown[]) => void) => void
        send: (data: string | ArrayBuffer) => void
        close: () => void
        readonly readyState: number
      })(url, {
        headers: { 'Api-Subscription-Key': apiKey },
      })

      // Buffer for messages that arrive before the caller sets onmessage.
      // This prevents data loss between the open event and handler assignment.
      const messageBuffer: Array<{ data: unknown }> = []
      let _onopen: (() => void) | null = null
      let _onmessage: ((event: { data: unknown }) => void) | null = null
      let _onerror: ((error?: unknown) => void) | null = null
      let _onclose: (() => void) | null = null

      const wrapper: SarvamWebSocket = {
        get readyState() { return rawWs.readyState },
        get onopen() { return _onopen },
        set onopen(fn: (() => void) | null) { _onopen = fn },
        get onmessage() { return _onmessage },
        set onmessage(fn: ((event: { data: unknown }) => void) | null) {
          _onmessage = fn
          // Flush any buffered messages
          while (messageBuffer.length > 0 && _onmessage) {
            _onmessage(messageBuffer.shift()!)
          }
        },
        get onerror() { return _onerror },
        set onerror(fn: ((error?: unknown) => void) | null) { _onerror = fn },
        get onclose() { return _onclose },
        set onclose(fn: (() => void) | null) { _onclose = fn },
        send: (data: string | ArrayBuffer) => rawWs.send(data),
        close: () => rawWs.close(),
      }

      // Wire up raw events to the wrapper's callback slots
      rawWs.on('open', () => {
        _onopen?.()
      })
      rawWs.on('message', (data: unknown) => {
        if (_onmessage) {
          _onmessage({ data })
        } else {
          // Buffer until onmessage is set
          messageBuffer.push({ data })
        }
      })
      rawWs.on('error', (err: unknown) => {
        _onerror?.(err)
      })
      rawWs.on('close', () => {
        _onclose?.()
      })

      // Wait for the connection to open before returning.
      // This ensures the caller can immediately start sending data.
      if (rawWs.readyState !== WS_OPEN) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new PluginError('TRANSPORT_CONNECTION_FAILED', 'WS connect timeout')), 10_000)
          rawWs.on('open', () => {
            clearTimeout(timer)
            resolve()
          })
          rawWs.on('error', (err: unknown) => {
            clearTimeout(timer)
            reject(new PluginError('TRANSPORT_CONNECTION_FAILED', `WS connection failed: ${String(err)}`))
          })
        })
      }

      return wrapper
    }
  } catch {
    // 'ws' package not available — fall through to browser WebSocket
  }

  // Browser: use global WebSocket with query param auth
  const globalWs = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket
  if (globalWs) {
    const urlWithAuth = url.includes('api-subscription-key')
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}api-subscription-key=${encodeURIComponent(apiKey)}`
    return new globalWs(urlWithAuth) as unknown as SarvamWebSocket
  }

  throw new PluginError('TRANSPORT_CONNECTION_FAILED', 'No WebSocket implementation available')
}

/** Resolve the API key from explicit value or environment. */
export function resolveApiKey(explicit?: string): string {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
  const key = explicit ?? env?.env?.SARVAM_API_KEY
  if (!key) {
    throw new PluginError('PLUGIN_INIT_FAILED', 'Sarvam API key missing. Pass apiKey or set SARVAM_API_KEY.')
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
