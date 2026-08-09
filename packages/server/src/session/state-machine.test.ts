import { describe, it, expect } from 'vitest'
import { SessionStateMachine } from './state-machine'
import { SessionState } from '@voiceminusone/core'

describe('SessionStateMachine', () => {
  it('should start in idle state', () => {
    const sm = new SessionStateMachine()
    expect(sm.state).toBe(SessionState.Idle)
  })

  it('should transition idle → connected', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    expect(sm.state).toBe(SessionState.Connected)
  })

  it('should transition connected → listening', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Listening)
    expect(sm.state).toBe(SessionState.Listening)
  })

  it('should transition listening → receiving → processing → speaking → listening', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Listening)
    sm.transition(SessionState.Receiving)
    sm.transition(SessionState.Processing)
    sm.transition(SessionState.Speaking)
    sm.transition(SessionState.Listening)
    expect(sm.state).toBe(SessionState.Listening)
  })

  it('should throw on invalid transition', () => {
    const sm = new SessionStateMachine()
    expect(() => sm.transition(SessionState.Speaking)).toThrow()
  })

  it('should throw on transition from closed', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Closed)
    expect(() => sm.transition(SessionState.Listening)).toThrow()
  })

  it('should force close from any state', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Listening)
    sm.forceClose()
    expect(sm.state).toBe(SessionState.Closed)
  })

  it('should notify listeners on state change', () => {
    const sm = new SessionStateMachine()
    const transitions: string[] = []
    sm.onStateChange((t) => transitions.push(`${t.from}→${t.to}`))

    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Listening)

    expect(transitions).toEqual(['idle→connected', 'connected→listening'])
  })

  it('should support unsubscribe', () => {
    const sm = new SessionStateMachine()
    const transitions: string[] = []
    const unsub = sm.onStateChange((t) => transitions.push(`${t.from}→${t.to}`))

    sm.transition(SessionState.Connected)
    unsub()
    sm.transition(SessionState.Listening)

    expect(transitions).toHaveLength(1)
  })

  it('should report active state correctly', () => {
    const sm = new SessionStateMachine()
    expect(sm.isActive()).toBe(false)
    sm.transition(SessionState.Connected)
    expect(sm.isActive()).toBe(true)
    sm.transition(SessionState.Closed)
    expect(sm.isActive()).toBe(false)
  })

  it('should report speaking state correctly', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Listening)
    sm.transition(SessionState.Receiving)
    sm.transition(SessionState.Processing)
    sm.transition(SessionState.Speaking)
    expect(sm.isSpeaking()).toBe(true)
  })

  it('should report listening state correctly', () => {
    const sm = new SessionStateMachine()
    sm.transition(SessionState.Connected)
    sm.transition(SessionState.Listening)
    expect(sm.isListening()).toBe(true)
    sm.transition(SessionState.Receiving)
    expect(sm.isListening()).toBe(true)
  })

  it('should check canTransition without performing', () => {
    const sm = new SessionStateMachine()
    expect(sm.canTransition(SessionState.Connected)).toBe(true)
    expect(sm.canTransition(SessionState.Speaking)).toBe(false)
  })
})
