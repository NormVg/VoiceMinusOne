/**
 * SessionManager — coordinates the focused session components.
 *
 * This is NOT a god class. It delegates to:
 * - SessionStateMachine (state transitions)
 * - TurnManager (turn-taking, interruption, TTS queue)
 * - AudioRouter (audio routing between transport/STT/TTS)
 * - HistoryManager (conversation messages)
 *
 * The SessionManager wires these together and handles the
 * transport event → pipeline → response flow.
 */

import {
  SessionState,
  type SessionConfig,
  type Logger,
  type Transport,
  type STTProvider,
  type STTStream,
  type TTSProvider,
  type Brain,
  type AudioChunk,
  type TranscriptResult,
  type ConversationMessage,
  type Clock,
  ConsoleLogger,
  LogLevel,
  clock,
} from '@voiceminusone/core'
import { SessionStateMachine } from './state-machine'
import { TurnManager } from './turn-manager'
import { AudioRouter } from './audio-router'
import { HistoryManager } from './history-manager'
import { SentenceChunker } from './sentence-chunker'
import {
  parseClientEvent,
  serializeServerEvent,
  type ServerToClientEvent,
  type ClientToServerEvent,
} from '../wire/protocol'

export interface SessionManagerOptions extends SessionConfig {
  readonly logger?: Logger
  readonly sessionId?: string
  readonly clock?: Clock
}

export class SessionManager {
  readonly sessionId: string
  private logger: Logger
  private stateMachine: SessionStateMachine
  private turnManager: TurnManager
  private audioRouter: AudioRouter
  private history: HistoryManager
  private transport: Transport
  private stt: STTProvider
  private tts: TTSProvider
  private brain: Brain
  private clock: Clock
  private destroyed = false
  private liveSttStream: STTStream | null = null
  private liveSttResults: TranscriptResult[] = []
  private liveSttResultTask: Promise<void> | null = null
  private liveSttAbort: AbortController | null = null
  private inputAudioUnsub: (() => void) | null = null

  constructor(opts: SessionManagerOptions) {
    this.clock = opts.clock ?? clock
    this.sessionId = opts.sessionId ?? `session-${this.clock.now()}`
    this.logger = opts.logger ?? new ConsoleLogger(LogLevel.Info)
    this.transport = opts.transport
    this.stt = opts.stt
    this.tts = opts.tts
    this.brain = opts.brain

    this.stateMachine = new SessionStateMachine()
    this.turnManager = new TurnManager()
    this.audioRouter = new AudioRouter({
      transport: this.transport,
      stt: this.stt,
      tts: this.tts,
      sttConfig: {},
      ttsConfig: {},
      sampleRate: opts.sampleRate ?? 16000,
    })
    this.history = new HistoryManager()

    // Inject logger into all components
    const childLogger = this.logger.child('session')
    this.stateMachine.setLogger(childLogger)
    this.turnManager.setLogger(childLogger)
    this.audioRouter.setLogger(childLogger)
  }

  /** Initialize and start the session. */
  async start(): Promise<void> {
    if (this.destroyed) throw new Error('Session already destroyed')
    this.logger.info('session', `Starting session ${this.sessionId}`)

    // Connect transport
    await this.transport.connect(this.sessionId)
    this.stateMachine.transition(SessionState.Connected)

    // Initialize plugins
    const ctx = {
      logger: this.logger.child('plugin'),
      events: { on: () => () => {}, once: () => () => {}, emit: () => {}, off: () => {}, clear: () => {} },
      clock: this.clock,
      signal: new AbortController().signal,
    }
    await this.stt.init?.(ctx)
    await this.tts.init?.(ctx)
    await this.stt.start?.()
    await this.tts.start?.()

    // Start listening for transport events
    this.transport.onEvent((event) => this.handleTransportEvent(event))

    // Start listening for audio
    await this.audioRouter.startListening()
    this.inputAudioUnsub = this.audioRouter.onInputAudio((chunk) => this.writeLiveStt(chunk))
    this.stateMachine.transition(SessionState.Listening)

    this.sendEvent({ type: 'state', state: this.stateMachine.state })
    this.logger.info('session', `Session ${this.sessionId} started`)
  }

  /** Stop and clean up the session. */
  async stop(): Promise<void> {
    if (this.destroyed) return
    this.logger.info('session', `Stopping session ${this.sessionId}`)

    this.turnManager.interruptTurn()
    await this.closeLiveStt()
    this.inputAudioUnsub?.()
    this.inputAudioUnsub = null
    this.audioRouter.abort()
    await this.audioRouter.destroy()

    await this.stt.stop?.()
    await this.tts.stop?.()
    await this.transport.disconnect()

    this.stateMachine.forceClose()
    this.destroyed = true
    this.logger.info('session', `Session ${this.sessionId} stopped`)
  }

