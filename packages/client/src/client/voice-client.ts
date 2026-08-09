/**
 * VoiceMinusOneClient — browser-side client.
 *
 * Connects to a VoiceMinusOne server via WebSocket, manages the mic
 * and speaker, and provides a clean state API for the UI.
 *
 * Wire protocol:
 * - Binary frames → audio (raw PCM)
 * - Text frames → JSON events (validated on server side)
 *
 * Per R-017: Uses WebSocket frame type (binary vs text) directly,
 * never guesses from byte values.
 */

import { Mic } from '../audio/mic'
import { Speaker } from '../audio/speaker'

export interface ClientConfig {
  readonly url: string
  readonly reconnect?: boolean
  readonly maxReconnectAttempts?: number
  readonly reconnectDelayMs?: number
  readonly connectionTimeoutMs?: number
}

export const DEFAULT_CLIENT_CONFIG: Required<ClientConfig> = {
  url: '',
  reconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelayMs: 1000,
  connectionTimeoutMs: 10000,
}

export interface ClientState {
  readonly connected: boolean
  readonly connecting: boolean
  readonly reconnecting: boolean
  readonly muted: boolean
  readonly speaking: boolean
  readonly listening: boolean
  readonly error?: string
}

export type ClientStateListener = (state: ClientState) => void
export type TranscriptListener = (text: string, isFinal: boolean) => void
export type BotTextListener = (text: string, messageId: string) => void
export type BotTextDoneListener = (messageId: string, partial: boolean) => void

/** Server-reported per-turn timing breakdown. */
export interface TurnStats {
  readonly turnId: number
  readonly sttMs: number
  readonly brainMs: number
  readonly firstAudioMs: number
  readonly ttsMs: number
  readonly totalMs: number
  readonly sentences: number
  readonly transcript: string
  readonly response: string
  readonly interrupted: boolean
  /** Client-measured wall-clock from stop_speaking sent to first audio received. */
  readonly e2eLatencyMs?: number | undefined
}

export type TurnStatsListener = (stats: TurnStats) => void

/** Close codes that should NOT trigger reconnection. */
const NON_RECOVERABLE_CLOSE_CODES = new Set([4000, 4001, 4400, 4401])

export class VoiceMinusOneClient {
  private config: Required<ClientConfig>
  private ws: WebSocket | null = null
  private mic: Mic
  private speaker: Speaker

  private connected = false
  private connecting = false
  private reconnecting = false
  private muted = false
  private speaking = false
  private listening = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private stateListeners: ClientStateListener[] = []
  private transcriptListeners: TranscriptListener[] = []
  private botTextListeners: BotTextListener[] = []
  private botTextDoneListeners: BotTextDoneListener[] = []
  private turnStatsListeners: TurnStatsListener[] = []

  /** Timestamp when stop_speaking was sent — for E2E latency measurement. */
  private turnStartTime: number | null = null
  /** Client-measured E2E latency (stop_speaking → first audio chunk). */
  private e2eLatencyMs: number | null = null

  private micChunkUnsub: (() => void) | null = null
  private micStateUnsub: (() => void) | null = null

