/**
 * Frame system — the universal data unit for the VoiceMinusOne pipeline.
 *
 * Every piece of data (audio chunks, text tokens, transcription results,
 * control signals, lifecycle events) is a typed Frame flowing through the pipeline.
 *
 * Inspired by pipecat's frame system, translated to TypeScript.
 */

/** All possible frame kinds. */
export enum FrameKind {
  // Lifecycle
  Start = 'start',
  End = 'end',
  Cancel = 'cancel',
  Stop = 'stop',

  // Audio
  AudioRaw = 'audio:raw',
  TTSAudioRaw = 'audio:tts-raw',

  // Text
  Text = 'text',
  LLMText = 'text:llm',
  Transcript = 'text:transcript',
  InterimTranscript = 'text:transcript:interim',
  AggregatedText = 'text:aggregated',

  // Turn-taking
  UserStartedSpeaking = 'turn:user-started-speaking',
  UserStoppedSpeaking = 'turn:user-stopped-speaking',
  BotStartedSpeaking = 'turn:bot-started-speaking',
  BotStoppedSpeaking = 'turn:bot-stopped-speaking',
  Interruption = 'turn:interruption',

  // LLM
  LLMFullResponseStart = 'llm:full-response-start',
  LLMFullResponseEnd = 'llm:full-response-end',
  ToolCall = 'llm:tool-call',
  ToolResult = 'llm:tool-result',

  // Error
  Error = 'error',
}

/** Priority tier for frame processing. */
export enum FramePriority {
  /** Processed immediately, jumps the queue. Cancelled by nothing. */
  System = 0,
  /** Processed in order, cancelled by interruptions. */
  Data = 1,
  /** Processed in order, cancelled by interruptions. */
  Control = 1,
}

/** Direction of frame flow in the pipeline. */
export enum FrameDirection {
  Downstream = 'downstream',
  Upstream = 'upstream',
}

/** Base frame interface. All frames share these properties. */
export interface Frame {
  readonly id: number
  readonly kind: FrameKind
  readonly priority: FramePriority
  readonly pts?: number
  readonly metadata?: Record<string, unknown>
}

/** Whether a frame survives interruptions. */
export interface Uninterruptible {
  readonly uninterruptible: true
}

// --- Lifecycle frames (System priority) ---

export interface StartFrame extends Frame {
  readonly kind: FrameKind.Start
  readonly audioInSampleRate: number
  readonly audioOutSampleRate: number
  readonly enableMetrics: boolean
  readonly enableTracing: boolean
}

export interface EndFrame extends Frame, Uninterruptible {
  readonly kind: FrameKind.End
}

export interface CancelFrame extends Frame {
  readonly kind: FrameKind.Cancel
}

export interface StopFrame extends Frame {
  readonly kind: FrameKind.Stop
}

// --- Audio frames (Data priority) ---

export interface AudioRawFrame extends Frame {
  readonly kind: FrameKind.AudioRaw
  readonly audio: ArrayBuffer
  readonly sampleRate: number
  readonly numChannels: number
}

export interface TTSAudioRawFrame extends Frame {
  readonly kind: FrameKind.TTSAudioRaw
  readonly audio: ArrayBuffer
  readonly sampleRate: number
  readonly numChannels: number
  readonly contextId: string
}

// --- Text frames (Data priority) ---

export interface TextFrame extends Frame {
  readonly kind: FrameKind.Text
  readonly text: string
}

export interface LLMTextFrame extends Frame {
  readonly kind: FrameKind.LLMText
  readonly text: string
}

export interface TranscriptFrame extends Frame {
  readonly kind: FrameKind.Transcript
  readonly text: string
  readonly userId?: string
  readonly language?: string
  readonly timestamp: number
}

export interface InterimTranscriptFrame extends Frame {
  readonly kind: FrameKind.InterimTranscript
  readonly text: string
}

export interface AggregatedTextFrame extends Frame {
  readonly kind: FrameKind.AggregatedText
  readonly text: string
}

// --- Turn-taking frames (System priority) ---

export interface UserStartedSpeakingFrame extends Frame {
  readonly kind: FrameKind.UserStartedSpeaking
}

export interface UserStoppedSpeakingFrame extends Frame {
  readonly kind: FrameKind.UserStoppedSpeaking
}

export interface BotStartedSpeakingFrame extends Frame {
  readonly kind: FrameKind.BotStartedSpeaking
}

export interface BotStoppedSpeakingFrame extends Frame {
  readonly kind: FrameKind.BotStoppedSpeaking
}

export interface InterruptionFrame extends Frame {
  readonly kind: FrameKind.Interruption
}

// --- LLM frames (Control priority) ---

export interface LLMFullResponseStartFrame extends Frame {
  readonly kind: FrameKind.LLMFullResponseStart
}

export interface LLMFullResponseEndFrame extends Frame {
  readonly kind: FrameKind.LLMFullResponseEnd
}

export interface ToolCallFrame extends Frame {
  readonly kind: FrameKind.ToolCall
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: string
}

export interface ToolResultFrame extends Frame {
  readonly kind: FrameKind.ToolResult
  readonly toolCallId: string
  readonly toolName: string
  readonly output: string
}

// --- Error frame ---

export interface ErrorFrame extends Frame {
  readonly kind: FrameKind.Error
  readonly code: string
  readonly message: string
  readonly fatal: boolean
}

// --- Union type ---

