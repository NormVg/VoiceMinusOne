/**
 * SessionStateMachine — manages session state transitions.
 *
 * This is a focused component that ONLY handles state transitions.
 * It does not manage pipelines, TTS queues, brain execution, or transport.
 *
 * Per R-012: No god classes. Split concerns into focused components.
 *
 * State flow:
 *   idle → connected → listening ↔ receiving → processing → speaking → listening
 *                                                            ↓
 *                                                         closed
 */

import { SessionState } from '@voiceminusone/core'
import type { Logger } from '@voiceminusone/core'
import { SilentLogger } from '@voiceminusone/core'

/** Valid state transitions. */
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  [SessionState.Idle]: [SessionState.Connected, SessionState.Closed],
  [SessionState.Connected]: [SessionState.Listening, SessionState.Closed],
  [SessionState.Listening]: [
    SessionState.Receiving,
    SessionState.Processing,
    SessionState.Closed,
  ],
  [SessionState.Receiving]: [
    SessionState.Listening,
    SessionState.Processing,
    SessionState.Closed,
  ],
  [SessionState.Processing]: [SessionState.Speaking, SessionState.Listening, SessionState.Closed],
  [SessionState.Speaking]: [SessionState.Listening, SessionState.Closed],
  [SessionState.Closed]: [],
}

export interface StateTransition {
  from: SessionState
  to: SessionState
  timestamp: number
}

export type StateChangeListener = (transition: StateTransition) => void

export class SessionStateMachine {
  private _state: SessionState = SessionState.Idle
  private logger: Logger = new SilentLogger()
  private listeners: StateChangeListener[] = []

  get state(): SessionState {
    return this._state
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  /** Transition to a new state. Throws if the transition is invalid. */
  transition(to: SessionState): StateTransition {
    const from = this._state
    const allowed = VALID_TRANSITIONS[from]

    if (!allowed || !allowed.includes(to)) {
      throw new SessionStateError(
        `Invalid state transition: ${from} → ${to}`,
      )
    }

    const transition: StateTransition = { from, to, timestamp: Date.now() }
    this._state = to
    this.logger.debug('state-machine', `${from} → ${to}`)
    this.notifyListeners(transition)
    return transition
  }

  /** Force transition to closed (for cleanup). */
  forceClose(): void {
    if (this._state !== SessionState.Closed) {
      const transition: StateTransition = {
        from: this._state,
        to: SessionState.Closed,
        timestamp: Date.now(),
      }
      this._state = SessionState.Closed
      this.logger.debug('state-machine', `${transition.from} → closed (forced)`)
      this.notifyListeners(transition)
    }
  }

  /** Check if a transition is valid without performing it. */
  canTransition(to: SessionState): boolean {
    const allowed = VALID_TRANSITIONS[this._state]
    return allowed ? allowed.includes(to) : false
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  /** Check if the session is in an active (non-closed) state. */
  isActive(): boolean {
    return this._state !== SessionState.Closed && this._state !== SessionState.Idle
  }

  /** Check if the bot is currently speaking. */
  isSpeaking(): boolean {
    return this._state === SessionState.Speaking
  }

  /** Check if the session is listening for user input. */
  isListening(): boolean {
    return (
      this._state === SessionState.Listening ||
      this._state === SessionState.Receiving
    )
  }

  private notifyListeners(transition: StateTransition): void {
    for (const listener of this.listeners) {
      try {
        listener(transition)
      } catch (error) {
        this.logger.error('state-machine', `State change listener error: ${(error as Error).message}`)
      }
    }
  }
}

export class SessionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionStateError'
  }
}
