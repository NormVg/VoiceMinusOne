/**
 * @voiceminusone/core
 *
 * Core frame types, pipeline, and plugin interfaces for VoiceMinusOne.
 * This is the foundation — types, interfaces, pipeline, session.
 * No provider dependencies.
 */

// Frames
export {
  FrameKind,
  FramePriority,
  FrameDirection,
  frames,
  createFrame,
  isSystemFrame,
  isUninterruptible,
} from './frames/frames'

export type {
  Frame,
  Uninterruptible,
  StartFrame,
  EndFrame,
  CancelFrame,
  StopFrame,
  AudioRawFrame,
  TTSAudioRawFrame,
  TextFrame,
  LLMTextFrame,
  TranscriptFrame,
  InterimTranscriptFrame,
  AggregatedTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  InterruptionFrame,
  LLMFullResponseStartFrame,
  LLMFullResponseEndFrame,
  ToolCallFrame,
  ToolResultFrame,
  ErrorFrame,
  AnyFrame,
} from './frames/frames'

// Processors
export { FrameProcessor } from './processors/frame-processor'
export type { FrameHandler } from './processors/frame-processor'

// Pipeline
export { Pipeline } from './pipeline/pipeline'

// Interfaces
export type {
  PluginContext,
  PluginLifecycle,
  AudioChunk,
  STTConfig,
  TranscriptResult,
  STTProvider,
  TTSConfig,
  TTSProvider,
  BrainContext,
  ConversationMessage,
  Brain,
  VADResult,
  VADEvent,
  VADProvider,
  AudioProcessor,
  TransportState,
  Transport,
  Unsubscribe,
} from './interfaces'

// Session
export { SessionState } from './session/types'
export type { SessionConfig, SessionEvents, SessionEventName } from './session/types'
export { MemoryTransport } from './session/memory-transport'

// Errors
export {
  VoiceMinusOneError,
  PluginError,
  TransportError,
  PipelineError,
  SessionError,
  WireProtocolError,
} from './errors'
export type { VoiceMinusOneErrorCode } from './errors'

// Utils
export type { Clock } from './utils/clock'
export { SystemClock, MockClock, clock } from './utils/clock'
export { LogLevel, ConsoleLogger, SilentLogger, logger } from './utils/logger'
export type { Logger } from './utils/logger'
export { TypedEventBus } from './utils/event-bus'
export type { EventBus, EventHandler } from './utils/event-bus'
