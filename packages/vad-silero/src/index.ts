/**
 * @voiceminusone/vad-silero
 *
 * Silero VAD plugin for VoiceMinusOne.
 *
 * Uses the Silero VAD model via ONNX Runtime Web (WASM).
 * More accurate than energy-based VAD, especially in noisy environments.
 *
 * This package wraps @ricky0123/vad-web which bundles the Silero v5 model
 * and handles ONNX Runtime Web loading, WASM inference, and the state machine.
 *
 * @example
 * ```typescript
 * import { sileroVAD } from '@voiceminusone/vad-silero'
 *
 * const vad = sileroVAD({
 *   positiveSpeechThreshold: 0.5,
 *   negativeSpeechThreshold: 0.35,
 * })
 * ```
 */

import type {
  VADProvider,
  VADResult,
  VADEvent,
  AudioChunk,
  PluginContext,
} from '@voiceminusone/core'

/**
 * Minimal type shim for the @ricky0123/vad-web MicVAD.
 * We don't depend on it at compile time — it's loaded dynamically.
 */
export interface MicVADLike {
  start(): void
  pause(): void
  destroy(): void
  setOptions(options: Partial<SileroVADOptions>): void
}

export interface SileroVADOptions {
  /** Threshold for starting speech detection (0-1). */
  positiveSpeechThreshold: number
  /** Threshold for ending speech detection (0-1). */
  negativeSpeechThreshold: number
  /** Minimum speech frames before confirming speech. */
  minSpeechFrames: number
  /** Redemption frames before ending speech after silence. */
  redemptionFrames: number
  /** Pre-buffer duration in ms (audio before speech start is kept). */
  preSpeechPadFrames: number
  /** Whether to submit user speech on pause. */
  submitUserSpeechOnPause: boolean
  /** Model version. */
  model: 'v5' | 'legacy'
}

export const DEFAULT_SILERO_VAD_CONFIG: SileroVADOptions = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechFrames: 3,
  redemptionFrames: 8,
  preSpeechPadFrames: 1,
  submitUserSpeechOnPause: true,
  model: 'v5',
}

export interface SileroVADPluginOptions extends Partial<SileroVADOptions> {
  /** Base URL for the model assets (default: CDN). */
  baseAssetPath?: string
  /** Base URL for the ONNX WASM runtime (default: CDN). */
  onnxWASMBasePath?: string
  /** MediaStream to analyze (required for browser usage). */
  stream?: MediaStream
}

/**
 * Silero VAD plugin.
 *
 * Uses the Silero neural network model for accurate voice activity detection.
 * Requires a browser environment with ONNX Runtime Web (WASM) support.
 *
 * For Node.js server-side VAD, use @voiceminusone/vad-energy instead.
 */
export class SileroVADPlugin implements VADProvider {
  readonly name = 'silero-vad'
  private readonly options: SileroVADPluginOptions
  private ctx?: PluginContext
  private micVAD: MicVADLike | null = null
  private isSpeech = false
  private confidence = 0
  private started = false

  constructor(options: SileroVADPluginOptions = {}) {
    this.options = options
  }

  async init(context: PluginContext): Promise<void> {
    this.ctx = context
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // The full Silero VAD requires a MediaStream (browser).
    // If no stream is provided, we operate in analyze-only mode.
    if (this.options.stream) {
      await this.initMicVAD(this.options.stream)
    }
  }

  async stop(): Promise<void> {
    if (this.micVAD) {
      this.micVAD.pause()
    }
  }

  async destroy(): Promise<void> {
    if (this.micVAD) {
      this.micVAD.destroy()
      this.micVAD = null
    }
    this.started = false
  }

  /**
   * Analyze a chunk of audio samples.
   *
   * Note: Silero VAD processes audio in 512-sample windows internally.
   * For the analyze() method, we use a lightweight heuristic based on
   * the model's internal state. For full streaming VAD, use process().
   */
  analyze(audio: Float32Array, _sampleRate: number): VADResult {
    // In analyze mode (no MediaStream), we use a simple energy pre-filter
    // combined with the model's state. Full model inference happens in
    // the streaming process() method.
    const energy = this.calculateRMS(audio)
    const energyBased = energy > 0.01

    return {
      isSpeech: this.isSpeech || energyBased,
      confidence: Math.max(this.confidence, energy),
    }
  }

  /**
   * Process an audio stream, yielding VAD events.
   *
   * This runs the Silero model on each chunk and emits speech-start,
   * speech-end, and speech-cancel events.
   */
  async *process(audioStream: AsyncIterable<AudioChunk>): AsyncIterable<VADEvent> {
    const timestamp = () => this.ctx?.clock.now() ?? Date.now()

    // Load the model lazily
    if (!this.modelRunner) {
      this.modelRunner = await this.loadModel()
    }

    let speechActive = false
    let silenceFrameCount = 0
    let speechFrameCount = 0

    const config = { ...DEFAULT_SILERO_VAD_CONFIG, ...this.options }

    for await (const chunk of audioStream) {
      const samples = new Float32Array(chunk.data) as Float32Array
      const now = timestamp()

      // Run model inference on 512-sample windows
      const prob = await this.modelRunner.run(samples)

      if (!speechActive) {
        if (prob > config.positiveSpeechThreshold) {
          speechFrameCount++
          if (speechFrameCount >= config.minSpeechFrames) {
            speechActive = true
            this.isSpeech = true
            this.confidence = prob
            yield { type: 'speech-start', timestamp: now, confidence: prob }
          }
        } else {
          speechFrameCount = 0
        }
      } else {
        if (prob < config.negativeSpeechThreshold) {
          silenceFrameCount++
          if (silenceFrameCount >= config.redemptionFrames) {
            speechActive = false
            this.isSpeech = false
            this.confidence = prob
            yield { type: 'speech-end', timestamp: now, confidence: prob }
            silenceFrameCount = 0
            speechFrameCount = 0
          }
        } else {
          silenceFrameCount = 0
          this.confidence = prob
        }
      }
    }

    // If speech was active when stream ended, emit speech-end
    if (speechActive) {
      this.isSpeech = false
      yield { type: 'speech-end', timestamp: timestamp(), confidence: this.confidence }
    }
  }