  /** Destroy all resources. */
  async destroy(): Promise<void> {
    await this.stop()
    await this.stt.destroy?.()
    await this.tts.destroy?.()
    await this.transport.destroy?.()
    this.history.clear()
  }

  /** Get the current session state. */
  get state(): SessionState {
    return this.stateMachine.state
  }

  /** Get conversation history. */
  getHistory(): ConversationMessage[] {
    return this.history.getMessages()
  }

  /** Handle an incoming event from the transport. */
  private async handleTransportEvent(rawEvent: unknown): Promise<void> {
    if (this.destroyed) return

    let event: ClientToServerEvent
    try {
      const data = typeof rawEvent === 'string' ? rawEvent : JSON.stringify(rawEvent)
      event = parseClientEvent(data)
    } catch (error) {
      this.logger.warn('session', `Invalid wire event: ${(error as Error).message}`)
      this.sendEvent({
        type: 'error',
        code: 'WIRE_PROTOCOL_INVALID',
        message: (error as Error).message,
      })
      return
    }

    switch (event.type) {
      case 'start_speaking':
        await this.handleStartSpeaking()
        break
      case 'stop_speaking':
        await this.handleStopSpeaking()
        break
      case 'mute':
        // Handle mute
        break
      case 'config_update':
        // Handle config update
        break
    }
  }

  /** Handle user started speaking — interrupt any in-progress turn. */
  private async handleStartSpeaking(): Promise<void> {
    this.logger.debug('session', 'User started speaking')

    // Interrupt current turn if active
    if (this.turnManager.isTurnActive()) {
      this.turnManager.interruptTurn()
      this.sendEvent({ type: 'audio_flush' })
    }

    await this.openLiveStt()

    // Barge-in can arrive while the state machine is Speaking. Move through
    // Listening explicitly; it is the only legal bridge into Receiving.
    if (this.stateMachine.state === SessionState.Speaking && this.stateMachine.canTransition(SessionState.Listening)) {
      this.stateMachine.transition(SessionState.Listening)
    }
    if (this.stateMachine.canTransition(SessionState.Receiving)) {
      this.stateMachine.transition(SessionState.Receiving)
      this.sendEvent({ type: 'state', state: this.stateMachine.state })
    }
  }

  /** Handle user stopped speaking — run STT → Brain → TTS. */
  private async handleStopSpeaking(): Promise<void> {
    this.logger.debug('session', 'User stopped speaking')

    if (this.liveSttStream) {
      await this.liveSttStream.flush()
      await this.waitForLiveSttResult()
      const finalTranscript = this.liveSttResults.find((result) => result.isFinal)
      await this.closeLiveStt()
      if (finalTranscript?.text.trim()) {
        await this.runTurn([], finalTranscript)
        return
      }
    }

    // Fallback for batch-only STT providers.
    const audioChunks = this.audioRouter.drainAudio()
    if (audioChunks.length === 0) {
      this.logger.warn('session', 'No audio chunks received')
      // Go back to listening
      this.backToListening()
      return
    }

    // Transition to processing
    if (this.stateMachine.canTransition(SessionState.Processing)) {
      this.stateMachine.transition(SessionState.Processing)
      this.sendEvent({ type: 'state', state: this.stateMachine.state })
    }

    // Run the turn: STT → Brain → TTS
    await this.runTurn(audioChunks)
  }

