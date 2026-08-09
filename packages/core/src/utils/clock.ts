/**
 * Injectable clock — never use Date.now() directly in core/plugin code.
 *
 * Per R-001: All time access goes through the Clock interface.
 * This allows tests to inject a mock clock for deterministic behavior.
 */

export interface Clock {
  now(): number
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

/** A mock clock for testing. Time only advances when you call tick(). */
export class MockClock implements Clock {
  private current: number

  constructor(initial: number = 0) {
    this.current = initial
  }

  now(): number {
    return this.current
  }

  tick(ms: number): void {
    this.current += ms
  }

  set(time: number): void {
    this.current = time
  }
}

/** The default clock instance. Override in tests. */
export const clock: Clock = new SystemClock()