  constructor(config: ClientConfig) {
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config }
    this.mic = new Mic()
    this.speaker = new Speaker()
  }

  /** Connect to the server. */
  async connect(): Promise<void> {
    if (this.connected || this.connecting) return

    this.connecting = true
    this.notifyState()

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.url)
      ws.binaryType = 'arraybuffer'

      const timeout = setTimeout(() => {
        ws.close()
        this.connecting = false
        this.notifyState()
        reject(new Error('Connection timeout'))
      }, this.config.connectionTimeoutMs)

      ws.onopen = () => {
        clearTimeout(timeout)
        this.ws = ws
        this.connected = true
        this.connecting = false
        this.reconnecting = false
        this.reconnectAttempts = 0
        this.listening = true
        this.notifyState()
        resolve()
      }

      ws.onmessage = (event) => this.handleMessage(event)

      ws.onclose = (event) => {
        clearTimeout(timeout)
        this.handleClose(event.code, event.reason)
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        if (this.connecting) {
          this.connecting = false
          this.notifyState()
          reject(new Error('WebSocket connection failed'))
        }
      }
    })
  }

  /** Disconnect from the server. */
  async disconnect(): Promise<void> {
    this.stopMic()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      this.ws.close()
      this.ws = null
    }

    this.connected = false
    this.connecting = false
    this.reconnecting = false
    this.listening = false
    this.speaking = false
    this.notifyState()
  }

  /** Start the microphone and begin sending audio. */
  async startMic(): Promise<void> {
    if (!this.connected) throw new Error('Not connected to server')

    await this.mic.start()
    await this.speaker.init()

    // Send audio chunks to server — chunks arrive as complete speech
    // utterances (Silero VAD emits on speech end)
    this.micChunkUnsub = this.mic.onChunk((chunk) => {
      if (this.connected && !this.muted) {
        this.ws?.send(chunk) // Binary frame — never base64 (R-010)
        // After the audio is sent, signal stop_speaking so the server
        // runs the STT → Brain → TTS pipeline on this utterance
        this.speaking = false
        this.turnStartTime = Date.now()
        this.e2eLatencyMs = null
        this.sendEvent({ type: 'stop_speaking' })
        this.notifyState()
      }
    })

    // Listen for VAD state changes (start_speaking)
    this.micStateUnsub = this.mic.onStateChange((state) => {
      if (state.speaking && !this.speaking) {
        this.speaking = true
        this.sendEvent({ type: 'start_speaking' })
        this.notifyState()
      }
    })
  }

  /** Stop the microphone. */
  stopMic(): void {
    if (this.micChunkUnsub) {
      this.micChunkUnsub()
      this.micChunkUnsub = null
    }
    if (this.micStateUnsub) {
      this.micStateUnsub()
      this.micStateUnsub = null
    }
    this.mic.stop()
    this.speaker.stop()
  }

  /** Mute/unmute the microphone. */
  setMuted(muted: boolean): void {
    this.muted = muted
    this.mic.setMuted(muted)
    this.sendEvent({ type: 'mute', muted })
    this.notifyState()
  }

  /** Get the current state. */
  getState(): ClientState {
    return {
      connected: this.connected,
      connecting: this.connecting,
      reconnecting: this.reconnecting,
      muted: this.muted,
      speaking: this.speaking,
      listening: this.listening,
    }
  }

  /** Get the mic instance. */
  getMic(): Mic {
    return this.mic
  }

  /** Get the speaker instance. */
  getSpeaker(): Speaker {
    return this.speaker
  }

  // --- Event listeners ---

  onStateChange(listener: ClientStateListener): () => void {
    this.stateListeners.push(listener)
    return () => {
      const idx = this.stateListeners.indexOf(listener)
      if (idx >= 0) this.stateListeners.splice(idx, 1)
    }
  }

  onTranscript(listener: TranscriptListener): () => void {
    this.transcriptListeners.push(listener)
    return () => {
      const idx = this.transcriptListeners.indexOf(listener)
      if (idx >= 0) this.transcriptListeners.splice(idx, 1)
    }
  }

  onBotText(listener: BotTextListener): () => void {
    this.botTextListeners.push(listener)
    return () => {
      const idx = this.botTextListeners.indexOf(listener)
      if (idx >= 0) this.botTextListeners.splice(idx, 1)
    }
  }

  onBotTextDone(listener: BotTextDoneListener): () => void {
    this.botTextDoneListeners.push(listener)
    return () => {
      const idx = this.botTextDoneListeners.indexOf(listener)
      if (idx >= 0) this.botTextDoneListeners.splice(idx, 1)
    }
  }

  /** Subscribe to per-turn timing stats from the server. */
  onTurnStats(listener: TurnStatsListener): () => void {
    this.turnStatsListeners.push(listener)
    return () => {
      const idx = this.turnStatsListeners.indexOf(listener)
      if (idx >= 0) this.turnStatsListeners.splice(idx, 1)
    }
  }

  // --- Internal ---

  /** Handle an incoming WebSocket message. */
  private handleMessage(event: MessageEvent): void {
    // Per R-017: Use the WebSocket frame type directly
    if (typeof event.data === 'string') {
      // Text frame — JSON event
      this.handleEvent(event.data)
    } else if (event.data instanceof ArrayBuffer) {
      // Binary frame — audio
      // Measure E2E latency on first audio chunk of this turn
      if (this.turnStartTime !== null && this.e2eLatencyMs === null) {
        this.e2eLatencyMs = Date.now() - this.turnStartTime
      }
      this.speaker.feed(event.data)
    }
  }

  /** Handle a JSON event from the server. */
  private handleEvent(data: string): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data)
    } catch {
      return // Ignore malformed JSON
    }

    const type = event.type as string

    switch (type) {
      case 'transcript':
        for (const listener of this.transcriptListeners) {
          listener(event.text as string, event.isFinal as boolean)
        }
        break
      case 'bot_text':
        for (const listener of this.botTextListeners) {
          listener(event.text as string, event.messageId as string)
        }
        break
      case 'bot_text_done':
        for (const listener of this.botTextDoneListeners) {
          listener(event.messageId as string, event.partial as boolean)
        }
        break
      case 'audio_flush':
        this.speaker.stop()
        break
      case 'turn_stats': {
        // If E2E wasn't captured from audio chunks, compute from turnStartTime
        let e2e = this.e2eLatencyMs
        if (e2e === null && this.turnStartTime !== null) {
          e2e = Date.now() - this.turnStartTime
        }
        const stats: TurnStats = {
          turnId: event.turnId as number,
          sttMs: event.sttMs as number,
          brainMs: event.brainMs as number,
          firstAudioMs: event.firstAudioMs as number,
          ttsMs: event.ttsMs as number,
          totalMs: event.totalMs as number,
          sentences: event.sentences as number,
          transcript: event.transcript as string,
          response: event.response as string,
          interrupted: event.interrupted as boolean,
          e2eLatencyMs: e2e ?? undefined,
        }
        for (const listener of this.turnStatsListeners) {
          try {
            listener(stats)
          } catch {
            // Listener errors are non-fatal
          }
        }
        break
      }
      case 'state':
        // Server state update — update listening flag
        if (event.state === 'listening') {
          this.listening = true
        } else if (event.state === 'speaking') {
          this.listening = false
        }
        this.notifyState()
        break
      case 'error':
        this.notifyStateWithError(event.message as string)
        break
    }
  }

  /** Handle WebSocket close. */
  private handleClose(code: number, _reason: string): void {
    this.connected = false
    this.connecting = false
    this.listening = false
    this.stopMic()
    this.notifyState()

    // Attempt reconnection if enabled and close code is recoverable
    if (
      this.config.reconnect &&
      !NON_RECOVERABLE_CLOSE_CODES.has(code) &&
      this.reconnectAttempts < this.config.maxReconnectAttempts
    ) {
      this.reconnectAttempts += 1
      this.reconnecting = true
      this.notifyState()

      const delay = this.config.reconnectDelayMs * this.reconnectAttempts
      this.reconnectTimer = setTimeout(() => {
        void this.connect().catch(() => {
          // Reconnection failed — will retry if attempts remain
        })
      }, delay)
    } else {
      this.reconnecting = false
      this.notifyState()
    }
  }

  /** Send a JSON event to the server. */
  private sendEvent(event: Record<string, unknown>): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(event))
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

  private notifyStateWithError(error: string): void {
    const state: ClientState = { ...this.getState(), error }
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // Listener errors are non-fatal
      }
    }
  }
}
