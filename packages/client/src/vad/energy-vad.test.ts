import { describe, it, expect } from 'vitest'
import { EnergyVAD, VADStatus, DEFAULT_VAD_CONFIG } from './energy-vad'

describe('EnergyVAD', () => {
  it('should start in silence state', () => {
    const vad = new EnergyVAD()
    expect(vad.getStatus()).toBe(VADStatus.Silence)
    expect(vad.isSpeaking()).toBe(false)
  })

  it('should use default config when none provided', () => {
    const vad = new EnergyVAD()
    // Processing silence should stay in silence
    const samples = new Float32Array(1600).fill(0)
    vad.process(samples, 0)
    expect(vad.getStatus()).toBe(VADStatus.Silence)
  })

  it('should transition to maybe-speaking on high energy', () => {
    const vad = new EnergyVAD({ energyThreshold: 0.01 })
    // Generate high-energy samples (loud signal)
    const samples = new Float32Array(1600)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(i * 0.1) * 0.5
    }
    vad.process(samples, 0)
    expect(vad.getStatus()).toBe(VADStatus.MaybeSpeaking)
  })

  it('should transition to speaking after confirm duration', () => {
    const vad = new EnergyVAD({
      energyThreshold: 0.01,
      confirmDurationMs: 80,
    })

    // Generate high-energy samples
    const samples = new Float32Array(1600)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(i * 0.1) * 0.5
    }

    // First call → maybe-speaking
    vad.process(samples, 0)
    expect(vad.getStatus()).toBe(VADStatus.MaybeSpeaking)

    // After confirm duration → speaking
    vad.process(samples, 100)
    expect(vad.getStatus()).toBe(VADStatus.Speaking)
    expect(vad.isSpeaking()).toBe(true)
  })

  it('should cancel maybe-speaking on silence', () => {
    const vad = new EnergyVAD({
      energyThreshold: 0.01,
      cancelDurationMs: 200,
    })

    // High energy → maybe-speaking
    const loud = new Float32Array(1600)
    for (let i = 0; i < loud.length; i++) {
      loud[i] = Math.sin(i * 0.1) * 0.5
    }
    vad.process(loud, 0)
    expect(vad.getStatus()).toBe(VADStatus.MaybeSpeaking)

    // Silence for longer than cancel duration → back to silence
    const silent = new Float32Array(1600).fill(0)
    vad.process(silent, 300)
    expect(vad.getStatus()).toBe(VADStatus.Silence)
  })

  it('should transition to stop-speaking after silence duration', () => {
    const vad = new EnergyVAD({
      energyThreshold: 0.01,
      confirmDurationMs: 50,
      stopDurationMs: 500,
    })

    // Get to speaking state
    const loud = new Float32Array(1600)
    for (let i = 0; i < loud.length; i++) {
      loud[i] = Math.sin(i * 0.1) * 0.5
    }
    vad.process(loud, 0)
    vad.process(loud, 100) // Confirm speaking

    // Silence for longer than stop duration → back to silence
    const silent = new Float32Array(1600).fill(0)
    vad.process(silent, 700)
    expect(vad.getStatus()).toBe(VADStatus.Silence)
  })

  it('should emit VAD events', () => {
    const vad = new EnergyVAD({
      energyThreshold: 0.01,
      confirmDurationMs: 50,
      stopDurationMs: 300,
    })

    const events: string[] = []
    vad.onEvent((e) => events.push(e.type))

    const loud = new Float32Array(1600)
    for (let i = 0; i < loud.length; i++) {
      loud[i] = Math.sin(i * 0.1) * 0.5
    }
    const silent = new Float32Array(1600).fill(0)

    vad.process(loud, 0)    // start-speaking
    vad.process(loud, 100)  // confirm-speaking
    vad.process(silent, 500) // stop-speaking

    expect(events).toContain('start-speaking')
    expect(events).toContain('confirm-speaking')
    expect(events).toContain('stop-speaking')
  })

  it('should support unsubscribe', () => {
    const vad = new EnergyVAD({ energyThreshold: 0.01 })
    const events: string[] = []
    const unsub = vad.onEvent((e) => events.push(e.type))

    unsub()

    const loud = new Float32Array(1600)
    for (let i = 0; i < loud.length; i++) {
      loud[i] = Math.sin(i * 0.1) * 0.5
    }
    vad.process(loud, 0)

    expect(events).toHaveLength(0)
  })

  it('should reset to silence', () => {
    const vad = new EnergyVAD({ energyThreshold: 0.01 })

    const loud = new Float32Array(1600)
    for (let i = 0; i < loud.length; i++) {
      loud[i] = Math.sin(i * 0.1) * 0.5
    }
    vad.process(loud, 0)
    vad.process(loud, 100)

    vad.reset()
    expect(vad.getStatus()).toBe(VADStatus.Silence)
    expect(vad.isSpeaking()).toBe(false)
  })

  it('should export default config', () => {
    expect(DEFAULT_VAD_CONFIG.energyThreshold).toBeGreaterThan(0)
    expect(DEFAULT_VAD_CONFIG.confirmDurationMs).toBeGreaterThan(0)
    expect(DEFAULT_VAD_CONFIG.stopDurationMs).toBeGreaterThan(0)
  })
})
