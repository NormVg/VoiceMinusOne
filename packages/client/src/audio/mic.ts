/**
 * Mic — microphone capture with Silero VAD.
 *
 * Uses @ricky0123/vad-web which runs the Silero v5 neural network
 * model via ONNX Runtime Web (WASM) directly in the browser.
 *
 * The VAD handles:
 * - Mic capture at 16kHz mono
 * - Speech detection (start/end)
 * - Audio chunk emission (only during speech)
 *
 * Audio is emitted as raw 16-bit PCM ArrayBuffer at 16kHz.
 */

// Type shim for @ricky0123/vad-web — loaded dynamically in browser
interface MicVADLike {
  start(): void
  pause(): void
  destroy(): void
}

interface MicVADOptions {
  positiveSpeechThreshold: number
  negativeSpeechThreshold: number
  preSpeechPadFrames: number
  redemptionFrames: number
  minSpeechFrames: number
  submitUserSpeechOnPause: boolean
  baseAssetPath: string
  onnxWASMBasePath: string
  stream: MediaStream
  onSpeechStart: () => void
  onSpeechEnd: (audio: Float32Array) => void
  onVADMisfire: () => void
}

export interface MicConfig {
  readonly sampleRate: number
  readonly channelCount: number
  readonly echoCancellation: boolean
  readonly noiseSuppression: boolean
  readonly autoGainControl: boolean
  /** Silero VAD speech start threshold (0-1, default 0.5) */
  readonly positiveSpeechThreshold: number
  /** Silero VAD speech end threshold (0-1, default 0.35) */
  readonly negativeSpeechThreshold: number
  /** Pre-speech padding in frames (default 1) */
  readonly preSpeechPadFrames: number
  /** Redemption frames before ending speech (default 8) */
  readonly redemptionFrames: number
  /** Min speech frames before confirming speech (default 3) */
  readonly minSpeechFrames: number
}

export const DEFAULT_MIC_CONFIG: MicConfig = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  preSpeechPadFrames: 1,
  redemptionFrames: 8,
  minSpeechFrames: 3,
}

export type AudioChunkListener = (chunk: ArrayBuffer) => void
export type MicStateListener = (state: MicState) => void

export interface MicState {
  readonly started: boolean
  readonly muted: boolean
  readonly speaking: boolean
  readonly error?: string
}

export class Mic {
  private config: MicConfig
  private micVAD: MicVADLike | null = null
  private mediaStream: MediaStream | null = null

  private started = false
  private muted = false
  private speaking = false

  private chunkListeners: AudioChunkListener[] = []
  private stateListeners: MicStateListener[] = []

  constructor(config: Partial<MicConfig> = {}) {
    this.config = { ...DEFAULT_MIC_CONFIG, ...config }
  }

  /** Start the microphone with Silero VAD. Requires user gesture. */
  async start(): Promise<void> {
    if (this.started) return

    // Get microphone stream
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: this.config.channelCount,
        echoCancellation: this.config.echoCancellation,
        noiseSuppression: this.config.noiseSuppression,
        autoGainControl: this.config.autoGainControl,
      },
    })

    // Dynamically import @ricky0123/vad-web (browser-only)
    const vadModule = (await import('@ricky0123/vad-web')) as unknown as {
      MicVAD: { new: (opts: Partial<MicVADOptions>) => Promise<MicVADLike> }
    }

    this.micVAD = await vadModule.MicVAD.new({
      positiveSpeechThreshold: this.config.positiveSpeechThreshold,
      negativeSpeechThreshold: this.config.negativeSpeechThreshold,
      preSpeechPadFrames: this.config.preSpeechPadFrames,
      redemptionFrames: this.config.redemptionFrames,
      minSpeechFrames: this.config.minSpeechFrames,
      submitUserSpeechOnPause: true,
      // Use the exact installed versions — CDN version mismatches cause
      // "t.getValue is not a function" (WASM/JS API mismatch)
      baseAssetPath: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/',
      onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
      stream: this.mediaStream,
      onSpeechStart: () => {
        this.speaking = true
        this.notifyState()
      },
      onSpeechEnd: (audio: Float32Array) => {
        this.speaking = false
        // Convert Float32 samples to 16-bit PCM ArrayBuffer
        const pcm = this.float32ToInt16(audio)
        this.emitChunk(pcm.buffer as ArrayBuffer)
        this.notifyState()
      },
      onVADMisfire: () => {
        // False alarm — no speech to emit
      },
    })

    this.micVAD.start()
    this.started = true
    this.notifyState()
  }

  /** Stop the microphone. */
  stop(): void {
    if (this.micVAD) {
      this.micVAD.pause()
      this.micVAD.destroy()
      this.micVAD = null
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop()
      }
      this.mediaStream = null
    }

    this.started = false
    this.speaking = false
    this.notifyState()
  }

  /** Mute/unmute the microphone. */
  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.enabled = !muted
      }
    }
    this.notifyState()
  }

  /** Subscribe to audio chunks. Returns an unsubscribe function. */
  onChunk(listener: AudioChunkListener): () => void {
    this.chunkListeners.push(listener)
    return () => {
      const idx = this.chunkListeners.indexOf(listener)
      if (idx >= 0) this.chunkListeners.splice(idx, 1)
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: MicStateListener): () => void {
    this.stateListeners.push(listener)
    return () => {
      const idx = this.stateListeners.indexOf(listener)
      if (idx >= 0) this.stateListeners.splice(idx, 1)
    }
  }

  /** Get the current mic state. */
  getState(): MicState {
    return {
      started: this.started,
      muted: this.muted,
      speaking: this.speaking,
    }
  }

  /** Convert Float32 audio samples to 16-bit PCM. */
  private float32ToInt16(samples: Float32Array): Int16Array {
    const pcm = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]!))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return pcm
  }

  /** Emit a chunk to all listeners. */
  private emitChunk(chunk: ArrayBuffer): void {
    for (const listener of this.chunkListeners) {
      try {
        listener(chunk)
      } catch {
        // Listener errors are non-fatal
      }
    }
  }

  /** Notify state listeners. */
  private notifyState(): void {
    const state = this.getState()
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // Listener errors are non-fatal
      }
    }
  }
}
