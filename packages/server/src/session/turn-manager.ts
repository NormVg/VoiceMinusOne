/**
 * TurnManager — handles turn-taking, interruption, and barge-in.
 *
 * Focused component that coordinates:
 * - Starting a new turn (user spoke → STT → Brain → TTS)
 * - Interrupting an in-progress turn (barge-in)
 * - Serializing TTS output to preserve audio order
 * - Counter-based cancellation for invalidating in-flight work
 *
 * Per R-012: No god classes. This replaces voice-line's interruptTurn()
 * which touched 7 different pieces of state in one method.
 */

import type { Logger } from '@voiceminusone/core'
import { SilentLogger } from '@voiceminusone/core'

export interface TurnResult {
  readonly userText: string
  readonly assistantText: string
  readonly interrupted: boolean
}

export type TurnStartListener = (turnId: number) => void
export type TurnEndListener = (turnId: number, interrupted: boolean) => void

export class TurnManager {
  private logger: Logger = new SilentLogger()

  /** Monotonically increasing turn counter. */
  private turnCounter = 0

  /** Current active turn ID (0 = no active turn). */
  private currentTurn = 0

  /** TTS generation counter — bumped on interrupt to invalidate in-flight TTS. */
  private ttsGeneration = 0

  /** Serial TTS queue — ensures audio order. */
  private ttsTail: Promise<void> = Promise.resolve()

  /** Abort controller for the current turn. */
  private turnAbort: AbortController | null = null

  private startListeners: TurnStartListener[] = []
  private endListeners: TurnEndListener[] = []

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  /** Get the current TTS generation (for cancellation checks). */
  getTtsGeneration(): number {
    return this.ttsGeneration
  }

  /** Get the current turn ID. */
  getCurrentTurn(): number {
    return this.currentTurn
  }

  /** Check if a turn is in progress. */
  isTurnActive(): boolean {
    return this.currentTurn > 0
  }

  /** Start a new turn. Returns the turn ID and an AbortSignal. */
  startTurn(): { turnId: number; signal: AbortSignal } {
    // Interrupt any existing turn first
    if (this.currentTurn > 0) {
      this.interruptTurn()
    }

    this.turnCounter += 1
    this.currentTurn = this.turnCounter
    this.turnAbort = new AbortController()

    this.logger.debug('turn-manager', `Starting turn ${this.currentTurn}`)
    this.notifyStart(this.currentTurn)

    return { turnId: this.currentTurn, signal: this.turnAbort.signal }
  }

  /** End the current turn. */
  endTurn(interrupted = false): void {
    if (this.currentTurn === 0) return

    const turnId = this.currentTurn
    this.logger.debug('turn-manager', `Ending turn ${turnId} (interrupted: ${interrupted})`)

    if (this.turnAbort) {
      this.turnAbort.abort()
      this.turnAbort = null
    }

    this.currentTurn = 0
    this.notifyEnd(turnId, interrupted)
  }

  /** Interrupt the current turn — abort brain, invalidate TTS, reset queue. */
  interruptTurn(): void {
    if (this.currentTurn === 0) return

    this.logger.debug('turn-manager', `Interrupting turn ${this.currentTurn}`)

    // Abort the brain
    if (this.turnAbort) {
      this.turnAbort.abort()
      this.turnAbort = null
    }

    // Invalidate in-flight TTS items
    this.ttsGeneration += 1
    this.ttsTail = Promise.resolve()

    this.currentTurn = 0
    this.notifyEnd(this.turnCounter, true)
  }

  /**
   * Enqueue a TTS synthesis task in the serial queue.
   * The task runs only if the generation hasn't been invalidated.
   *
   * This is the serial TTS queue pattern from voice-line that we KEEP.
   * It ensures audio order: shorter later sentences can't finish before
   * longer earlier ones.
   */
  enqueueTTS(task: (generation: number) => Promise<void>): void {
    const gen = this.ttsGeneration
    this.ttsTail = this.ttsTail
      .then(async () => {
        if (gen !== this.ttsGeneration) return
        await task(gen)
      })
      .catch((error: unknown) => {
        this.logger.error('turn-manager', `TTS queue error: ${(error as Error).message}`)
      })
  }

  /** Wait for all queued TTS tasks to complete. */
  async waitForTTS(): Promise<void> {
    await this.ttsTail
  }

  /** Subscribe to turn start. */
  onTurnStart(listener: TurnStartListener): () => void {
    this.startListeners.push(listener)
    return () => {
      const idx = this.startListeners.indexOf(listener)
      if (idx >= 0) this.startListeners.splice(idx, 1)
    }
  }

  /** Subscribe to turn end. */
  onTurnEnd(listener: TurnEndListener): () => void {
    this.endListeners.push(listener)
    return () => {
      const idx = this.endListeners.indexOf(listener)
      if (idx >= 0) this.endListeners.splice(idx, 1)
    }
  }

  /** Check if a generation is still current. */
  isCurrentGeneration(gen: number): boolean {
    return gen === this.ttsGeneration
  }

  private notifyStart(turnId: number): void {
    for (const listener of this.startListeners) {
      try {
        listener(turnId)
      } catch (error) {
        this.logger.error('turn-manager', `Start listener error: ${(error as Error).message}`)
      }
    }
  }

  private notifyEnd(turnId: number, interrupted: boolean): void {
    for (const listener of this.endListeners) {
      try {
        listener(turnId, interrupted)
      } catch (error) {
        this.logger.error('turn-manager', `End listener error: ${(error as Error).message}`)
      }
    }
  }
}