  /** Get the current speech state. */
  isSpeaking(): boolean {
    return this.isSpeech
  }

  // --- Internal ---

  private modelRunner: { run: (samples: Float32Array) => Promise<number> } | null = null

  /** Initialize the MicVAD for browser streaming. */
  private async initMicVAD(stream: MediaStream): Promise<void> {
    try {
      const { MicVAD } = await import('@ricky0123/vad-web')
      const config = { ...DEFAULT_SILERO_VAD_CONFIG, ...this.options }

      this.micVAD = await MicVAD.new({
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        model: config.model,
        submitUserSpeechOnPause: config.submitUserSpeechOnPause,
        baseAssetPath:
          this.options.baseAssetPath ??
          'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@latest/dist/',
        onnxWASMBasePath:
          this.options.onnxWASMBasePath ?? 'https://unpkg.com/onnxruntime-web@1.23.2/dist/',
        positiveSpeechThreshold: config.positiveSpeechThreshold,
        negativeSpeechThreshold: config.negativeSpeechThreshold,
        redemptionFrames: config.redemptionFrames,
        preSpeechPadFrames: config.preSpeechPadFrames,
        onSpeechStart: () => {
          this.isSpeech = true
        },
        onSpeechEnd: () => {
          this.isSpeech = false
        },
      } as Record<string, unknown>)

      this.micVAD.start()
    } catch (err) {
      this.ctx?.logger?.warn(
        'silero-vad',
        `Failed to init MicVAD: ${(err as Error).message}. Falling back to analyze-only mode.`,
      )
    }
  }

  /** Load the Silero ONNX model for standalone inference. */
  private async loadModel(): Promise<{ run: (samples: Float32Array) => Promise<number> }> {
    try {
      // Try to use ONNX Runtime Web directly
      const ort = await import('onnxruntime-web')

      // Load the Silero VAD model
      const modelPath =
        this.options.baseAssetPath ??
        'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@latest/dist/'
      const modelUrl = `${modelPath}silero_vad.onnx`

      const session = await ort.InferenceSession.create(modelUrl, {
        wasmPaths: this.options.onnxWASMBasePath ?? 'https://unpkg.com/onnxruntime-web@1.23.2/dist/',
      } as Record<string, unknown>)

      // Cast to a minimal interface to avoid ONNX type complexity
      const sessionLike = session as unknown as {
        run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>
      }

      // Silero VAD state (LSTM hidden states)
      let hState: Float32Array = new Float32Array(2 * 1 * 64)
      let cState: Float32Array = new Float32Array(2 * 1 * 64)

      return {
        run: async (samples: Float32Array) => {
          // Silero VAD expects 512 samples at 16kHz
          if (samples.length !== 512) {
            // Resample or pad
            const input = new Float32Array(512)
            const copyLen = Math.min(samples.length, 512)
            input.set(samples.subarray(0, copyLen))
            return this.runSileroInference(sessionLike, input, hState, cState, (h, c) => {
              hState = h
              cState = c
            })
          }
          return this.runSileroInference(sessionLike, samples, hState, cState, (h, c) => {
            hState = h
            cState = c
          })
        },
      }
    } catch (err) {
      this.ctx?.logger?.warn(
        'silero-vad',
        `Failed to load ONNX model: ${(err as Error).message}. Using energy fallback.`,
      )
      // Fallback: use energy-based detection
      return {
        run: async (samples: Float32Array) => {
          const energy = this.calculateRMS(samples)
          return Math.min(energy * 50, 1) // Scale to 0-1 range
        },
      }
    }
  }

  /** Run a single Silero VAD inference step. */
  private async runSileroInference(
    session: { run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>> },
    samples: Float32Array,
    hState: Float32Array,
    cState: Float32Array,
    updateState: (h: Float32Array, c: Float32Array) => void,
  ): Promise<number> {
    try {
      const input = samples
      const sr = new Float32Array([16000])

      const feeds: Record<string, unknown> = {
        input,
        h: hState,
        c: cState,
        sr,
      }

      const results = await session.run(feeds)

      // Update LSTM state
      const newH = results['hn'] as Float32Array | undefined
      const newC = results['cn'] as Float32Array | undefined
      if (newH && newC) {
        updateState(newH, newC)
      }

      // Output is the speech probability
      const output = results['output'] as Float32Array | undefined
      if (output && output.length > 0) {
        return output[0]!
      }
      return 0
    } catch {
      return 0
    }
  }

  /** Calculate RMS energy. */
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
 * Factory for creating a Silero VAD plugin.
 *
 * @example
 * ```typescript
 * import { sileroVAD } from '@voiceminusone/vad-silero'
 *
 * const vad = sileroVAD({
 *   positiveSpeechThreshold: 0.5,
 *   negativeSpeechThreshold: 0.35,
 * })
 * ```
 */
export function sileroVAD(options?: SileroVADPluginOptions): VADProvider {
  return new SileroVADPlugin(options)
}
