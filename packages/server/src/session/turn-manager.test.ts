import { describe, it, expect, vi } from 'vitest'
import { TurnManager } from './turn-manager'

describe('TurnManager', () => {
  it('should start with no active turn', () => {
    const tm = new TurnManager()
    expect(tm.isTurnActive()).toBe(false)
    expect(tm.getCurrentTurn()).toBe(0)
  })

  it('should start a turn and return an id + signal', () => {
    const tm = new TurnManager()
    const { turnId, signal } = tm.startTurn()
    expect(turnId).toBe(1)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(tm.isTurnActive()).toBe(true)
  })

  it('should increment turn id on each new turn', () => {
    const tm = new TurnManager()
    const t1 = tm.startTurn()
    tm.endTurn()
    const t2 = tm.startTurn()
    tm.endTurn()
    const t3 = tm.startTurn()
    expect(t1.turnId).toBe(1)
    expect(t2.turnId).toBe(2)
    expect(t3.turnId).toBe(3)
  })

  it('should end a turn', () => {
    const tm = new TurnManager()
    tm.startTurn()
    tm.endTurn()
    expect(tm.isTurnActive()).toBe(false)
  })

  it('should interrupt an existing turn when starting a new one', () => {
    const tm = new TurnManager()
    const { signal: signal1 } = tm.startTurn()
    expect(signal1.aborted).toBe(false)

    // Starting a new turn interrupts the first
    const { signal: signal2 } = tm.startTurn()
    expect(signal1.aborted).toBe(true)
    expect(signal2.aborted).toBe(false)
  })

  it('should bump tts generation on interrupt', () => {
    const tm = new TurnManager()
    const gen0 = tm.getTtsGeneration()
    tm.startTurn()
    tm.interruptTurn()
    const gen1 = tm.getTtsGeneration()
    expect(gen1).toBeGreaterThan(gen0)
  })

  it('should enqueue TTS tasks in serial order', async () => {
    const tm = new TurnManager()
    tm.startTurn()

    const order: number[] = []
    tm.enqueueTTS(async () => {
      await new Promise((r) => setTimeout(r, 50))
      order.push(1)
    })
    tm.enqueueTTS(async () => {
      order.push(2)
    })

    await tm.waitForTTS()
    expect(order).toEqual([1, 2])
  })

  it('should skip enqueued TTS tasks from old generation after interrupt', async () => {
    const tm = new TurnManager()
    tm.startTurn()

    let executed = false
    tm.enqueueTTS(async () => {
      executed = true
    })

    tm.interruptTurn()
    await tm.waitForTTS()
    expect(executed).toBe(false)
  })

  it('should notify start listeners', () => {
    const tm = new TurnManager()
    const starts: number[] = []
    tm.onTurnStart((turnId) => starts.push(turnId))

    tm.startTurn()
    tm.endTurn()
    tm.startTurn()

    expect(starts).toEqual([1, 2])
  })

  it('should notify end listeners with interrupted flag', () => {
    const tm = new TurnManager()
    const ends: Array<{ id: number; interrupted: boolean }> = []
    tm.onTurnEnd((id, interrupted) => ends.push({ id, interrupted }))

    tm.startTurn()
    tm.endTurn(false)
    tm.startTurn()
    tm.interruptTurn()

    expect(ends).toEqual([
      { id: 1, interrupted: false },
      { id: 2, interrupted: true },
    ])
  })

  it('should support unsubscribe from listeners', () => {
    const tm = new TurnManager()
    const starts: number[] = []
    const unsub = tm.onTurnStart((id) => starts.push(id))

    tm.startTurn()
    unsub()
    tm.endTurn()
    tm.startTurn()

    expect(starts).toEqual([1])
  })

  it('should check isCurrentGeneration correctly', () => {
    const tm = new TurnManager()
    tm.startTurn()
    const gen = tm.getTtsGeneration()
    expect(tm.isCurrentGeneration(gen)).toBe(true)

    tm.interruptTurn()
    expect(tm.isCurrentGeneration(gen)).toBe(false)
  })
})
