/**
 * Integration test — full session flow end-to-end.
 *
 * Uses MemoryTransport (linked transport pair) to test the complete
 * server pipeline without a real WebSocket server:
 *   Client sends audio → Transport → STT → Brain → TTS → Transport → Client receives audio
 *
 * This is the "real WebSocket integration test" pattern from voice-line
 * that we keep — but using MemoryTransport for speed and determinism.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  MemoryTransport,
  type STTProvider,
  type TTSProvider,
  type AudioChunk,
  type TranscriptResult,
  type STTConfig,
  type TTSConfig,
  type PluginContext,
} from '@voiceminusone/core'
import { SessionManager } from './session-manager'
import type { Brain, ConversationMessage } from '@voiceminusone/core'

// --- Mock providers (server-side) ---

class TestSTT implements STTProvider {
  readonly name = 'test-stt'
  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    _config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    let chunkCount = 0
    for await (const _chunk of audio) {
      chunkCount++
    }
    yield {
      text: `Received ${chunkCount} audio chunks`,
      isFinal: true,
      timestamp: Date.now(),
    }
  }
}

class TestTTS implements TTSProvider {
  readonly name = 'test-tts'
  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *synthesize(text: string, _config: TTSConfig): AsyncIterable<AudioChunk> {
    // Generate a few small audio chunks from the text
    const words = text.split(' ')
    for (let i = 0; i < Math.min(words.length, 3); i++) {
      const buffer = new ArrayBuffer(3200) // 100ms at 16kHz
      yield { data: buffer, sampleRate: 16000, numChannels: 1 }
    }
  }
}

const testBrain: Brain = async function* (
  userText: string,
): AsyncGenerator<string, void, unknown> {
  const response = `You said: ${userText}. This is a test response.`
  const words = response.split(' ')
  for (const word of words) {
    yield `${word} `
    await new Promise((r) => setTimeout(r, 1))
  }
}

// --- Tests ---

describe('SessionManager integration', () => {
  let serverTransport: MemoryTransport
  let clientTransport: MemoryTransport
  let session: SessionManager

  beforeAll(async () => {
    const [a, b] = MemoryTransport.pair()
    serverTransport = a
    clientTransport = b

    session = new SessionManager({
      transport: serverTransport,
      stt: new TestSTT(),
      tts: new TestTTS(),
      brain: testBrain,
      sampleRate: 16000,
    })

    await session.start()
    // Connect the client transport too so it can send audio/events
    await clientTransport.connect('test-client')
  })

  afterAll(async () => {
    await session.destroy()
  })

  it('should start in listening state', () => {
    expect(session.state).toBe('listening')
  })

  it('should receive and handle start_speaking event from client', async () => {
    // Client sends start_speaking event
    clientTransport.sendEvent(JSON.stringify({ type: 'start_speaking' }))

    // Give the server a moment to process
    await new Promise((r) => setTimeout(r, 50))

    // Server should transition to receiving
    expect(session.state).toBe('receiving')
  })

  it('should receive and handle stop_speaking event and run full turn', async () => {
    // Collect events received by the client
    const clientEvents: unknown[] = []
    const eventUnsub = clientTransport.onEvent((event) => clientEvents.push(event))

    // Collect audio received by the client
    const clientAudio: ArrayBuffer[] = []
    const audioUnsub = clientTransport.onAudio((chunk) => clientAudio.push(chunk))

    // Client sends audio chunks (simulating speech)
    for (let i = 0; i < 5; i++) {
      clientTransport.sendAudio(new ArrayBuffer(3200))
    }

    // Give the server a moment to buffer the audio
    await new Promise((r) => setTimeout(r, 20))

    // Client sends stop_speaking event
    clientTransport.sendEvent(JSON.stringify({ type: 'stop_speaking' }))

    // Wait for the full turn to complete (STT → Brain → TTS)
    await new Promise((r) => setTimeout(r, 300))

    // Server should be back to listening
    expect(session.state).toBe('listening')

    // Client should have received events
    const eventStrings = clientEvents.map((e) => {
      const s = typeof e === 'string' ? e : JSON.stringify(e)
      return JSON.parse(s)
    })

    // Should have received a state event
    const stateEvents = eventStrings.filter((e) => e.type === 'state')
    expect(stateEvents.length).toBeGreaterThan(0)

    // Should have received a transcript event
    const transcriptEvents = eventStrings.filter((e) => e.type === 'transcript')
    expect(transcriptEvents.length).toBeGreaterThan(0)
    expect(transcriptEvents[0].text).toContain('audio chunks')

    // Should have received bot_text events
    const botTextEvents = eventStrings.filter((e) => e.type === 'bot_text')
    expect(botTextEvents.length).toBeGreaterThan(0)

    // Should have received bot_text_done event
    const doneEvents = eventStrings.filter((e) => e.type === 'bot_text_done')
    expect(doneEvents.length).toBeGreaterThan(0)

    // Should have received audio chunks (TTS output)
    expect(clientAudio.length).toBeGreaterThan(0)
  })

  it('should track conversation history', () => {
    const history = session.getHistory()
    // Should have at least 1 user + 1 assistant message
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history.some((m: ConversationMessage) => m.role === 'user')).toBe(true)
    expect(history.some((m: ConversationMessage) => m.role === 'assistant')).toBe(true)
  })

  it('should handle interruption when user starts speaking during TTS', async () => {
    // Send audio and start a turn
    for (let i = 0; i < 3; i++) {
      clientTransport.sendAudio(new ArrayBuffer(3200))
    }
    await new Promise((r) => setTimeout(r, 20))

    clientTransport.sendEvent(JSON.stringify({ type: 'stop_speaking' }))

    // Wait a bit, then interrupt with start_speaking
    await new Promise((r) => setTimeout(r, 30))
    clientTransport.sendEvent(JSON.stringify({ type: 'start_speaking' }))

    // Should get an audio_flush event (interruption)
    await new Promise((r) => setTimeout(r, 100))

    // Server should handle the interruption gracefully
    expect(session.state).toBe('receiving')
  })

  it('should reject invalid wire events gracefully', async () => {
    const clientEvents: unknown[] = []
    clientTransport.onEvent((event) => clientEvents.push(event))

    // Send malformed event
    clientTransport.sendEvent(JSON.stringify({ type: 'unknown_event' }))

    await new Promise((r) => setTimeout(r, 50))

    // Should have received an error event
    const eventStrings = clientEvents.map((e) => {
      const s = typeof e === 'string' ? e : JSON.stringify(e)
      return JSON.parse(s)
    })
    const errorEvents = eventStrings.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(errorEvents[0].code).toBe('WIRE_PROTOCOL_INVALID')
  })

  it('should stop and clean up properly', async () => {
    await session.stop()
    expect(session.state).toBe('closed')
  })
})
