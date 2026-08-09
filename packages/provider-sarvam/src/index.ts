/**
 * @voiceminusone/provider-sarvam
 *
 * Sarvam AI provider for VoiceMinusOne — STT (Saaras v3) + TTS (Bulbul v3).
 *
 * @example
 * ```typescript
 * import { sarvam } from '@voiceminusone/provider-sarvam'
 *
 * const stt = sarvam.stt({ apiKey: process.env.SARVAM_API_KEY, language: 'en-IN' })
 * const tts = sarvam.tts({ apiKey: process.env.SARVAM_API_KEY, speaker: 'shubh' })
 * ```
 */

import type { STTProvider, TTSProvider } from '@voiceminusone/core'
import { SarvamSTT, type SarvamSTTOptions } from './stt'
import { SarvamTTS, type SarvamTTSOptions } from './tts'

export { SarvamSTT } from './stt'
export type { SarvamSTTOptions } from './stt'
export { SarvamTTS } from './tts'
export type { SarvamTTSOptions } from './tts'
export type { SarvamCredentials } from './shared'
export {
  SARVAM_BASE_URL,
  resolveApiKey,
  authHeaders,
  concatBuffers,
  pcm16ToWav,
  stripWavHeader,
} from './shared'

export interface SarvamFactory {
  stt(options?: SarvamSTTOptions): STTProvider
  tts(options?: SarvamTTSOptions): TTSProvider
}

/**
 * Factory for creating Sarvam providers.
 *
 * @example
 * ```typescript
 * import { sarvam } from '@voiceminusone/provider-sarvam'
 *
 * const stt = sarvam.stt({ apiKey: process.env.SARVAM_API_KEY })
 * const tts = sarvam.tts({ apiKey: process.env.SARVAM_API_KEY, speaker: 'shubh' })
 * ```
 */
export const sarvam: SarvamFactory = {
  stt(options = {}) {
    return new SarvamSTT(options)
  },
  tts(options = {}) {
    return new SarvamTTS(options)
  },
}
