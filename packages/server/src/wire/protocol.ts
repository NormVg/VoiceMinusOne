/**
 * Wire protocol — zod-validated events between client and server.
 *
 * Binary frames → audio (raw PCM, never base64).
 * Text frames → JSON events, validated with zod on receipt.
 *
 * Per R-009: All incoming wire protocol events MUST be validated with zod.
 * Per R-017: Never guess frame type from byte values — use WebSocket frame type.
 */

import { z } from 'zod'

// --- Client → Server events ---

export const StartSpeakingEvent = z.object({
  type: z.literal('start_speaking'),
})
export type StartSpeakingEvent = z.infer<typeof StartSpeakingEvent>

export const StopSpeakingEvent = z.object({
  type: z.literal('stop_speaking'),
})
export type StopSpeakingEvent = z.infer<typeof StopSpeakingEvent>

export const MuteEvent = z.object({
  type: z.literal('mute'),
  muted: z.boolean(),
})
export type MuteEvent = z.infer<typeof MuteEvent>

export const ConfigUpdateEvent = z.object({
  type: z.literal('config_update'),
  config: z.record(z.string(), z.unknown()).optional(),
})
export type ConfigUpdateEvent = z.infer<typeof ConfigUpdateEvent>

export const ClientToServerEventSchema = z.discriminatedUnion('type', [
  StartSpeakingEvent,
  StopSpeakingEvent,
  MuteEvent,
  ConfigUpdateEvent,
])

export type ClientToServerEvent =
  | StartSpeakingEvent
  | StopSpeakingEvent
  | MuteEvent
  | ConfigUpdateEvent

// --- Server → Client events ---

export const MessageEvent = z.object({
  type: z.literal('message'),
  message: z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  }),
})
export type MessageEvent = z.infer<typeof MessageEvent>

export const TranscriptEvent = z.object({
  type: z.literal('transcript'),
  text: z.string(),
  isFinal: z.boolean(),
})
export type TranscriptEvent = z.infer<typeof TranscriptEvent>

export const BotTextEvent = z.object({
  type: z.literal('bot_text'),
  text: z.string(),
  messageId: z.string(),
})
export type BotTextEvent = z.infer<typeof BotTextEvent>

export const BotTextDoneEvent = z.object({
  type: z.literal('bot_text_done'),
  messageId: z.string(),
  partial: z.boolean(),
})
export type BotTextDoneEvent = z.infer<typeof BotTextDoneEvent>

export const AudioFlushEvent = z.object({
  type: z.literal('audio_flush'),
})
export type AudioFlushEvent = z.infer<typeof AudioFlushEvent>

export const ToolCallEvent = z.object({
  type: z.literal('tool_call'),
  toolCallId: z.string(),
  toolName: z.string(),
  arguments: z.string(),
})
export type ToolCallEvent = z.infer<typeof ToolCallEvent>

export const ErrorEvent = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
})
export type ErrorEvent = z.infer<typeof ErrorEvent>

export const StateEvent = z.object({
  type: z.literal('state'),
  state: z.enum([
    'idle',
    'connected',
    'listening',
    'receiving',
    'processing',
    'speaking',
    'closed',
  ]),
})
export type StateEvent = z.infer<typeof StateEvent>

export const TurnStatsEvent = z.object({
  type: z.literal('turn_stats'),
  turnId: z.number(),
  /** Time from turn start to STT result (ms) */
  sttMs: z.number(),
  /** Time the LLM took to produce all text (ms) */
  brainMs: z.number(),
  /** Time from turn start to first audio chunk sent (ms) */
  firstAudioMs: z.number(),
  /** Total TTS synthesis time (ms) */
  ttsMs: z.number(),
  /** Total turn wall-clock time (ms) */
  totalMs: z.number(),
  /** Number of sentences synthesized */
  sentences: z.number(),
  /** User transcript (truncated) */
  transcript: z.string(),
  /** Bot response (truncated) */
  response: z.string(),
  /** Whether the turn was interrupted */
  interrupted: z.boolean(),
})
export type TurnStatsEvent = z.infer<typeof TurnStatsEvent>

export const ServerToClientEventSchema = z.discriminatedUnion('type', [
  MessageEvent,
  TranscriptEvent,
  BotTextEvent,
  BotTextDoneEvent,
  AudioFlushEvent,
  ToolCallEvent,
  ErrorEvent,
  StateEvent,
  TurnStatsEvent,
])

export type ServerToClientEvent =
  | MessageEvent
  | TranscriptEvent
  | BotTextDoneEvent
  | AudioFlushEvent
  | MessageEvent
  | TranscriptEvent
  | BotTextEvent
  | ToolCallEvent
  | ErrorEvent
  | StateEvent
  | TurnStatsEvent

// --- Validation helpers ---

/**
 * Parse and validate an incoming client→server event.
 * Throws WireProtocolError if the event is malformed.
 */
export function parseClientEvent(data: string): ClientToServerEvent {
  try {
    const json = JSON.parse(data)
    return ClientToServerEventSchema.parse(json)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new WireProtocolParseError(
        `Invalid client event: ${error.message}`,
      )
    }
    throw new WireProtocolParseError(`Malformed JSON: ${(error as Error).message}`)
  }
}

/**
 * Serialize a server→client event for sending over the wire.
 */
export function serializeServerEvent(event: ServerToClientEvent): string {
  return JSON.stringify(event)
}

/**
 * Check if a server→client event is valid before sending.
 */
export function isValidServerEvent(event: unknown): event is ServerToClientEvent {
  return ServerToClientEventSchema.safeParse(event).success
}

// --- Error ---

export class WireProtocolParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireProtocolParseError'
  }
}
