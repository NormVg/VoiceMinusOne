# VoiceMinusOne — Project Document

> **Last updated**: 2026-08-09
> **Status**: Real-time runtime migration in progress
> **Stack**: TypeScript, Node.js, pnpm monorepo, Nuxt v4, crossws, Ably, AI SDK 7, Sarvam AI
> **No Python.** Pure TypeScript/Node.js end to end.

> **Active execution plan**: [`plan.md`](./plan.md). The current runtime is
> being rebuilt around bounded streaming sessions, beginning with the live
> LLM-to-TTS orchestration path.

## Real-time migration status

- [x] Streaming provider contracts, bounded runtime primitives, and turn-scoped cancellation.
- [x] Server live-STT frame routing with batch-provider fallback.
- [x] Concurrent Brain-to-TTS phrase scheduling and browser playback cancellation.
- [ ] Persistent provider connections, AudioWorklet capture, protocol V2, and full trace-based E2E verification.

---

## What Is VoiceMinusOne

VoiceMinusOne is a **plugin-based voice SDK for application-based AI voice agents** — chat apps, co-pilots, creative tools, in-browser assistants. The user sits at a device with a mic and speakers, and an AI agent is embedded in their app.

**Not telephony.** Not WebRTC. Application-based real-time voice over WebSockets and pub/sub.

The SDK provides a real-time voice layer for AI agents. Every segment — STT, TTS, LLM, transport, VAD, audio processing, turn-taking — is a swappable plugin. No vendor lock-in. Clean, simple, abstracted APIs for developers to use the SDK and to create their own plugins.

---

## Design Principles

1. **Plugin-first architecture** — Every capability (STT, TTS, LLM, transport, VAD, audio processing) is a swappable plugin with a TypeScript interface. Core has zero opinions on providers.
2. **No vendor lock-in** — Users can swap any plugin without changing application code. Provider packages export factories (`sarvam.stt({...})`, `sarvam.tts({...})`).
3. **Frame-based core, stream-based providers** — Internally, data flows as typed Frames through a directional pipeline (downstream + upstream) for observability, interruption handling, and middleware composability. Providers implement simple async iterables/streams that the framework adapts to frames. Best of both worlds: pipecat-level composability with micdrop-level provider simplicity.
4. **No god classes** — Voice-line's 577-line Session was the root cause of "everything always breaking." Split concerns into focused, independently testable components.
5. **No `any`** — Every interface, adapter, and handler is fully typed. Framework adapters (Nuxt, Next, crossws) define minimal typed interfaces, never `any`.
6. **No silent errors** — Every `catch` logs to a debug channel at minimum. Wire protocol events are validated with zod.
7. **No side effects on import** — Importing any module never triggers connections, timers, or network calls. All initialization happens in explicit `start()` / `init()` calls.
8. **Observable** — All significant operations emit events. Every frame can be observed via the pipeline observer system. Structured logging with levels, not `console.log`.
9. **Pure TypeScript/Node.js** — No Python anywhere. VAD model inference via ONNX Runtime Web (WASM). Audio processing via Web Audio API (browser) / AudioWorklet.
10. **Production-grade from day one** — Tests (Vitest), structured errors, backpressure, reconnection, wire protocol validation.

---

## Architecture

### Hybrid Pipeline Model

The core is a **frame-based directional pipeline** (inspired by pipecat) with **stream adapters at provider boundaries** (inspired by micdrop).

```
                    DOWNSTREAM →
┌──────────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌──────────┐
│ Transport │───→│ STT │───→│ LLM │───→│ TTS │───→│ Transport│
│  Input    │    └─────┘    └─────┘    └─────┘    │  Output  │
└──────────┘                                    └──────────┘
                    ← UPSTREAM
              (errors, interruptions, acknowledgments)
```

**Why hybrid:**
- **Frames internally** → every piece of data is a typed Frame. Interruptions are instant (push an InterruptionFrame upstream). Errors propagate automatically. Observability is uniform (one observer interface monitors the entire pipeline). Middleware (audio filters, telemetry, turn-taking hooks) plugs in as pipeline processors.
- **Streams at boundaries** → providers implement simple async iterables (`AsyncIterable<Frame>`) or Node streams. The framework adapts them to the frame pipeline. Providers don't need to understand the frame system — they just implement `transcribe(audio): AsyncIterable<TranscriptFrame>` or `synthesize(text): AsyncIterable<AudioFrame>`.

### Core Abstractions

#### Frame
The universal data unit. Every piece of data — audio chunks, text tokens, transcription results, control signals, lifecycle events — is a typed Frame.

