/**
 * Mock providers for the test pipeline.
 *
 * These are in-memory mock implementations of STT, TTS, and Brain
 * that don't require API keys or network access. They let the test
 * pipeline run end-to-end without external dependencies.
 *
 * When real providers (Sarvam, AI SDK) are ready, swap them in
 * by changing the factory calls in run.ts.
 */

import type {
  STTProvider,
  TTSProvider,
  Brain,
  BrainContext,
  AudioChunk,
  TranscriptResult,
  STTConfig,
  TTSConfig,
  PluginContext,
  ConversationMessage,
} from '@voiceminusone/core'

// --- Mock STT ---

/** A mock STT that yields a canned transcript after receiving audio. */
export class MockSTT implements STTProvider {
  readonly name = 'mock-stt'
  private context: PluginContext | null = null

  async init(context: PluginContext): Promise<void> {
    this.context = context
  }

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    _config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    let chunkCount = 0
    let totalBytes = 0

    for await (const chunk of audio) {
      chunkCount++
      totalBytes += chunk.data.byteLength

      // Yield an interim transcript after a few chunks
      if (chunkCount === 3) {
        yield { text: 'hello...', isFinal: false }
      }
    }

    this.context?.logger.info('mock-stt', `Received ${chunkCount} chunks (${totalBytes} bytes)`)

    // Yield final transcript
    yield {
      text: 'Hello, this is a test transcript from the mock STT provider.',
      isFinal: true,
      timestamp: Date.now(),
    }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

// --- Mock TTS ---

/** A mock TTS that generates silent audio chunks from text. */
export class MockTTS implements TTSProvider {
  readonly name = 'mock-tts'
  private context: PluginContext | null = null

  async init(context: PluginContext): Promise<void> {
    this.context = context
  }

  async *synthesize(text: string, _config: TTSConfig): AsyncIterable<AudioChunk> {
    // Split text into words and generate a chunk per word
    const words = text.split(/\s+/).filter(Boolean)
    const sampleRate = 24000

    for (const word of words) {
      // Generate 100ms of silence per word (4800 samples at 24kHz, 2 bytes each)
      const samples = Math.floor(sampleRate * 0.1)
      const buffer = new ArrayBuffer(samples * 2)
      // Fill with near-zero (not exactly zero to avoid VAD issues)
      const view = new Int16Array(buffer)
      for (let i = 0; i < samples; i++) {
        view[i] = Math.floor(Math.random() * 20) - 10
      }

      yield { data: buffer, sampleRate, numChannels: 1 }

      this.context?.logger.debug('mock-tts', `Synthesized word: "${word}"`)
    }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

// --- Mock Brain (LLM) ---

/** A mock Brain that echoes the user's text with a prefix. */
export const mockBrain: Brain = async function* (
  userText: string,
  _context: BrainContext,
): AsyncGenerator<string, void, unknown> {
  const response = `I heard you say: "${userText}". This is a mock response from the test pipeline.`

  // Stream word by word to simulate LLM streaming
  const words = response.split(/\s+/)
  for (const word of words) {
    yield `${word} `
    // Tiny delay to simulate streaming
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// --- Helpers ---

/** Create a conversation history with a system message. */
export function createMockHistory(systemPrompt: string): ConversationMessage[] {
  return [{ role: 'system', content: systemPrompt }]
}
