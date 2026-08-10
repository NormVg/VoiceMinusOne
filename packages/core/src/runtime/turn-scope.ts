import type { Clock } from '../utils/clock'

export interface TurnScope {
  readonly id: number
  readonly generation: number
  readonly signal: AbortSignal
  readonly startedAt: number
  abort(reason?: string): void
  isCurrent(generation: number): boolean
}

export class TurnScopeController implements TurnScope {
  readonly signal: AbortSignal
  readonly startedAt: number
  private readonly controller = new AbortController()

  constructor(
    readonly id: number,
    readonly generation: number,
    clock: Clock,
  ) {
    this.signal = this.controller.signal
    this.startedAt = clock.now()
  }

  abort(reason?: string): void {
    this.controller.abort(reason)
  }

  isCurrent(generation: number): boolean {
    return !this.signal.aborted && this.generation === generation
  }
}
