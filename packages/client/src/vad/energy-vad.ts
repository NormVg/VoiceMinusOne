/**
 * VAD — Voice Activity Detection.
 *
 * Three-phase state machine (inspired by micdrop):
 *   Silence → MaybeSpeaking → Speaking → (ConfirmSpeaking | CancelSpeaking) → StopSpeaking
 *
 * The key insight: recording starts immediately on MaybeSpeaking (queued),
 * but chunks are only emitted after ConfirmSpeaking. If CancelSpeaking fires,
 * queued chunks are discarded. This minimizes latency while avoiding noise.
 *
 * This is the energy-based VAD (zero-dependency fallback).
 * Silero VAD (ONNX Runtime Web) will be a separate plugin package.
 */

export enum VADStatus {
  Silence = 'silence',
  MaybeSpeaking = 'maybe-speaking',
  Speaking = 'speaking',
}

export interface VADConfig {
  /** Energy threshold for speech detection (0-1). */
  readonly energyThreshold: number
  /** Duration of speech needed to confirm speaking (ms). */
  readonly confirmDurationMs: number
  /** Duration of silence needed to stop speaking (ms). */
  readonly stopDurationMs: number
  /** Duration of silence to cancel a maybe-speaking (ms). */
  readonly cancelDurationMs: number
}

export const DEFAULT_VAD_CONFIG: VADConfig = {
  energyThreshold: 0.005,
  confirmDurationMs: 50,
  stopDurationMs: 700,
  cancelDurationMs: 300,
}

export type VADEventType =
  | 'start-speaking'
  | 'confirm-speaking'
  | 'cancel-speaking'
  | 'stop-speaking'

export interface VADEvent {
  readonly type: VADEventType
  readonly timestamp: number
  readonly confidence: number
}

export type VADEventListener = (event: VADEvent) => void

/**
 * Energy-based VAD using RMS energy calculation.
 *
 * Pure TypeScript — no ONNX runtime, no WASM.
 * Suitable as a fallback when Silero VAD is not available.
 */
export class EnergyVAD {
  private config: VADConfig
  private status: VADStatus = VADStatus.Silence
  private maybeSpeakingStart = 0
  private lastSpeechTime = 0
  private listeners: VADEventListener[] = []

  constructor(config: Partial<VADConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config }
  }

  /**
   * Process a chunk of audio samples.
   * Returns the current VAD status.
   */
  process(samples: Float32Array, timestamp: number): VADStatus {
    const energy = this.calculateRMS(samples)
    const isSpeech = energy > this.config.energyThreshold

    switch (this.status) {
      case VADStatus.Silence:
        if (isSpeech) {
          this.status = VADStatus.MaybeSpeaking
          this.maybeSpeakingStart = timestamp
          this.emit('start-speaking', timestamp, energy)
        }
        break

      case VADStatus.MaybeSpeaking:
        if (isSpeech) {
          if (timestamp - this.maybeSpeakingStart >= this.config.confirmDurationMs) {
            this.status = VADStatus.Speaking
            this.lastSpeechTime = timestamp
            this.emit('confirm-speaking', timestamp, energy)
          }
        } else {
          if (timestamp - this.maybeSpeakingStart >= this.config.cancelDurationMs) {
            this.status = VADStatus.Silence
            this.emit('cancel-speaking', timestamp, energy)
          }
        }
        break

      case VADStatus.Speaking:
        if (isSpeech) {
          this.lastSpeechTime = timestamp
        } else {
          if (timestamp - this.lastSpeechTime >= this.config.stopDurationMs) {
            this.status = VADStatus.Silence
            this.emit('stop-speaking', timestamp, energy)
          }
        }
        break
    }

    return this.status
  }

  /** Get the current VAD status. */
  getStatus(): VADStatus {
    return this.status
  }

  /** Check if VAD is currently detecting speech. */
  isSpeaking(): boolean {
    return this.status === VADStatus.Speaking
  }

  /** Reset the VAD state. */
  reset(): void {
    this.status = VADStatus.Silence
    this.maybeSpeakingStart = 0
    this.lastSpeechTime = 0
  }

  /** Subscribe to VAD events. Returns an unsubscribe function. */
  onEvent(listener: VADEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  /** Calculate RMS energy of audio samples. */
  private calculateRMS(samples: Float32Array): number {
    if (samples.length === 0) return 0
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i]! * samples[i]!
    }
    return Math.sqrt(sum / samples.length)
  }

  private emit(type: VADEventType, timestamp: number, confidence: number): void {
    const event: VADEvent = { type, timestamp, confidence }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Listener errors are non-fatal
      }
    }
  }
}
