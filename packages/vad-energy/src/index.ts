/**
 * @voiceminusone/vad-energy
 *
 * Energy-based Voice Activity Detection plugin for VoiceMinusOne.
 *
 * Zero-dependency VAD using RMS energy calculation. Suitable as a fallback
 * when Silero VAD (ONNX Runtime Web) is not available.
 *
 * Three-phase state machine (inspired by micdrop):
 *   Silence → MaybeSpeaking → Speaking → (Confirm | Cancel) → Stop
 *
 * @example
 * ```typescript
 * import { energyVAD } from '@voiceminusone/vad-energy'
 *
 * const vad = energyVAD({ energyThreshold: 0.015 })
 * const result = vad.analyze(samples, 16000)
 * ```
 */

import type {
  VADProvider,
  VADResult,
  VADEvent,
  AudioChunk,
  PluginContext,
} from '@voiceminusone/core'

export interface EnergyVADConfig {
  /** Energy threshold for speech detection (0-1). */
  energyThreshold: number
  /** Duration of speech needed to confirm speaking (ms). */
  confirmDurationMs: number
  /** Duration of silence needed to stop speaking (ms). */
  stopDurationMs: number
  /** Duration of silence to cancel a maybe-speaking (ms). */
  cancelDurationMs: number
}

export const DEFAULT_ENERGY_VAD_CONFIG: EnergyVADConfig = {
  energyThreshold: 0.015,
  confirmDurationMs: 80,
  stopDurationMs: 500,
  cancelDurationMs: 200,
}

/** VAD state. */
export type EnergyVADState = 'silence' | 'maybe-speaking' | 'speaking'

/**
 * Energy-based VAD using RMS energy calculation.
 *
 * Pure TypeScript — no ONNX runtime, no WASM.
 * Implements the VADProvider interface from @voiceminusone/core.
 */
export class EnergyVADPlugin implements VADProvider {
  readonly name = 'energy-vad'
  private config: EnergyVADConfig
  private state: EnergyVADState = 'silence'
  private maybeSpeakingStart = 0
  private lastSpeechTime = 0
  private ctx?: PluginContext

  constructor(config: Partial<EnergyVADConfig> = {}) {
    this.config = { ...DEFAULT_ENERGY_VAD_CONFIG, ...config }
  }

  async init(context: PluginContext): Promise<void> {
    this.ctx = context
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async destroy(): Promise<void> {}

  /**
   * Analyze a chunk of audio samples.
   * Returns whether speech is detected and a confidence value.
   */
  analyze(audio: Float32Array, _sampleRate: number): VADResult {
    const energy = this.calculateRMS(audio)
    const isSpeech = energy > this.config.energyThreshold
    const timestamp = this.ctx?.clock.now() ?? Date.now()

    switch (this.state) {
      case 'silence':
        if (isSpeech) {
          this.state = 'maybe-speaking'
          this.maybeSpeakingStart = timestamp
        }
        break

      case 'maybe-speaking':
        if (isSpeech) {
          if (timestamp - this.maybeSpeakingStart >= this.config.confirmDurationMs) {
            this.state = 'speaking'
            this.lastSpeechTime = timestamp
          }
        } else {
          if (timestamp - this.maybeSpeakingStart >= this.config.cancelDurationMs) {
            this.state = 'silence'
          }
        }
        break

      case 'speaking':
        if (isSpeech) {
          this.lastSpeechTime = timestamp
        } else {
          if (timestamp - this.lastSpeechTime >= this.config.stopDurationMs) {
            this.state = 'silence'
          }
        }
        break
    }

    return {
      isSpeech: this.state === 'speaking',
      confidence: Math.min(energy / (this.config.energyThreshold * 3), 1),
    }
  }

  /**
   * Process an audio stream, yielding VAD events.
   */
  async *process(audioStream: AsyncIterable<AudioChunk>): AsyncIterable<VADEvent> {
    const timestamp = () => this.ctx?.clock.now() ?? Date.now()

    for await (const chunk of audioStream) {
      const samples = new Float32Array(chunk.data)
      const energy = this.calculateRMS(samples)
      const isSpeech = energy > this.config.energyThreshold
      const now = timestamp()

      const prevState = this.state

      switch (this.state) {
        case 'silence':
          if (isSpeech) {
            this.state = 'maybe-speaking'
            this.maybeSpeakingStart = now
            yield { type: 'speech-start', timestamp: now, confidence: energy }
          }
          break

        case 'maybe-speaking':
          if (isSpeech) {
            if (now - this.maybeSpeakingStart >= this.config.confirmDurationMs) {
              this.state = 'speaking'
              this.lastSpeechTime = now
            }
          } else {
            if (now - this.maybeSpeakingStart >= this.config.cancelDurationMs) {
              this.state = 'silence'
              yield { type: 'speech-cancel', timestamp: now, confidence: energy }
            }
          }
          break

        case 'speaking':
          if (isSpeech) {
            this.lastSpeechTime = now
          } else {
            if (now - this.lastSpeechTime >= this.config.stopDurationMs) {
              this.state = 'silence'
              yield { type: 'speech-end', timestamp: now, confidence: energy }
            }
          }
          break
      }

      // Track state transitions for event emission
      void prevState
    }
  }

  /** Get the current VAD state. */
  getState(): EnergyVADState {
    return this.state
  }

  /** Reset the VAD state. */
  reset(): void {
    this.state = 'silence'
    this.maybeSpeakingStart = 0
    this.lastSpeechTime = 0
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
}

/**
 * Factory for creating an energy-based VAD plugin.
 *
 * @example
 * ```typescript
 * import { energyVAD } from '@voiceminusone/vad-energy'
 *
 * const vad = energyVAD({ energyThreshold: 0.02 })
 * ```
 */
export function energyVAD(config?: Partial<EnergyVADConfig>): VADProvider {
  return new EnergyVADPlugin(config)
}