  /** Run a full turn: STT → Brain → TTS.
   *
   *  Streaming pipeline: LLM tokens are accumulated into sentence-sized
   *  chunks and sent to TTS immediately — TTS starts generating audio
   *  while the LLM is still producing text. This minimizes time-to-first-audio.
   */
  private async runTurn(
    audioChunks: AudioChunk[],
    streamedTranscript?: TranscriptResult,
  ): Promise<void> {
    const { turnId, signal } = this.turnManager.startTurn()
    const T0 = this.clock.now()
    const timings: Record<string, number> = {}
    const mark = (label: string): void => {
      timings[label] = this.clock.now() - T0
    }

    try {
      // 1. STT: audio → transcript
      mark('start')
      let finalTranscript = streamedTranscript
      if (!finalTranscript) {
        const audioStream = this.chunksToAsyncIterable(audioChunks)
        const transcripts: TranscriptResult[] = []
        for await (const result of this.audioRouter.transcribe(audioStream)) {
          transcripts.push(result)
          this.sendEvent({ type: 'transcript', text: result.text, isFinal: result.isFinal })
        }
        finalTranscript = transcripts.find((result) => result.isFinal)
      }
      mark('stt_done')

      if (!finalTranscript || !finalTranscript.text.trim()) {
        this.logger.warn('session', 'No final transcript, skipping turn')
        this.turnManager.endTurn(false)
        this.backToListening()
        return
      }

      // 2. Add to history
      this.history.addUserMessage(finalTranscript.text)
      mark('history')

      // 3. Transition to speaking state
      if (this.stateMachine.canTransition(SessionState.Speaking)) {
        this.stateMachine.transition(SessionState.Speaking)
        this.sendEvent({ type: 'state', state: this.stateMachine.state })
      }

      // 4. Brain → TTS streaming pipeline
      // Accumulate LLM tokens into sentence-sized chunks and send each
      // to TTS immediately. This starts audio playback while the LLM
      // is still generating, minimizing time-to-first-audio.
      const messageId = `bot-${turnId}`
      let assistantText = ''
      let firstAudioSent = false
      let sentenceCount = 0
      const sentenceChunker = new SentenceChunker()
      const ttsStream = this.tts.openStream
        ? await this.tts.openStream({}, signal)
        : null
      const streamAudioTask = ttsStream
        ? this.forwardTtsStream(ttsStream, signal, () => {
            if (!firstAudioSent) {
              firstAudioSent = true
              mark('first_audio')
              this.logger.info('session', `⏱️ FIRST AUDIO at ${timings.first_audio}ms (stream)`)
            }
          })
        : null

      const brainContext = {
        sessionId: this.sessionId,
        history: this.history.getMessages(),
        signal,
      }

      const brainResult = this.brain(finalTranscript.text, brainContext)
      mark('brain_start')

      // Queue a phrase without blocking Brain token consumption. The
      // TurnManager serializes audio to preserve order while allowing the
      // model to continue producing text concurrently.
      const queueSentence = (text: string): void => {
        const trimmed = text.trim()
        if (!trimmed || signal.aborted) return
        sentenceCount++
        if (!timings.tts_start) {
          mark('tts_start')
        }
        this.turnManager.enqueueTTS(async () => {
          try {
            if (ttsStream) {
              await ttsStream.write(trimmed)
              return
            }
            for await (const chunk of this.audioRouter.synthesizeChunks(trimmed)) {
              if (signal.aborted) return
              this.transport.sendAudio(chunk.data)
              if (!firstAudioSent) {
                firstAudioSent = true
                mark('first_audio')
                this.logger.info('session', `⏱️ FIRST AUDIO at ${timings.first_audio}ms (phrase ${sentenceCount})`)
              }
            }
          } catch (err) {
            this.logger.warn('session', `TTS error for phrase: ${(err as Error).message}`)
          }
        })
      }

      if (isAsyncGenerator(brainResult)) {
        for await (const token of brainResult) {
          if (signal.aborted) break
          assistantText += token
          this.sendEvent({ type: 'bot_text', text: token, messageId })

          // Emit phrase-sized chunks as soon as they are ready. This must not
          // await TTS: doing so recreates the old LLM → TTS waterfall.
          for (const phrase of sentenceChunker.process(token)) {
            queueSentence(phrase)
          }
        }
      } else {
        assistantText = await brainResult
        this.sendEvent({ type: 'bot_text', text: assistantText, messageId })
        for (const phrase of sentenceChunker.process(assistantText)) {
          queueSentence(phrase)
        }
      }
      mark('brain_done')

      // Flush any remaining phrase, then wait for ordered audio after Brain
      // generation has completed.
      if (!signal.aborted) {
        for (const phrase of sentenceChunker.flush()) {
          queueSentence(phrase)
        }
      }
      await this.turnManager.waitForTTS()
      if (ttsStream) {
        await ttsStream.flush()
        await streamAudioTask
        await ttsStream.close()
      }
      mark('tts_done')

      // Signal text done
      this.sendEvent({ type: 'bot_text_done', messageId, partial: signal.aborted })

      // 5. Add to history
      this.history.addAssistantMessage(assistantText, {
        id: messageId,
        partial: signal.aborted,
      })

      // Print timing stats
      const total = this.clock.now() - T0
      const sttMs = (timings.stt_done ?? 0) - (timings.start ?? 0)
      const brainMs = (timings.brain_done ?? 0) - (timings.brain_start ?? 0)
      const firstAudioMs = timings.first_audio ?? 0
      const ttsMs = (timings.tts_done ?? 0) - (timings.tts_start ?? timings.brain_start ?? 0)
      this.logger.info('session', [
        `⏱️ TURN STATS (turn ${turnId}):`,
        `  STT:       ${sttMs}ms`,
        `  Brain:     ${brainMs}ms`,
        `  First aud: ${firstAudioMs}ms  ← time-to-first-audio`,
        `  TTS total: ${ttsMs}ms`,
        `  Total:     ${total}ms`,
        `  Sentences: ${sentenceCount}`,
        `  Transcript: "${finalTranscript.text.substring(0, 60)}"`,
        `  Response:  "${assistantText.substring(0, 60)}"`,
      ].join('\n'))

      // Send stats to the client so the UI can display them
      this.sendEvent({
        type: 'turn_stats',
        turnId,
        sttMs,
        brainMs,
        firstAudioMs,
        ttsMs,
        totalMs: total,
        sentences: sentenceCount,
        transcript: finalTranscript.text.substring(0, 120),
        response: assistantText.substring(0, 120),
        interrupted: signal.aborted,
      })

      this.turnManager.endTurn(false)
      this.backToListening()
    } catch (error) {
      this.logger.error('session', `Turn ${turnId} error: ${(error as Error).message}`)
      this.sendEvent({
        type: 'error',
        code: 'PIPELINE_ERROR',
        message: (error as Error).message,
      })
      this.turnManager.endTurn(true)
      this.backToListening()
    }
  }

