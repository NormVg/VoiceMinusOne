/**
 * AudioRouter — routes audio between transport, STT, and TTS.
 *
 * Focused component that handles:
 * - Receiving audio from transport → feeding to STT
 * - Receiving TTS audio → sending to transport
 * - Managing audio stream lifecycle (open/close STT streams)
 * - Chunking and format conversion
 *
 * Per R-012: No god classes. This is separate from state, turn, and history.
 */

import type {
  Transport,
  STTProvider,
  TTSProvider,
  AudioChunk,
  TranscriptResult,
  STTConfig,
  TTSConfig,
  Logger,
} from '@voiceminusone/core'
import { SilentLogger } from '@voiceminusone/core'
import { decodeAudioEnvelope } from '@voiceminusone/core'

export interface AudioRouterOptions {
  readonly transport: Transport
  readonly stt: STTProvider
  readonly tts: TTSProvider
  readonly sttConfig?: STTConfig
  readonly ttsConfig?: TTSConfig
  readonly sampleRate?: number
}

export type TranscriptHandler = (result: TranscriptResult) => void
export type TTSChunkHandler = (chunk: ArrayBuffer) => void
export type InputAudioHandler = (chunk: AudioChunk) => void | Promise<void>

export class AudioRouter {
  private logger: Logger = new SilentLogger()
  private opts: AudioRouterOptions

  /** Active STT audio queue — chunks are pushed here, STT drains them. */
  private sttChunkQueue: AudioChunk[] = []
  private sttActive = false
  private inputEpoch = -1
  private inputSequence = -1

  private transcriptHandlers: TranscriptHandler[] = []
  private ttsChunkHandlers: TTSChunkHandler[] = []
  private inputAudioHandlers: InputAudioHandler[] = []

  private transportAudioUnsub: (() => void) | null = null

  constructor(opts: AudioRouterOptions) {
    this.opts = opts
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  /** Start receiving audio from transport and feeding to STT. */
  async startListening(): Promise<void> {
    if (this.sttActive) return
    this.sttActive = true
    this.sttChunkQueue = []

    // Subscribe to transport audio
    this.transportAudioUnsub = this.opts.transport.onAudio((chunk) => {
      this.handleIncomingAudio(chunk)
    })

    this.logger.debug('audio-router', 'Started listening for audio')
  }

  /** Drain buffered audio chunks (for session to feed to STT). */
  drainAudio(): AudioChunk[] {
    const chunks = this.sttChunkQueue
    this.sttChunkQueue = []
    return chunks
  }

  /** Stop receiving audio. STT stream will be flushed. */
  async stopListening(): Promise<void> {
    if (!this.sttActive) return
    this.sttActive = false

    if (this.transportAudioUnsub) {
      this.transportAudioUnsub()
      this.transportAudioUnsub = null
    }

    this.logger.debug('audio-router', 'Stopped listening for audio')
  }

  /**
   * Transcribe a stream of audio chunks.
   * Returns an async iterable of transcript results.
   */
  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    config?: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    const sttConfig = config ?? this.opts.sttConfig ?? {}
    for await (const result of this.opts.stt.transcribe(audio, sttConfig)) {
      this.notifyTranscript(result)
      yield result
    }
  }

  /**
   * Synthesize text to speech and yield audio chunks.
   * Used for streaming: each sentence is synthesized independently.
   */
  async *synthesizeChunks(
    text: string,
    config?: TTSConfig,
  ): AsyncIterable<AudioChunk> {
    const ttsConfig = config ?? this.opts.ttsConfig ?? {}
    for await (const chunk of this.opts.tts.synthesize(text, ttsConfig)) {
      yield chunk
    }
  }

  /**
   * Synthesize text to speech and send audio chunks to transport.
   * Uses the serial TTS queue from TurnManager (caller enqueues).
   */
  async synthesizeAndSend(text: string, config?: TTSConfig): Promise<void> {
    const ttsConfig = config ?? this.opts.ttsConfig ?? {}
    const transport = this.opts.transport

    for await (const chunk of this.opts.tts.synthesize(text, ttsConfig)) {
      // Send raw binary — never base64 (R-010)
      transport.sendAudio(chunk.data)
      this.notifyTTSChunk(chunk.data)
    }
  }

  /** Subscribe to transcript results. */
  onTranscript(handler: TranscriptHandler): () => void {
    this.transcriptHandlers.push(handler)
    return () => {
      const idx = this.transcriptHandlers.indexOf(handler)
      if (idx >= 0) this.transcriptHandlers.splice(idx, 1)
    }
  }

  /** Subscribe to TTS audio chunks. */
  onTTSChunk(handler: TTSChunkHandler): () => void {
    this.ttsChunkHandlers.push(handler)
    return () => {
      const idx = this.ttsChunkHandlers.indexOf(handler)
      if (idx >= 0) this.ttsChunkHandlers.splice(idx, 1)
    }
  }

  /** Observe each incoming PCM frame for live STT streaming. */
  onInputAudio(handler: InputAudioHandler): () => void {
    this.inputAudioHandlers.push(handler)
    return () => {
      const idx = this.inputAudioHandlers.indexOf(handler)
      if (idx >= 0) this.inputAudioHandlers.splice(idx, 1)
    }
  }

  /** Abort any in-flight STT/TTS operations. */
  abort(): void {
    this.opts.stt.abort?.()
    this.opts.tts.abort?.()
    this.sttChunkQueue = []
    this.sttActive = false
  }

  /** Clean up all resources. */
  async destroy(): Promise<void> {
    await this.stopListening()
    this.transcriptHandlers = []
    this.ttsChunkHandlers = []
  }

  private handleIncomingAudio(chunk: ArrayBuffer): void {
    if (!this.sttActive) return

    const envelope = decodeAudioEnvelope(chunk)
    if (envelope) {
      if (envelope.epoch < this.inputEpoch ||
        (envelope.epoch === this.inputEpoch && envelope.sequence <= this.inputSequence)) {
        this.logger.debug('audio-router', `Dropped stale audio frame ${envelope.epoch}:${envelope.sequence}`)
        return
      }
      this.inputEpoch = envelope.epoch
      this.inputSequence = envelope.sequence
      chunk = envelope.payload
    }

    const audioChunk: AudioChunk = {
      data: chunk,
      sampleRate: this.opts.sampleRate ?? 16000,
      numChannels: 1,
    }
    this.sttChunkQueue.push(audioChunk)
    for (const handler of this.inputAudioHandlers) {
      Promise.resolve(handler(audioChunk)).catch((error: unknown) => {
        this.logger.error('audio-router', `Input audio handler error: ${(error as Error).message}`)
      })
    }
  }

  private notifyTranscript(result: TranscriptResult): void {
    for (const handler of this.transcriptHandlers) {
      try {
        handler(result)
      } catch (error) {
        this.logger.error('audio-router', `Transcript handler error: ${(error as Error).message}`)
      }
    }
  }

  private notifyTTSChunk(chunk: ArrayBuffer): void {
    for (const handler of this.ttsChunkHandlers) {
      try {
        handler(chunk)
      } catch (error) {
        this.logger.error('audio-router', `TTS chunk handler error: ${(error as Error).message}`)
      }
    }
  }
}
