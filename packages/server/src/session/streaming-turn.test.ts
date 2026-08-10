import { describe, expect, it } from 'vitest'
import {
  MemoryTransport,
  type AudioChunk,
  type Brain,
  type PluginContext,
  type STTConfig,
  type STTProvider,
  type STTStream,
  type TTSConfig,
  type TTSProvider,
  type TranscriptResult,
} from '@voiceminusone/core'
import { SessionManager } from './session-manager'

const context: PluginContext = {
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => context.logger,
  },
  events: {
    on: () => () => {},
    once: () => () => {},
    emit: () => {},
    off: () => {},
    clear: () => {},
  },
  clock: { now: () => performance.now() },
  signal: new AbortController().signal,
}

class ImmediateSTT implements STTProvider {
  readonly name = 'immediate-stt'

  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    _config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    for await (const _chunk of audio) {
      // Consume the stream so the test exercises the real session boundary.
    }
    yield { text: 'hello', isFinal: true }
  }
}

class SlowTTS implements TTSProvider {
  readonly name = 'slow-tts'

  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *synthesize(
    _text: string,
    _config: TTSConfig,
  ): AsyncIterable<AudioChunk> {
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    yield { data: new ArrayBuffer(320), sampleRate: 16000, numChannels: 1 }
  }
}

class LiveSTT implements STTProvider {
  readonly name = 'live-stt'
  writes = 0

  async init(_ctx: PluginContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async *transcribe(): AsyncIterable<TranscriptResult> {
    throw new Error('The batch fallback must not run for a live stream')
  }

  async openStream(_config: STTConfig, _signal: AbortSignal): Promise<STTStream> {
    const self = this
    let flushed = false
    return {
      results: {
        async *[Symbol.asyncIterator](): AsyncIterator<TranscriptResult> {
          while (!flushed) await new Promise<void>((resolve) => setTimeout(resolve, 1))
          yield { text: 'live hello', isFinal: true }
        },
      },
      async write(): Promise<void> { self.writes += 1 },
      async flush(): Promise<void> { flushed = true },
      async abort(): Promise<void> {},
      async close(): Promise<void> {},
    }
  }
}

describe('SessionManager streaming turn orchestration', () => {
  it('writes input frames to a live STT stream before turn end', async () => {
    const [serverTransport, clientTransport] = MemoryTransport.pair()
    const stt = new LiveSTT()
    const session = new SessionManager({
      transport: serverTransport,
      stt,
      tts: new SlowTTS(),
      brain: async () => 'ok',
      logger: context.logger,
    })

    await session.start()
    await clientTransport.connect('live-stt-test')
    clientTransport.sendEvent(JSON.stringify({ type: 'start_speaking' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    clientTransport.sendAudio(new ArrayBuffer(320))
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(stt.writes).toBe(1)
    clientTransport.sendEvent(JSON.stringify({ type: 'stop_speaking' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await session.destroy()
  })

  it('continues consuming Brain tokens while TTS is still synthesizing', async () => {
    const [serverTransport, clientTransport] = MemoryTransport.pair()
    const botEvents: Array<{ type: string; text?: string }> = []
    const audio: ArrayBuffer[] = []
    clientTransport.onEvent((event) => {
      if (typeof event !== 'string') return
      const parsed = JSON.parse(event) as { type: string; text?: string }
      if (parsed.type === 'bot_text') botEvents.push(parsed)
    })
    clientTransport.onAudio((chunk) => audio.push(chunk))

    const brain: Brain = async function* (): AsyncGenerator<string, void, unknown> {
      const tokens = 'one two three four five six seven eight'.split(' ')
      for (const token of tokens) {
        yield `${token} `
        await Promise.resolve()
      }
    }

    const session = new SessionManager({
      transport: serverTransport,
      stt: new ImmediateSTT(),
      tts: new SlowTTS(),
      brain,
      logger: context.logger,
    })

    await session.start()
    await clientTransport.connect('streaming-turn-test')
    clientTransport.sendAudio(new ArrayBuffer(320))
    clientTransport.sendEvent(JSON.stringify({ type: 'stop_speaking' }))

    // The first phrase starts a deliberately slow TTS operation. All Brain
    // tokens must still be emitted before that operation can yield audio.
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    expect(botEvents.map((event) => event.text).join('')).toBe(
      'one two three four five six seven eight ',
    )
    expect(audio).toHaveLength(0)

    await new Promise<void>((resolve) => setTimeout(resolve, 180))
    expect(audio.length).toBeGreaterThan(0)
    await session.destroy()
  })
})
