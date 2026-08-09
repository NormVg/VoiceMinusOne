/**
 * @voiceminusone/server
 *
 * Server runtime for VoiceMinusOne — session management, pipeline runner,
 * wire protocol, and framework adapters.
 *
 * The session is split into focused components (no god classes):
 * - SessionStateMachine (state transitions)
 * - TurnManager (turn-taking, interruption, TTS queue)
 * - AudioRouter (audio routing between transport/STT/TTS)
 * - HistoryManager (conversation messages)
 * - SessionManager (coordinator)
 */

// Session components
export { SessionStateMachine } from './session/state-machine'
export type { StateTransition, StateChangeListener } from './session/state-machine'
export { SessionStateError } from './session/state-machine'

export { TurnManager } from './session/turn-manager'
export type { TurnResult, TurnStartListener, TurnEndListener } from './session/turn-manager'

export { AudioRouter } from './session/audio-router'
export type { AudioRouterOptions, TranscriptHandler, TTSChunkHandler } from './session/audio-router'

export { HistoryManager } from './session/history-manager'
export type { HistoryEntry } from './session/history-manager'

export { SessionManager } from './session/session-manager'
export type { SessionManagerOptions } from './session/session-manager'

// Transport adapters
export { WebSocketTransport } from './transport/websocket-transport'
export type {
  WebSocketTransportOptions,
  WsSocket,
  WsServerLike,
  WebSocketServerOptions,
} from './transport/websocket-transport'
export { WebSocketServer } from './transport/websocket-transport'

// Wire protocol
export {
  parseClientEvent,
  serializeServerEvent,
  isValidServerEvent,
  WireProtocolParseError,
  ClientToServerEventSchema,
  ServerToClientEventSchema,
} from './wire/protocol'
export type {
  ClientToServerEvent,
  ServerToClientEvent,
  StartSpeakingEvent,
  StopSpeakingEvent,
  MuteEvent,
  ConfigUpdateEvent,
  MessageEvent,
  TranscriptEvent,
  BotTextEvent,
  BotTextDoneEvent,
  AudioFlushEvent,
  ToolCallEvent,
  ErrorEvent,
  StateEvent,
  TurnStatsEvent,
} from './wire/protocol'
