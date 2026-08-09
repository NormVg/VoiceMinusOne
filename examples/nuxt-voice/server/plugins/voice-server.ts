import { WebSocketServer, SessionManager } from '@voiceminusone/server'
import type {
  STTProvider,
  TTSProvider,
  Brain,
  AudioChunk,
  TranscriptResult,
  STTConfig,
  TTSConfig,
  PluginContext,
} from '@voiceminusone/core'

// --- Mock STT ---

class MockSTT implements STTProvider {
  readonly name = 'mock-stt'
  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    _config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    let count = 0
    for await (const _chunk of audio) {
      count++
    }
    yield {
      text: `Hello from mock STT (${count} chunks received)`,
      isFinal: true,
      timestamp: Date.now(),
    }
  }
}

// --- Mock TTS ---

class MockTTS implements TTSProvider {
  readonly name = 'mock-tts'
  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *synthesize(text: string, _config: TTSConfig): AsyncIterable<AudioChunk> {
    const words = text.split(/\s+/).filter(Boolean)
    for (const _word of words) {
      const buf = new ArrayBuffer(4800)
      const view = new Int16Array(buf)
      for (let i = 0; i < 2400; i++) {
        view[i] = Math.floor(Math.random() * 20) - 10
      }
      yield { data: buf, sampleRate: 24000, numChannels: 1 }
    }
  }
}

// --- Mock Brain ---

const mockBrain: Brain = async function* (
  userText: string,
): AsyncGenerator<string, void, unknown> {
  const response = `I heard you say: ${userText}. This is a mock response.`
  for (const word of response.split(/\s+/)) {
    yield `${word} `
    await new Promise((r) => setTimeout(r, 10))
  }
}

// --- Nuxt server plugin ---

export default defineNitroPlugin((nitroApp) => {
  const wsServer = new WebSocketServer({ port: 3001, host: '0.0.0.0' })

  wsServer.onConnection((transport) => {
    const session = new SessionManager({
      transport,
      stt: new MockSTT(),
      tts: new MockTTS(),
      brain: mockBrain,
      sampleRate: 16000,
    })

    session.start().catch((err) => {
      console.error('Session start failed:', err)
    })
  })

  wsServer
    .start()
    .then((port) => {
      console.log(`VoiceMinusOne WebSocket server listening on port ${port}`)
    })
    .catch((err) => {
      console.error('WebSocket server failed to start:', err)
    })

  nitroApp.hooks.hook('close', async () => {
    await wsServer.stop()
  })
})