```typescript
interface Frame {
  readonly id: number
  readonly kind: FrameKind
  readonly pts?: number
  readonly metadata?: Record<string, unknown>
}

enum FrameKind {
  // Lifecycle
  Start, End, Cancel, Stop,
  // Audio
  AudioRaw, TTSAudioRaw,
  // Text
  Text, LLMText, Transcript, InterimTranscript, AggregatedText,
  // Turn-taking
  UserStartedSpeaking, UserStoppedSpeaking,
  BotStartedSpeaking, BotStoppedSpeaking,
  Interruption,
  // LLM
  LLMFullResponseStart, LLMFullResponseEnd,
  ToolCall, ToolResult,
  // Error
  Error,
}
```

**Three priority tiers** (from pipecat):
1. **SystemFrame** — processed immediately, jumps the queue (Start, Cancel, Interruption, UserStartedSpeaking). Critical for voice — a 500ms delay on an interruption means the bot talks over the user.
2. **DataFrame** — processed in order, cancelled by interruptions (AudioRaw, Text, Transcript).
3. **ControlFrame** — processed in order, cancelled by interruptions (End, TTSStopped).

#### FrameProcessor
The base processing unit. Each processor receives frames, processes them, and pushes results downstream or upstream.

```typescript
abstract class FrameProcessor {
  abstract processFrame(frame: Frame, direction: FrameDirection): Promise<void>
  pushFrame(frame: Frame, direction?: FrameDirection): Promise<void>
  link(processor: FrameProcessor): void  // Forms doubly-linked list
}

enum FrameDirection { Downstream, Upstream }
```

**Dual-queue priority** (from pipecat): System frames are processed immediately via a priority channel. Data frames are processed in order via a secondary queue. This guarantees sub-millisecond interruption response even with a full audio buffer.

#### Pipeline
Chains FrameProcessors in sequence. A Pipeline is itself a FrameProcessor, so pipelines can nest.

```typescript
const pipeline = new Pipeline([
  transport.input(),
  vadProcessor,
  sttProcessor,
  userAggregator,
  llmProcessor,
  ttsProcessor,
  transport.output(),
  assistantAggregator,
])
```

#### Transport
A pair of FrameProcessors — `input()` (receives from network, pushes into pipeline) and `output()` (receives from pipeline, sends to network). Base classes handle buffering, chunking, resampling, bot-speaking detection. Concrete transports implement only `writeAudioFrame()` and the receive loop.

```typescript
abstract class Transport {
  abstract input(): FrameProcessor
  abstract output(): FrameProcessor
}
```

#### Plugin Interfaces

Each segment has a TypeScript interface. Providers implement the interface and export a factory function. Plugins receive a `PluginContext` with lifecycle hooks, event bus, and logger.

```typescript
// STT
interface STTProvider {
  transcribe(audio: AsyncIterable<AudioChunk>, config: STTConfig): AsyncIterable<TranscriptResult>
  abort?(): void
}

// TTS
interface TTSProvider {
  synthesize(text: string, config: TTSConfig): AsyncIterable<AudioChunk>
  abort?(): void
}

// LLM (Brain)
type Brain = (
  userText: string,
  context: BrainContext
) => Promise<string> | AsyncGenerator<string>

// VAD
interface VADProvider {
  analyze(audio: Float32Array): VADResult
  // Or streaming: process(audioStream): AsyncIterable<VADEvent>
}

// Audio Processor (middleware)
interface AudioProcessor {
  process(audio: Float32Array): Float32Array
}
```

```typescript
// Plugin context — given to every plugin
interface PluginContext {
  logger: Logger
  events: EventBus
  clock: Clock
  signal: AbortSignal
}

// Lifecycle hooks
interface PluginLifecycle {
  init?(context: PluginContext): Promise<void>
  start?(): Promise<void>
  stop?(): Promise<void>
  destroy?(): Promise<void>
}
```

### Session Architecture (NOT a god class)

Voice-line's mistake was a 577-line Session that owned everything. VoiceMinusOne splits the session into focused components:

```
Session
├── SessionStateMachine   — state transitions (idle → connected → listening → speaking → ...)
├── TurnManager            — turn-taking, interruption, barge-in
├── AudioRouter            — routes audio between transport, VAD, STT, TTS
├── HistoryManager         — conversation history
├── PipelineRunner         — drives the frame pipeline
└── ReconnectionManager    — handles transport reconnection with backoff
```

Each component is independently testable. The Session coordinates them but doesn't contain their logic.

### Wire Protocol

**Binary frames** → audio (raw PCM, never base64-encoded).
**Text frames** → JSON events, validated with zod on receipt.

