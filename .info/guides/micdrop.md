# Reference Guide: micdrop

> **Repository**: `github.com/Godefroy/micdrop` (TypeScript/pnpm monorepo)
> **Location**: `.info/repo/micdrop`
> **License**: MIT | **Package manager**: pnpm 8.15.4 | **Bundler**: tsup

## What It Is

Micdrop is a cascaded pipeline SDK (STT → LLM → TTS) for real-time voice conversations with AI agents. Instead of a single voice-to-voice model, it lets you mix-and-match best-in-class providers per component, reducing cost and increasing flexibility.

## Monorepo Structure

```
micdrop/
├── packages/
│   ├── server/          # Core: MicdropServer, Agent, STT, TTS abstractions
│   ├── client/          # Browser: MicdropClient, Mic, Speaker, VAD, AudioWorklet
│   ├── react/           # React hooks (useMicdropState, useMicVolume, etc.)
│   ├── openai/          # OpenAI Agent + STT + TTS
│   ├── ai-sdk/          # Vercel AI SDK Agent (multi-provider LLM)
│   ├── elevenlabs/      # ElevenLabs TTS
│   ├── cartesia/       # Cartesia TTS (WebSocket streaming)
│   ├── gradium/         # Gradium STT + TTS
│   ├── mistral/         # Mistral Agent + STT
│   └── gladia/          # Gladia STT
├── examples/
│   ├── demo-server/     # Fastify + WebSocket server example
│   └── demo-client/     # React + Vite client demo
└── doc/                 # Docusaurus documentation site
```

## Core Architecture

### The Pipeline

```
[Browser Client] ←WebSocket→ [MicdropServer] → {STT, Agent, TTS}
                                    │
                                    ├── STT: audio stream → transcript
                                    ├── Agent: transcript → text stream (LLM)
                                    └── TTS: text stream → audio stream
```

Flow per conversational turn:
1. Client detects speech (VAD), sends `StartSpeaking` command
2. Client streams PCM audio chunks over WebSocket
3. Client detects silence, sends `StopSpeaking`
4. Server: STT transcribes audio stream → emits `Transcript`
5. Server: Agent adds user message, generates answer as a text `Readable` stream
6. Server: TTS consumes text stream, emits audio `Buffer` chunks
7. Server sends audio chunks back to client over WebSocket
8. Client plays audio via Web Audio API

### Three Core Abstractions (abstract classes extending EventEmitter)

**Agent** (`packages/server/src/agent/Agent.ts:77-338`):
- `generateAnswer(stream: PassThrough): Promise<void>` — abstract, streams tokens
- `cancel(): void` — abstract, aborts in-flight requests
- `answer(): Readable` — returns a text stream
- `addUserMessage(text, metadata?)` / `addAssistantMessage(text, metadata?)`

**STT** (`packages/server/src/stt/STT.ts:10-24`):
- `transcribe(audioStream: Readable): void` — abstract
- Emits: `Transcript [string]`, `Failed [Buffer[]]`

**TTS** (`packages/server/src/tts/TTS.ts:10-24`):
- `speak(textStream: Readable): void` — abstract
- `cancel(): void` — abstract
- Emits: `Audio [Buffer]`, `Failed [string[]]`

### Orchestrator: MicdropServer

`MicdropServer` (`packages/server/src/MicdropServer.ts:29-321`) wires everything:
- Takes a `WebSocket` and a `MicdropConfig` (`agent`, `stt`, `tts`, optional `firstMessage`)
- Subscribes to STT `Transcript` → adds user message → triggers `answer()`
- Subscribes to Agent `Message` → forwards to client via WebSocket
- Subscribes to TTS `Audio` → sends audio chunks to client
- Manages an **operation queue** to serialize answer/speak operations
- Handles interruption: when user starts speaking, `cancel()` is called on TTS and Agent

## Plugin/Extension System

No formal plugin registry. Uses **abstract class extension** — implement `Agent`, `STT`, or `TTS` and pass instances to `MicdropServer`.

### Fallback System (Resilience)

`FallbackAgent`, `FallbackSTT`, `FallbackTTS` chain multiple providers and switch on failure. The `Failed` event carries unprocessed data so the next provider can replay it.

```typescript
// FallbackTTS (packages/server/src/tts/FallbackTTS.ts:9-70)
private onFailed = (chunks: string[]) => {
  this.startNextTTS()
  if (chunks.length > 0) {
    const stream = new PassThrough()
    this.tts?.speak(stream)
    chunks.forEach((chunk) => stream.write(chunk))
    stream.end()
  }
}
```