export type AnyFrame =
  | StartFrame
  | EndFrame
  | CancelFrame
  | StopFrame
  | AudioRawFrame
  | TTSAudioRawFrame
  | TextFrame
  | LLMTextFrame
  | TranscriptFrame
  | InterimTranscriptFrame
  | AggregatedTextFrame
  | UserStartedSpeakingFrame
  | UserStoppedSpeakingFrame
  | BotStartedSpeakingFrame
  | BotStoppedSpeakingFrame
  | InterruptionFrame
  | LLMFullResponseStartFrame
  | LLMFullResponseEndFrame
  | ToolCallFrame
  | ToolResultFrame
  | ErrorFrame

// --- Frame factory ---

let frameIdCounter = 0

function nextFrameId(): number {
  frameIdCounter += 1
  return frameIdCounter
}

/** Create a frame with auto-generated id and default priority. */
export function createFrame(
  kind: FrameKind,
  data: Partial<Omit<Frame, 'id' | 'kind'>> & Record<string, unknown>,
): AnyFrame {
  const priority =
    data.priority ??
    (isSystemFrameKind(kind) ? FramePriority.System : FramePriority.Data)
  return {
    id: nextFrameId(),
    kind,
    priority,
    ...data,
  } as AnyFrame
}

/** System frames are processed immediately and never blocked. */
export function isSystemFrame(frame: Frame): boolean {
  return frame.priority === FramePriority.System
}

function isSystemFrameKind(kind: FrameKind): boolean {
  switch (kind) {
    case FrameKind.Start:
    case FrameKind.Cancel:
    case FrameKind.Interruption:
    case FrameKind.UserStartedSpeaking:
    case FrameKind.UserStoppedSpeaking:
      return true
    default:
      return false
  }
}

/** Check if a frame is uninterruptible (survives interruptions). */
export function isUninterruptible(frame: Frame): boolean {
  return 'uninterruptible' in frame && frame.uninterruptible === true
}

// --- Convenience constructors ---

export const frames = {
  start: (opts?: Partial<StartFrame>): StartFrame =>
    createFrame(FrameKind.Start, {
      audioInSampleRate: 16000,
      audioOutSampleRate: 24000,
      enableMetrics: false,
      enableTracing: false,
      ...opts,
    }) as StartFrame,

  end: (): EndFrame =>
    createFrame(FrameKind.End, { uninterruptible: true }) as EndFrame,

  cancel: (): CancelFrame => createFrame(FrameKind.Cancel, {}) as CancelFrame,

  stop: (): StopFrame => createFrame(FrameKind.Stop, {}) as StopFrame,

  audioRaw: (
    audio: ArrayBuffer,
    sampleRate: number,
    numChannels = 1,
  ): AudioRawFrame =>
    createFrame(FrameKind.AudioRaw, {
      audio,
      sampleRate,
      numChannels,
    }) as AudioRawFrame,

  ttsAudioRaw: (
    audio: ArrayBuffer,
    sampleRate: number,
    contextId: string,
    numChannels = 1,
  ): TTSAudioRawFrame =>
    createFrame(FrameKind.TTSAudioRaw, {
      audio,
      sampleRate,
      numChannels,
      contextId,
    }) as TTSAudioRawFrame,

  text: (text: string): TextFrame =>
    createFrame(FrameKind.Text, { text }) as TextFrame,

  llmText: (text: string): LLMTextFrame =>
    createFrame(FrameKind.LLMText, { text }) as LLMTextFrame,

  transcript: (
    text: string,
    timestamp: number,
    opts?: Partial<TranscriptFrame>,
  ): TranscriptFrame =>
    createFrame(FrameKind.Transcript, {
      text,
      timestamp,
      ...opts,
    }) as TranscriptFrame,

  interimTranscript: (text: string): InterimTranscriptFrame =>
    createFrame(FrameKind.InterimTranscript, { text }) as InterimTranscriptFrame,

  aggregatedText: (text: string): AggregatedTextFrame =>
    createFrame(FrameKind.AggregatedText, { text }) as AggregatedTextFrame,

  userStartedSpeaking: (): UserStartedSpeakingFrame =>
    createFrame(FrameKind.UserStartedSpeaking, {}) as UserStartedSpeakingFrame,

  userStoppedSpeaking: (): UserStoppedSpeakingFrame =>
    createFrame(FrameKind.UserStoppedSpeaking, {}) as UserStoppedSpeakingFrame,

  botStartedSpeaking: (): BotStartedSpeakingFrame =>
    createFrame(FrameKind.BotStartedSpeaking, {}) as BotStartedSpeakingFrame,

  botStoppedSpeaking: (): BotStoppedSpeakingFrame =>
    createFrame(FrameKind.BotStoppedSpeaking, {}) as BotStoppedSpeakingFrame,

  interruption: (): InterruptionFrame =>
    createFrame(FrameKind.Interruption, {}) as InterruptionFrame,

  error: (code: string, message: string, fatal = false): ErrorFrame =>
    createFrame(FrameKind.Error, { code, message, fatal }) as ErrorFrame,

  toolCall: (
    toolCallId: string,
    toolName: string,
    args: string,
  ): ToolCallFrame =>
    createFrame(FrameKind.ToolCall, {
      toolCallId,
      toolName,
      arguments: args,
    }) as ToolCallFrame,

  toolResult: (
    toolCallId: string,
    toolName: string,
    output: string,
  ): ToolResultFrame =>
    createFrame(FrameKind.ToolResult, {
      toolCallId,
      toolName,
      output,
    }) as ToolResultFrame,
}
