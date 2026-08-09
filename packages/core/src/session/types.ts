/**
 * Session types — state machine and configuration.
 *
 * The session is NOT a god class. It coordinates focused components:
 * SessionStateMachine, TurnManager, AudioRouter, HistoryManager, PipelineRunner.
 */

import type { STTProvider, TTSProvider, Brain, VADProvider, Transport } from '../interfaces'

export enum SessionState {
  Idle = 'idle',
  Connected = 'connected',
  Listening = 'listening',
  Receiving = 'receiving',
  Processing = 'processing',
  Speaking = 'speaking',
  Closed = 'closed',
}

export interface SessionConfig {
  readonly transport: Transport
  readonly stt: STTProvider
  readonly tts: TTSProvider
  readonly brain: Brain
  readonly vad?: VADProvider
  readonly sampleRate?: number
  readonly maxDuration?: number
  readonly idleTimeoutMs?: number
}

export interface SessionEvents {
  stateChange: { from: SessionState; to: SessionState; timestamp: number }
  transcript: { text: string; isFinal: boolean }
  botText: { text: string; messageId: string }
  botTextDone: { messageId: string; partial: boolean }
  audioFlush: void
  error: { code: string; message: string }
}

export type SessionEventName = keyof SessionEvents
