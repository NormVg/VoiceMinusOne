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
  type TTSProvider,
  type Brain,
  type AudioChunk,
  type TranscriptResult,
  type ConversationMessage,
  ConsoleLogger,
  LogLevel,
} from '@voiceminusone/core'
import { SessionStateMachine } from './state-machine'
import { TurnManager } from './turn-manager'
import { AudioRouter } from './audio-router'
import { HistoryManager } from './history-manager'
import {
  parseClientEvent,
  serializeServerEvent,
  type ServerToClientEvent,
  type ClientToServerEvent,
} from '../wire/protocol'

export interface SessionManagerOptions extends SessionConfig {
  readonly logger?: Logger
  readonly sessionId?: string
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
  private destroyed = false

  constructor(opts: SessionManagerOptions) {
    this.sessionId = opts.sessionId ?? `session-${Date.now()}`
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
      clock: { now: () => Date.now() },
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
    this.stateMachine.transition(SessionState.Listening)

    this.sendEvent({ type: 'state', state: this.stateMachine.state })
    this.logger.info('session', `Session ${this.sessionId} started`)
  }

  /** Stop and clean up the session. */
  async stop(): Promise<void> {
    if (this.destroyed) return
    this.logger.info('session', `Stopping session ${this.sessionId}`)

    this.turnManager.interruptTurn()
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

    if (this.stateMachine.canTransition(SessionState.Receiving)) {
      this.stateMachine.transition(SessionState.Receiving)
      this.sendEvent({ type: 'state', state: this.stateMachine.state })
    }
  }

  /** Handle user stopped speaking — run STT → Brain → TTS. */
  private async handleStopSpeaking(): Promise<void> {
    this.logger.debug('session', 'User stopped speaking')

    // Drain buffered audio from the AudioRouter
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

  /** Run a full turn: STT → Brain → TTS. */
  private async runTurn(audioChunks: AudioChunk[]): Promise<void> {
    const { turnId, signal } = this.turnManager.startTurn()

    try {
      // 1. STT: audio → transcript
      const audioStream = this.chunksToAsyncIterable(audioChunks)
      const transcripts: TranscriptResult[] = []

      for await (const result of this.audioRouter.transcribe(audioStream)) {
        transcripts.push(result)
        this.sendEvent({
          type: 'transcript',
          text: result.text,
          isFinal: result.isFinal,
        })
      }

      const finalTranscript = transcripts.find((t) => t.isFinal)
      if (!finalTranscript || !finalTranscript.text.trim()) {
        this.logger.warn('session', 'No final transcript, skipping turn')
        this.turnManager.endTurn(false)
        this.backToListening()
        return
      }

      // 2. Add to history
      this.history.addUserMessage(finalTranscript.text)

      // 3. Brain: transcript → response
      const messageId = `bot-${turnId}`
      let assistantText = ''

      const brainContext = {
        sessionId: this.sessionId,
        history: this.history.getMessages(),
        signal,
      }

      const brainResult = this.brain(finalTranscript.text, brainContext)

      if (isAsyncGenerator(brainResult)) {
        for await (const token of brainResult) {
          if (signal.aborted) break
          assistantText += token
          this.sendEvent({
            type: 'bot_text',
            text: token,
            messageId,
          })
        }
      } else {
        assistantText = await brainResult
        this.sendEvent({
          type: 'bot_text',
          text: assistantText,
          messageId,
        })
      }

      // Signal text done
      this.sendEvent({
        type: 'bot_text_done',
        messageId,
        partial: signal.aborted,
      })

      // 4. Add to history
      this.history.addAssistantMessage(assistantText, {
        id: messageId,
        partial: signal.aborted,
      })

      if (signal.aborted) {
        this.turnManager.endTurn(true)
        this.backToListening()
        return
      }

      // 5. TTS: text → audio (via serial queue)
      if (this.stateMachine.canTransition(SessionState.Speaking)) {
        this.stateMachine.transition(SessionState.Speaking)
        this.sendEvent({ type: 'state', state: this.stateMachine.state })
      }

      this.turnManager.enqueueTTS(async (gen) => {
        if (!this.turnManager.isCurrentGeneration(gen)) return
        if (signal.aborted) return
        await this.audioRouter.synthesizeAndSend(assistantText)
      })

      await this.turnManager.waitForTTS()
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
