/**
 * @voiceminusone/client
 *
 * Browser client for VoiceMinusOne — mic, speaker, VAD, VoiceMinusOneClient.
 *
 * - Mic: AudioWorklet-based capture, VAD-gated streaming, 16kHz mono PCM
 * - Speaker: Prebuffered gapless playback via Web Audio API
 * - VAD: Energy-based three-phase state machine (Silero plugin available separately)
 * - VoiceMinusOneClient: WebSocket client with reconnection
 */

export { Mic } from './audio/mic'
export { DEFAULT_MIC_CONFIG } from './audio/mic'
export type { MicConfig, MicState, AudioChunkListener, MicStateListener } from './audio/mic'

export { Speaker } from './audio/speaker'
export { DEFAULT_SPEAKER_CONFIG } from './audio/speaker'
export type { SpeakerConfig, SpeakerState, SpeakerStateListener } from './audio/speaker'

export { EnergyVAD, VADStatus, DEFAULT_VAD_CONFIG } from './vad/energy-vad'
export type { VADConfig, VADEvent, VADEventType, VADEventListener } from './vad/energy-vad'

export { VoiceMinusOneClient, DEFAULT_CLIENT_CONFIG } from './client/voice-client'
export type { ClientConfig, ClientState, ClientStateListener, TranscriptListener, BotTextListener, BotTextDoneListener, TurnStats, TurnStatsListener } from './client/voice-client'