```typescript
// Client → Server
type ClientToServerEvent =
  | { type: 'start_speaking' }
  | { type: 'stop_speaking' }
  | { type: 'mute'; muted: boolean }
  | { type: 'config_update'; config: Partial<SessionConfig> }

// Server → Client
type ServerToClientEvent =
  | { type: 'message'; message: ConversationMessage }
  | { type: 'transcript'; text: string; isFinal: boolean }
  | { type: 'bot_text'; text: string; messageId: string }
  | { type: 'bot_text_done'; messageId: string; partial: boolean }
  | { type: 'audio_flush' }
  | { type: 'tool_call'; tool: ToolCallInfo }
  | { type: 'error'; code: string; message: string }
  | { type: 'state'; state: SessionState }
```

**No heuristic binary/text detection.** Use the WebSocket frame type (binary vs text) directly from the transport layer. If the transport doesn't provide this (crossws edge case), fix the transport — never guess from byte values.

### Audio Handling

- **Format**: 16-bit PCM, 16kHz, mono (input); 24kHz mono (output, TTS-dependent)
- **Client capture**: AudioWorklet (never ScriptProcessorNode), resamples device rate → 16kHz
- **Client playback**: Prebuffered (100ms) gapless scheduling via Web Audio API
- **VAD**: Three-phase state machine (StartSpeaking → ConfirmSpeaking → CancelSpeaking/StopSpeaking) with delayed stream to avoid cutting speech start
- **VAD providers**: Silero VAD via ONNX Runtime Web (WASM) as default; energy-based as zero-dependency fallback. VAD is a plugin.
- **No base64 audio** — binary WebSocket frames or Ably binary extras
- **Backpressure**: Check `bufferedAmount` before WebSocket sends. `eagerStream` with bounded queue.

### Reconnection

- Automatic reconnection with exponential backoff
- Categorizes close codes (only reconnect on recoverable errors)
- Pauses VAD while offline
- Session resumption (reconnect to same session if server supports it)

---

## Monorepo Structure

```
VoiceMinusOne/
├── packages/
│   ├── core/              # Frame types, FrameProcessor, Pipeline, Session, plugin interfaces
│   ├── server/            # Server runtime, session manager, crossws/Nitro handlers
│   ├── client/            # Browser: mic, speaker, VAD, AudioWorklet, VoiceMinusOneClient
│   ├── transport-ws/      # WebSocket transport (crossws for Nuxt, ws for Node)
│   ├── transport-ably/    # Ably pub/sub transport
│   ├── provider-sarvam/    # Sarvam STT (Saaras v3) + TTS (Bulbul v3)
│   ├── adapter-ai-sdk/     # Vercel AI SDK 7 → Brain adapter
│   ├── vad-silero/        # Silero VAD via ONNX Runtime Web
│   ├── vad-energy/        # Energy-based VAD (zero-dependency fallback)
│   └── nuxt/              # Nuxt v4 server module
├── examples/
│   ├── standalone/         # Minimal WS server + client
│   ├── nuxt-app/           # Nuxt v4 + WS + Sarvam + AI SDK
│   └── nuxt-ably/          # Nuxt v4 + Ably + Sarvam + AI SDK
├── .info/
│   ├── guides/             # Reference guides (micdrop.md, pipecat.md, voice-line.md)
│   └── repo/               # Cloned reference repos
├── project.md              # This file
├── AGENTS.md               # Agent instructions
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── biome.json
```

### Package Dependency Graph

```
        @voiceminusone/core (types, interfaces, pipeline, session)
               │
   ┌───────────┼──────────────────────┐
   ▼           ▼                      ▼
 /server    /client              /transport-*
               │       ┌──────────┴──────────┐
               ▼       ▼                     ▼
            /nuxt   /provider-*          /adapter-ai-sdk
                   /vad-*
```

