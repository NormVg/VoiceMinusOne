/**
 * Speaker — prebuffered gapless audio playback.
 *
 * Inspired by micdrop's Pcm16AudioStream:
 * - Waits for 100ms of audio before starting playback (prebuffering)
 *   to avoid underruns from providers that send a burst then pause
 * - Schedules AudioBufferSourceNodes gaplessly using nextStartTime
 * - Quiet flush: if no chunk arrives for 600ms during prebuffering, starts anyway
 *
 * Per R-011: Uses Web Audio API (AudioBufferSourceNode), never ScriptProcessorNode.
 */

export interface SpeakerConfig {
  readonly sampleRate: number
  readonly numChannels: number
  readonly prebufferDurationMs: number
  readonly quietFlushDelayMs: number
}

export const DEFAULT_SPEAKER_CONFIG: SpeakerConfig = {
  sampleRate: 22050,
  numChannels: 1,
  prebufferDurationMs: 100,
  quietFlushDelayMs: 600,
}

export type SpeakerStateListener = (state: SpeakerState) => void

export interface SpeakerState {
  readonly playing: boolean
  readonly error?: string
}

export class Speaker {
  private audioContext: AudioContext | null = null
  private config: SpeakerConfig
  private prebuffer: AudioBuffer[] = []
  private prebufferDuration = 0
  private prebuffering = false
  private nextStartTime = 0
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private playing = false
  private stateListeners: SpeakerStateListener[] = []

  constructor(config: Partial<SpeakerConfig> = {}) {
    this.config = { ...DEFAULT_SPEAKER_CONFIG, ...config }
  }

  /** Initialize the speaker (must be called from a user gesture). */
  async init(): Promise<void> {
    const AudioContextClass =
      globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.audioContext = new AudioContextClass()
    this.prebuffering = true
    this.prebuffer = []
    this.prebufferDuration = 0
    this.nextStartTime = 0
  }

  /** Feed a PCM audio chunk for playback. */
  feed(pcm: ArrayBuffer): void {
    if (!this.audioContext) return

    const audioBuffer = this.pcmToAudioBuffer(pcm)
    if (!audioBuffer) return

    if (this.prebuffering) {
      this.prebuffer.push(audioBuffer)
      this.prebufferDuration += audioBuffer.duration * 1000

      if (this.prebufferDuration >= this.config.prebufferDurationMs) {
        this.flushPrebuffer()
        return
      }

      // Set quiet flush timer (handles short utterances)
      if (this.quietTimer) clearTimeout(this.quietTimer)
      this.quietTimer = setTimeout(
        () => this.flushPrebuffer(),
        this.config.quietFlushDelayMs,
      )
    } else {
      this.scheduleBuffer(audioBuffer)
    }
  }

  /** Flush the prebuffer and start playback. */
  private flushPrebuffer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer)
      this.quietTimer = null
    }

    this.prebuffering = false
    this.playing = true
    this.notifyState()

    for (const buffer of this.prebuffer) {
      this.scheduleBuffer(buffer)
    }
    this.prebuffer = []
    this.prebufferDuration = 0
  }

  /** Schedule an audio buffer for gapless playback. */
  private scheduleBuffer(audioBuffer: AudioBuffer): void {
    if (!this.audioContext) return

    const source = this.audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.audioContext.destination)

    const now = this.audioContext.currentTime
    const startTime = Math.max(this.nextStartTime, now)
    source.start(startTime)

    this.nextStartTime = startTime + audioBuffer.duration

    source.onended = () => {
      // Check if playback has ended
      if (this.nextStartTime <= this.audioContext!.currentTime + 0.01) {
        this.playing = false
        this.notifyState()
      }
    }
  }

  /** Convert raw PCM16 to an AudioBuffer. */
  private pcmToAudioBuffer(pcm: ArrayBuffer): AudioBuffer | null {
    if (!this.audioContext) return null

    const view = new DataView(pcm)
    const numSamples = pcm.byteLength / 2 // 16-bit = 2 bytes per sample
    const audioBuffer = this.audioContext.createBuffer(
      this.config.numChannels,
      numSamples,
      this.config.sampleRate,
    )

    for (let channel = 0; channel < this.config.numChannels; channel++) {
      const channelData = audioBuffer.getChannelData(channel)
      for (let i = 0; i < numSamples; i++) {
        channelData[i] = view.getInt16(i * 2, true) / 0x8000
      }
    }

    return audioBuffer
  }

  /** Stop all playback and reset. */
  stop(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer)
      this.quietTimer = null
    }
    this.prebuffer = []
    this.prebufferDuration = 0
    this.prebuffering = true
    this.playing = false
    this.nextStartTime = 0
    this.notifyState()
  }

  /** Destroy the speaker and release resources. */
  destroy(): void {
    this.stop()
    if (this.audioContext) {
      void this.audioContext.close()
      this.audioContext = null
    }
    this.stateListeners = []
  }

  /** Get the current state. */
  getState(): SpeakerState {
    return { playing: this.playing }
  }

  /** Subscribe to state changes. */
  onStateChange(listener: SpeakerStateListener): () => void {
    this.stateListeners.push(listener)
    return () => {
      const idx = this.stateListeners.indexOf(listener)
      if (idx >= 0) this.stateListeners.splice(idx, 1)
    }
  }

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