### Tools System

```typescript
export interface Tool<Schema extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  inputSchema?: Schema
  execute?: (input: z.infer<Schema>, agent: Agent) => any | Promise<any>
  skipAnswer?: boolean
  emitOutput?: boolean
}
```

Tools receive the `agent` as context (portable across FallbackAgent rotations). Built-in auto-tools: `end_call`, `semantic_turn`, `ignore_user_noise`.

## Real-Time Audio Handling

### Client-Side Capture
- **Format**: 16-bit PCM, 16kHz, mono
- **AudioWorklet** runs in a separate audio thread, resamples device rate → 16kHz via linear interpolation
- Emits chunks every 100ms
- **VAD-gated streaming**: three-phase detection (StartSpeaking → ConfirmSpeaking → CancelSpeaking/StopSpeaking)
- **Delayed stream**: mic stream delayed by VAD detection delay (~100ms) to avoid cutting speech start

### Client-Side Playback
- **Prebuffering**: waits 100ms before starting playback to avoid underruns
- **Gapless scheduling**: uses `nextStartTime` to schedule `AudioBufferSourceNode` right after previous ends
- **Quiet flush**: if no chunk for 600ms during prebuffering, starts anyway

## Transport Layer

WebSocket only — no WebRTC. Protocol:
- **Client → Server**: `StartSpeaking`, `StopSpeaking`, `Mute` (string messages, < 15 bytes)
- **Server → Client**: `Message` + JSON, `CancelLastUserMessage`, `SkipAnswer`, `EndCall`, `ToolCall` + JSON
- **Binary frames**: raw PCM audio chunks (both directions)
- Command detection by message size (`byteLength < 15`) — fragile

### Client Reconnection
- Categorizes close codes (4400=BadRequest, 4401=Unauthorized, 1011=InternalServer)
- Only reconnects on recoverable errors
- Exponential backoff with configurable `maxAttempts`, `delayMs`, `connectionTimeout`

## Provider Integrations

| Package | Provides | Transport | Notes |
|---------|----------|-----------|-------|
| `@micdrop/openai` | Agent + STT + TTS | HTTP (TTS) + WebSocket (STT) | OpenAI Responses API streaming |
| `@micdrop/ai-sdk` | Agent | Vercel AI SDK | Multi-provider via `LanguageModel` |
| `@micdrop/elevenlabs` | TTS | HTTP streaming | Sentence-buffered synthesis |
| `@micdrop/cartesia` | TTS | WebSocket | Real-time streaming with `context_id` |
| `@micdrop/gradium` | STT + TTS | WebSocket | Sovereign EU provider |
| `@micdrop/mistral` | Agent + STT | HTTP | |
| `@micdrop/gladia` | STT | WebSocket | |

## Build & Dev

- **Bundler**: tsup (esbuild-based) for all packages
- **TypeScript**: 5.9.3, per-package `tsconfig.json`
- **Formatting**: Prettier (semi: false, singleQuote: true, trailingComma: es5)
- **Tests**: None — manual scripts in `examples/demo-server/src/tests/`
- **Build order**: server + client first (sequential), then providers in parallel

## Patterns to Adopt

1. **Three-abstraction model** (Agent/STT/TTS as abstract classes with stream interfaces)
2. **Stream-based pipeline** with `PassThrough` for natural backpressure
3. **Fallback pattern with data replay** for provider resilience
4. **VAD three-phase state machine** (Start → Confirm → Cancel/Stop)
5. **Counter-based cancellation** for invalidating in-flight work
6. **Portable tools** that receive context rather than binding to instances
7. **Operation queue** for serializing concurrent operations
8. **Prebuffered gapless audio playback** with quiet flush
9. **Sentence-buffered TTS** with sequential processing for non-streaming TTS APIs

## Patterns to Avoid

1. **No formal plugin system** — no registry, lifecycle hooks, middleware, or dynamic registration
2. **Client-server type coupling** — client re-exports from server source (`export * from '../../server/src/types'`)
3. **No test framework** — significant risk for a production SDK
4. **Global singleton client** — `window.micdropClient` prevents concurrent instances, SSR issues
5. **Pervasive `any` types** — `Logger.log(...message: any[])`, `Tool.execute` returns `any`
6. **`console.error` instead of structured logging**
7. **No backpressure on WebSocket sends** — doesn't check `bufferedAmount`
8. **Fragile command detection** — `message.byteLength < 15` to distinguish commands from audio
9. **WebSocket-only transport** — no transport abstraction
