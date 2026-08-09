/**
 * Mic — microphone capture using AudioWorklet (never ScriptProcessorNode).
 *
 * Per R-011: Never use ScriptProcessorNode. Always use AudioWorkletNode.
 *
 * Captures audio at 16kHz mono 16-bit PCM, emitting chunks every 100ms.
 * VAD-gated: only captures when VAD detects speech.
 *
 * The AudioWorklet processor code is generated as a string and loaded
 * via a Blob URL — this avoids needing a separate .js file for the
 * worklet processor.
 */

import { EnergyVAD } from '../vad/energy-vad'
import type { VADConfig, VADEvent } from '../vad/energy-vad'

export interface MicConfig {
  readonly sampleRate: number
  readonly channelCount: number
  readonly echoCancellation: boolean
  readonly noiseSuppression: boolean
  readonly autoGainControl: boolean
  readonly chunkDurationMs: number
  readonly vadConfig?: Partial<VADConfig>
}

export const DEFAULT_MIC_CONFIG: MicConfig = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  chunkDurationMs: 100,
}

export type AudioChunkListener = (chunk: ArrayBuffer) => void
export type MicStateListener = (state: MicState) => void

export interface MicState {
  readonly started: boolean
  readonly muted: boolean
  readonly speaking: boolean
  readonly error?: string
}

/** PCM processor worklet code — runs in a separate audio thread. */
const PCM_PROCESSOR_WORKLET = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = []
    this.targetSampleRate = ${DEFAULT_MIC_CONFIG.sampleRate}
    this.chunkSamples = Math.floor(this.targetSampleRate * (${DEFAULT_MIC_CONFIG.chunkDurationMs} / 1000))
    this.processing = false
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    if (!this.processing) return true

    const channel = input[0]
    if (!channel) return true

    // Resample from device sample rate to target sample rate
    const deviceRate = sampleRate
    const ratio = this.targetSampleRate / deviceRate
    const resampledLength = Math.floor(channel.length * ratio)

    for (let i = 0; i < resampledLength; i++) {
      const sourceIdx = Math.floor(i / ratio)
      const sample = channel[sourceIdx] || 0
      this.buffer.push(sample)
    }

    // Emit chunks when buffer reaches chunk size
    while (this.buffer.length >= this.chunkSamples) {
      const chunk = this.buffer.splice(0, this.chunkSamples)
      const pcm = new Int16Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }

    return true
  }
}
registerProcessor('pcm-processor', PcmProcessor)
`

export class Mic {
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private workletNode: AudioWorkletNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private vad: EnergyVAD
  private config: MicConfig

  private started = false
  private muted = false
  private speaking = false
  private processing = false

  private chunkListeners: AudioChunkListener[] = []
  private stateListeners: MicStateListener[] = []
  private vadUnsub: (() => void) | null = null

  /** Queued chunks before VAD confirms speech. */
  private queuedChunks: ArrayBuffer[] = []

  constructor(config: Partial<MicConfig> = {}) {
    this.config = { ...DEFAULT_MIC_CONFIG, ...config }
    this.vad = new EnergyVAD(this.config.vadConfig)
  }

  /** Start the microphone. Requires user gesture (browser security). */
  async start(): Promise<void> {
    if (this.started) return

    // Create AudioContext
    const AudioContextClass =
      globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.audioContext = new AudioContextClass({ sampleRate: 48000 })

    // Load the PCM processor worklet
    const blob = new Blob([PCM_PROCESSOR_WORKLET], { type: 'application/javascript' })
    const workletUrl = URL.createObjectURL(blob)
    await this.audioContext.audioWorklet.addModule(workletUrl)
    URL.revokeObjectURL(workletUrl)

    // Get microphone stream
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: this.config.sampleRate,
        channelCount: this.config.channelCount,
        echoCancellation: this.config.echoCancellation,
        noiseSuppression: this.config.noiseSuppression,
        autoGainControl: this.config.autoGainControl,
      },
    })

    // Create source node
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream)

    // Create worklet node
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor')
    this.sourceNode.connect(this.workletNode)

    // Listen for PCM chunks from the worklet
    this.workletNode.port.onmessage = (event: MessageEvent) => {
      this.handlePcmChunk(event.data as ArrayBuffer)
    }

    // Subscribe to VAD events
    this.vadUnsub = this.vad.onEvent((vadEvent) => this.handleVADEvent(vadEvent))

    this.started = true
    this.processing = true
    this.notifyState()
  }

  /** Stop the microphone. */
  stop(): void {
    this.processing = false
    this.vad.reset()

    if (this.vadUnsub) {
      this.vadUnsub()
      this.vadUnsub = null
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop()
      }
      this.mediaStream = null
    }

    if (this.audioContext) {
      void this.audioContext.close()
      this.audioContext = null
    }

    this.started = false
    this.speaking = false
    this.queuedChunks = []
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

  /** Get the current VAD instance. */
  getVAD(): EnergyVAD {
    return this.vad
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

  /** Handle a PCM chunk from the AudioWorklet. */
  private handlePcmChunk(chunk: ArrayBuffer): void {
    if (!this.processing || this.muted) return

    // Feed to VAD
    const samples = new Float32Array(chunk.byteLength / 2)
    const view = new DataView(chunk)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 0x8000
    }
    this.vad.process(samples, Date.now())

    // Queue chunks until VAD confirms speech
    if (this.speaking) {
      // Flush any queued chunks first
      for (const queued of this.queuedChunks) {
        this.emitChunk(queued)
      }
      this.queuedChunks = []
      this.emitChunk(chunk)
    } else {
      // Queue the chunk (will be emitted on confirm, discarded on cancel)
      this.queuedChunks.push(chunk)
    }
  }

  /** Handle a VAD event. */
  private handleVADEvent(event: VADEvent): void {
    switch (event.type) {
      case 'start-speaking':
        // VAD detected possible speech — start queuing
        break
      case 'confirm-speaking':
        // Speech confirmed — emit queued chunks
        this.speaking = true
        for (const queued of this.queuedChunks) {
          this.emitChunk(queued)
        }
        this.queuedChunks = []
        this.notifyState()
        break
      case 'cancel-speaking':
        // False alarm — discard queued chunks
        this.queuedChunks = []
        break
      case 'stop-speaking':
        // Speech ended
        this.speaking = false
        this.notifyState()
        break
    }
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