- `core` is the foundation — types, interfaces, pipeline, session. No provider dependencies.
- Everything depends on `core`. No cross-dependencies between leaf packages.
- `core` exports a shared types package — no client→server source coupling (micdrop's mistake).

---

## Tech Stack

| Concern | Technology |
|---------|-----------|
| Language | TypeScript (strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Runtime | Node.js >=20 |
| Package manager | pnpm with workspaces |
| Bundler | tsup (esbuild-based) |
| Test framework | Vitest |
| Linter/formatter | Biome |
| Schema validation | zod (wire protocol, config) |
| WebSocket (Nuxt) | crossws (via Nuxt v4/Nitro) |
| WebSocket (Node) | ws |
| Pub/sub transport | Ably |
| AI/LLM | Vercel AI SDK 7 (`ai` package) |
| STT | Sarvam AI (Saaras v3) |
| TTS | Sarvam AI (Bulbul v3) |
| VAD | Silero (ONNX Runtime Web) + energy-based fallback |
| Audio (browser) | Web Audio API, AudioWorklet |
| Framework integration | Nuxt v4 server module |

---

## Plugin System

### How Plugins Work

Every segment is a plugin with a TypeScript interface. Providers export factory functions for clean DX:

```typescript
import { sarvam } from '@voiceminusone/provider-sarvam'
import { aiSdkBrain } from '@voiceminusone/adapter-ai-sdk'
import { wsTransport } from '@voiceminusone/transport-ws'
import { sileroVAD } from '@voiceminusone/vad-silero'

const session = createVoiceSession({
  transport: wsTransport({ url: 'ws://localhost:3000/ws' }),
  stt: sarvam.stt({ apiKey: process.env.SARVAM_API_KEY, model: 'saaras:v3' }),
  tts: sarvam.tts({ apiKey: process.env.SARVAM_API_KEY, model: 'bulbul:v3', speaker: 'shubh' }),
  brain: aiSdkBrain({ model: openai('gpt-4o') }),
  vad: sileroVAD(),
})
```

### Plugin Lifecycle

Plugins receive a `PluginContext` with lifecycle hooks:

```typescript
interface Plugin {
  readonly name: string
  init?(context: PluginContext): Promise<void>
  start?(): Promise<void>
  stop?(): Promise<void>
  destroy?(): Promise<void>
}
```

### Adding a New Provider

1. Create a package under `packages/provider-<name>/`
2. Depend on `@voiceminusone/core`
3. Implement the interface (`STTProvider`, `TTSProvider`, `VADProvider`, etc.)
4. Export a factory function
5. Write tests

```typescript
// Example: new STT provider
import type { STTProvider, STTConfig, TranscriptResult, AudioChunk } from '@voiceminusone/core'

export interface MySTTOptions {
  apiKey: string
  model?: string
}

export class MySTT implements STTProvider {
  constructor(private options: MySTTOptions) {}

  async *transcribe(audio: AsyncIterable<AudioChunk>, config: STTConfig): AsyncIterable<TranscriptResult> {
    for await (const chunk of audio) {
      // Send to your STT API, yield transcripts
      yield { text: '...', isFinal: false }
    }
  }

  abort(): void { /* cancel in-flight requests */ }
}

// Factory
export const myStt = (options: MySTTOptions): STTProvider => new MySTT(options)
```

### Middleware (Pipeline Processors)

Audio filters, telemetry, and conversation hooks plug in as pipeline processors:

```typescript
import { noiseSuppression, telemetry, turnTaking } from '@voiceminusone/core'

const pipeline = new Pipeline([
  transport.input(),
  noiseSuppression(),     // audio filter middleware
  vadProcessor,
  sttProcessor,
  telemetry(),             // observability middleware
  turnTaking(),           // turn-taking middleware
  llmProcessor,
  ttsProcessor,
  transport.output(),
])
```

---

## Coding Rules

1. **No raw time** — Use the `Clock` interface, never `Date.now()` directly in core/plugin code.
2. **Interface-first design** — Every plugin category has its interface defined BEFORE any implementation. Interface lives in `core/src/interfaces/`.
3. **Structured errors** — All errors extend `VoiceMinusOneError` with a machine-readable `code`. Never throw raw `Error()`.
4. **No side effects on import** — No connections, timers, or network calls on import. All init in `start()` / `init()`.
5. **DAG dependency graph** — Module dependencies form a DAG. No circular imports. `core/ ← server/ ← plugins/ ← integrations/`.
6. **No `any`** — Every interface, adapter, and handler is fully typed. Framework adapters define minimal typed interfaces.
7. **No `console.log` in library code** — Use the injectable `Logger` interface with levels.
8. **No silent errors** — Every `catch` logs to a debug channel at minimum.
9. **Wire protocol validation** — All incoming events validated with zod.
10. **No base64 audio** — Binary WebSocket frames or Ably binary extras.
11. **No deprecated Web APIs** — Use `AudioWorkletNode`, never `ScriptProcessorNode`.
12. **No god classes** — Split concerns into focused, independently testable components.
13. **No `process.env` in core** — Configuration passed programmatically. Environment reading only in entry points.
14. **Clean async** — All async functions have proper error handling. No floating promises. Every `Promise` awaited or explicitly handled.
15. **Test naming** — `<module>.test.ts`, next to source or in mirrored `__tests__/`.
16. **Export hygiene** — Each package's `index.ts` explicitly re-exports only the public API.
17. **No Python** — Pure TypeScript/Node.js end to end.

---

## Build & Dev

```bash
pnpm install              # Install dependencies
pnpm build                # Build all packages (core first, then providers in parallel)
pnpm dev                  # Watch mode for all packages
pnpm test                 # Run all tests
pnpm --filter @voiceminusone/core test   # Test specific package
pnpm --filter @voiceminusone/core typecheck  # Type-check specific package
pnpm lint                 Lint with Biome
pnpm format               # Format with Biome
```

**Build order**: `core` first (sequential), then all other packages in parallel. Respects the dependency graph.

---

## Reference Projects

Three reference repos are cloned under `.info/repo/` with distilled guides under `.info/guides/`:

| Repo | What we learn | Guide |
|------|--------------|-------|
| **micdrop** | Three-abstraction model (Agent/STT/TTS), stream-based pipeline, fallback chains, VAD state machine, prebuffered playback | `.info/guides/micdrop.md` |
| **pipecat** | Frame-based directional pipeline, dual-queue priority, transport as processor pair, NOT_GIVEN settings sentinel | `.info/guides/pipecat.md` |
| **voice-line** | What NOT to do: god-class Session, broken pipeline for async STT, pervasive `any`, silent data corruption, no validation | `.info/guides/voice-line.md` |

---

## Implementation Phases

### Phase 1: Foundation ✅
- [x] Monorepo setup (pnpm workspace, tsconfig.base.json, biome.json, tsup)
- [x] `@voiceminusone/core` — Frame types, FrameProcessor, Pipeline, plugin interfaces, errors, logger, clock
- [x] `@voiceminusone/core` tests (Vitest)

### Phase 2: Server & Client Core ✅
- [x] `@voiceminusone/server` — Session (split components), session manager, pipeline runner
- [x] `@voiceminusone/client` — MicdropClient, mic (AudioWorklet), speaker (prebuffered gapless), VAD three-phase state machine
- [x] `MemoryTransport` for testing
- [x] Integration tests with real WebSocket

### Phase 3: Transports ✅
- [x] `@voiceminusone/server` WebSocket transport (client + server), crossws adapter for Nuxt/Nitro
- [x] `@voiceminusone/transport-ably` — Ably pub/sub transport (binary extras, not base64)
- [x] Transport tests

### Phase 4: Providers ✅
- [x] `@voiceminusone/provider-sarvam` — Sarvam STT (Saaras v3, WebSocket streaming) + TTS (Bulbul v3, HTTP streaming)
- [x] `@voiceminusone/adapter-ai-sdk` — Vercel AI SDK 7 → Brain adapter
- [x] `@voiceminusone/vad-silero` — Silero VAD via ONNX Runtime Web
- [x] `@voiceminusone/vad-energy` — Energy-based VAD fallback
- [x] Provider tests

### Phase 5: Nuxt Integration ✅
- [x] `@voiceminusone/nuxt` — Nuxt v4 server module (crossws WebSocket handler, session management)
- [x] Example: Nuxt v4 + WS + mock providers
- [ ] Example: Nuxt v4 + WS + Sarvam + AI SDK (needs API keys)

### Phase 6: Polish & Release (current)
- [ ] Reconnection logic with backoff
- [ ] Backpressure on all sends
- [ ] Observability (telemetry middleware, metrics)
- [ ] Documentation
- [ ] Standalone example app

---

## Key Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-09 | Hybrid pipeline (frames + streams) | Best for infra, scalability, observability, stability. Frame-based core for composability; stream adapters for provider simplicity. |
| 2026-08-09 | Interfaces + factories + context (no central registry) | Every segment is a plugin with a TS interface. Providers export factories. Plugins get lifecycle hooks + context. No registry overhead. |
| 2026-08-09 | Both VAD approaches, ML default | Silero VAD (ONNX Runtime Web) as default for accuracy; energy-based as zero-dependency fallback. VAD is a plugin. |
| 2026-08-09 | Nuxt v4 only, no Vue standalone | Nuxt v4 server module. No standalone Vue composable package. |
| 2026-08-09 | Pure TypeScript/Node.js | No Python anywhere. Pipecat was reference only. VAD via WASM, not Python. |
| 2026-08-09 | No WebRTC | Provider availability is hard. WebSocket + Ably only. |
| 2026-08-09 | crossws for Nuxt WebSocket | Required for Nuxt/Nitro WebSocket integration. |
| 2026-08-09 | AI SDK 7 for LLM | Vercel AI SDK 7 as the LLM abstraction layer. |
| 2026-08-09 | Sarvam for STT + TTS | Sarvam AI (Saaras v3 STT, Bulbul v3 TTS) as primary voice provider. |