  /** Transition back to listening state. */
  private backToListening(): void {
    // A new user turn may have started while an invalidated async task was
    // unwinding. Never let that stale task overwrite Receiving.
    if (this.stateMachine.state === SessionState.Receiving) return
    if (this.stateMachine.canTransition(SessionState.Listening)) {
      this.stateMachine.transition(SessionState.Listening)
      this.sendEvent({ type: 'state', state: this.stateMachine.state })
    }
  }

  /** Convert an array of chunks to an async iterable. */
  private chunksToAsyncIterable(chunks: AudioChunk[]): AsyncIterable<AudioChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  /** Send an event to the client via transport. */
  private sendEvent(event: ServerToClientEvent): void {
    const serialized = serializeServerEvent(event)
    this.transport.sendEvent(serialized)
  }

  private async openLiveStt(): Promise<void> {
    if (!this.stt.openStream) return
    await this.closeLiveStt()
    const controller = new AbortController()
    this.liveSttAbort = controller
    try {
      const stream = await this.stt.openStream({}, controller.signal)
      this.liveSttStream = stream
      this.liveSttResults = []
      this.liveSttResultTask = (async () => {
        for await (const result of stream.results) {
          this.liveSttResults.push(result)
          this.sendEvent({ type: 'transcript', text: result.text, isFinal: result.isFinal })
          if (result.isFinal) return
        }
      })()
    } catch (error) {
      this.logger.warn('session', `Live STT unavailable, using batch fallback: ${(error as Error).message}`)
      this.liveSttAbort = null
    }
  }

  private async writeLiveStt(chunk: AudioChunk): Promise<void> {
    if (!this.liveSttStream || this.liveSttAbort?.signal.aborted) return
    await this.liveSttStream.write(chunk)
  }

  private async closeLiveStt(): Promise<void> {
    const controller = this.liveSttAbort
    controller?.abort()
    this.liveSttAbort = null
    const stream = this.liveSttStream
    this.liveSttStream = null
    if (stream) {
      try {
        await stream.abort()
      } catch (error) {
        this.logger.debug('session', `Live STT abort failed: ${(error as Error).message}`)
      }
      await stream.close()
    }
    this.liveSttResultTask = null
    this.liveSttResults = []
  }

  private async forwardTtsStream(
    stream: import('@voiceminusone/core').TTSStream,
    signal: AbortSignal,
    onFirstAudio: () => void,
  ): Promise<void> {
    try {
      for await (const chunk of stream.audio) {
        if (signal.aborted) return
        onFirstAudio()
        this.transport.sendAudio(chunk.data)
      }
    } catch (error) {
      if (!signal.aborted) {
        this.logger.warn('session', `Live TTS stream failed: ${(error as Error).message}`)
      }
    }
  }

  /** Wait briefly for a provider final result without letting a bad socket hang a turn. */
  private async waitForLiveSttResult(): Promise<void> {
    const task = this.liveSttResultTask
    if (!task) return
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        task,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1500)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

/** Check if a value is an async generator (vs a Promise). */
function isAsyncGenerator(
  value: Promise<string> | AsyncGenerator<string, void, unknown>,
): value is AsyncGenerator<string, void, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value
  )
}
