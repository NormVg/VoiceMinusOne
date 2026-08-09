/**
 * Plugin interfaces — the contracts for every segment of the voice pipeline.
 *
 * Every capability (STT, TTS, LLM, transport, VAD, audio processing) is a
 * swappable plugin with a TypeScript interface. Providers implement the
 * interface and export a factory function.
 *
 * Per R-002: Interfaces are defined BEFORE any implementation.
 */

import type { Logger } from '../utils/logger'
import type { EventBus } from '../utils/event-bus'
import type { Clock } from '../utils/clock'

// --- Plugin context and lifecycle ---

export interface PluginContext {
  readonly logger: Logger
  readonly events: EventBus
  readonly clock: Clock
  readonly signal: AbortSignal
}

export interface PluginLifecycle {
  readonly name: string
  init?(context: PluginContext): Promise<void>
  start?(): Promise<void>
  stop?(): Promise<void>
  destroy?(): Promise<void>
}

// --- Audio types ---

export interface AudioChunk {
  readonly data: ArrayBuffer
  readonly sampleRate: number
  readonly numChannels: number
}

// --- STT ---

export interface STTConfig {
  language?: string
  model?: string
  mode?: 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix'
}

export interface TranscriptResult {
  readonly text: string
  readonly isFinal: boolean
  readonly language?: string
  readonly timestamp?: number
}

export interface STTProvider extends PluginLifecycle {
  transcribe(
    audio: AsyncIterable<AudioChunk>,
    config: STTConfig,
  ): AsyncIterable<TranscriptResult>
  abort?(): void
}

// --- TTS ---

export interface TTSConfig {
  language?: string
  model?: string
  speaker?: string
  pace?: number
}

export interface TTSProvider extends PluginLifecycle {
  synthesize(text: string, config: TTSConfig): AsyncIterable<AudioChunk>
  abort?(): void
}

// --- LLM (Brain) ---

export interface BrainContext {
  readonly sessionId: string
  readonly history: ConversationMessage[]
  readonly signal: AbortSignal
  readonly metadata?: Record<string, unknown>
}

export interface ConversationMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
  readonly metadata?: Record<string, unknown>
}

export type Brain = (
  userText: string,
  context: BrainContext,
) => Promise<string> | AsyncGenerator<string, void, unknown>

// --- VAD ---

export interface VADResult {
  readonly isSpeech: boolean
  readonly confidence: number
}

export interface VADEvent {
  readonly type: 'speech-start' | 'speech-end' | 'speech-cancel'
  readonly timestamp: number
  readonly confidence: number
}

export interface VADProvider extends PluginLifecycle {
  analyze(audio: Float32Array, sampleRate: number): VADResult
  process?(audioStream: AsyncIterable<AudioChunk>): AsyncIterable<VADEvent>
}

// --- Audio Processor (middleware) ---

export interface AudioProcessor extends PluginLifecycle {
  process(audio: Float32Array, sampleRate: number): Float32Array
}

// --- Transport ---

export interface TransportState {
  readonly connected: boolean
  readonly connecting: boolean
  readonly error?: string
}

export interface Transport extends PluginLifecycle {
  connect(sessionId: string): Promise<void>
  disconnect(): Promise<void>
  sendAudio(chunk: ArrayBuffer): void
  onAudio(handler: (chunk: ArrayBuffer) => void): Unsubscribe
  sendEvent(event: unknown): void
  onEvent(handler: (event: unknown) => void): Unsubscribe
  readonly state: TransportState
}

export type Unsubscribe = () => void
