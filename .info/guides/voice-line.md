# Reference Guide: voice-line

> **Repository**: `github.com/NormVg/voice-line` (TypeScript/pnpm monorepo)
> **Location**: `.info/repo/voice-line`
> **Status**: WIP, v0.0.0 | **Package manager**: pnpm 9.15.4 | **Bundler**: tsup | **Linter**: Biome

## What It Is

Voice-line is a previous attempt at building a real-time voice agent SDK by the same developer. Its tagline: *"The real-time voice layer for AI agents. You bring the brain — we handle the ears and mouth."* No WebRTC, no infrastructure — just WebSockets and pub/sub (Ably). The framework handles the audio pipeline (VAD, STT, TTS, chunking, interruptions) while the developer supplies the LLM "brain."

The git log reveals a project that was functional but chronically unstable — nearly every recent commit is a `fix:`.

## Monorepo Structure

| Package | Purpose |
|---------|---------|
| `@voice-line/core` | Types, interfaces, Pipeline, Session, VAD, chunker |
| `@voice-line/server` | Server runtime, session manager, Next/Nitro handlers |
| `@voice-line/client` | Browser: mic, speaker, `VoiceLineClient` |
| `@voice-line/vue` | Vue 3 `useVoiceAgent` composable |
| `@voice-line/react` | React `useVoiceAgent` hook |
| `@voice-line/transport-ws` | Raw WebSocket transport (client + server) |
| `@voice-line/transport-ably` | Ably pub/sub transport |
| `@voice-line/provider-sarvam` | Sarvam STT (Saaras) + TTS (Bulbul) |
| `@voice-line/adapter-ai-sdk` | Vercel AI SDK → Brain adapter |

## Core Architecture

### Five Abstractions

1. **Session** — A single conversation. Owns transport, both pipelines, history, state machine, interruption logic. (`packages/core/src/session/session.ts:105-577`)
2. **Transport** — Moves binary audio + JSON events. Knows nothing about audio semantics or AI.
3. **Pipeline** — Ordered chain of `Processor` instances. Each receives a `Frame`, transforms it, emits 0+ frames.
4. **Brain** — Developer's LLM logic. A function `(userText, context) => Promise<string> | AsyncGenerator<string>`.
5. **Provider** — Pluggable STT/TTS. Stateless factories.

### Data Flow

```
Inbound:  Mic → Transport → [VAD → STT] → Brain
Outbound: Brain → [Chunker] → TTS → Transport → Speaker
```

### Session State Machine

```
idle → connected → listening ↔ receiving → processing → speaking → listening
                                                              ↓
                                                           closed
```

## What Worked (What to Salvage)

1. **The 5-abstraction domain model** — Session / Transport / Pipeline / Brain / Provider is a clean separation of concerns (on paper).
2. **The Transport interface** — `sendAudio`/`onAudio`/`sendEvent`/`onEvent`/`state` is minimal and correct. The `Unsubscribe` return pattern is consistent.
3. **The Brain abstraction** — a function returning `string | AsyncGenerator<string>` is the right level of abstraction.
4. **The serial TTS queue** — `ttsTail` promise chain ensures audio order. Shorter later sentences can't finish before longer earlier ones.
5. **The `eagerStream()` helper** — decouples brain token streaming from TTS synthesis. TTS starts on the first sentence while the brain keeps generating.
6. **The event protocol** — typed discriminated unions for `ServerToClientEvent` and `ClientToServerEvent`.
7. **`MemoryTransport`** for testing — linked transport pairs enable good integration tests.
8. **The `VoiceLineError`** class with typed `ErrorCode`.
9. **The provider factory pattern** — `sarvam.stt({...})`, `sarvam.tts({...})`. Good DX.
10. **WS integration tests** — real WebSocket servers in tests, not mocks.

## What is WRONG (Critical)

### 1. Session.ts is a 577-line God Class

`packages/core/src/session/session.ts:105-577` — The `Session` class owns **everything**:
- State machine (7 states, transitions scattered across 10+ methods)
- Both pipelines (inbound + outbound)
- TTS serial queue (`ttsTail`, `ttsGeneration`)
- Brain execution (`runBrainTurn`)
- Interruption logic (`interruptTurn`)
- Transcript queue for barge-in
- Message history
- Transport wiring
- Timer management (max duration, idle timeout, processing watchdog)
- Assistant message accumulation

This is the **#1 reason "everything is always breaking."** Every change risks breaking something else. The git log confirms: fixes to chunker, VAD, barge-in, and TTS ordering all touch this file.

### 2. The Pipeline Abstraction is Broken for STT

`packages/core/src/pipeline/stt-processor.ts:14-108` — The `Pipeline` is designed as a synchronous chain: `push(frame) → processors → listeners`. But `STTProcessor` breaks this:

```typescript
constructor(options: {
  provider: STTProvider
  onTranscript: TranscriptHandler  // ← side-channel callback
  onError?: (error: Error) => void
})
```

STT results arrive asynchronously via `onTranscript`, which calls `session.handleTranscript()` directly — **bypassing the pipeline entirely**. The `TranscriptFrame` type exists but is never emitted by the pipeline. The pipeline abstraction is a lie for the inbound path.

### 3. The Outbound Pipeline is Barely a Pipeline

```typescript
this.outbound = new Pipeline([new SentenceChunker(chunkerConfig)]);
this.outbound.onFrame((frame) => {
  if (frame.kind === "sentence") {
    this.enqueueSentence(frame.text);  // ← outside the pipeline
  }
});
```

TTS synthesis and audio sending happen entirely outside the pipeline via `enqueueSentence()`. The pipeline adds ceremony without benefit.

### 4. Pervasive `any` in Framework Adapters

```typescript
// nitro.ts:148
export function nitroToWs(peer: any, listeners: Record<string, Function[]>): any
// next.ts:146
export function createNextWebSocketHandler(
  configFactory: (client: any, req: any) => ...
)
```

Every framework adapter parameter is `any`. `Function[]` (capital F) is also wrong — should be `(...args: unknown[]) => void`.

### 5. The Nitro WebSocket Handler is Fragile — Silent Data Corruption

`packages/server/src/nitro.ts:214-224`:

```typescript
if (isBinary && raw && typeof raw === "object") {
  const buf = Buffer.isBuffer(raw) ? raw : new Uint8Array(raw as any);
  if (buf[0] === 123) { // 123 is '{'
    try {
      JSON.parse(new TextDecoder().decode(buf));
      isBinary = false; // It's valid JSON, so it's a text frame!
    } catch { /* Not valid JSON, keep as binary */ }
  }
}
```

This checks if the first byte is `{` (123) to guess whether a binary frame is actually JSON. **Any audio chunk whose first PCM16 sample happens to be 123 (0x007B) will be misinterpreted as text.** This is silent data corruption.

### 6. Console.log in Production Library Code

| File:Line | What's logged |
|-----------|--------------|
| `session.ts:222-225` | Every 10 audio chunks with byte length |
| `ably.ts:97-101` | Every Ably connection state change |
| `ably.ts:127` | Every received event |
| `client.ts:124` | Every received server event type |
| `client.ts:145` | "Connected, setting state to listening" |

These logs pollute the consumer's console and cannot be disabled.

### 7. ScriptProcessorNode is Deprecated

Both `packages/client/src/mic.ts:59` and `packages/client/src/speaker.ts:36` use `createScriptProcessor()` — deprecated, runs audio on the main thread, causes UI jank. Should use `AudioWorkletNode`.

### 8. `mapSessionState` is Backwards

```typescript
case "connected":      // Server says "connected"
  return "connecting"; // Client shows "connecting" ← BACKWARDS
```

### 9. Race Conditions in Session Lifecycle

`runBrainTurn()` calls `interruptTurn()` at the start, which aborts brain, aborts TTS, bumps `ttsGeneration`, sends flush events. But if a new turn starts while the old turn's async cleanup hasn't fully settled, events interleave. The `ttsGeneration` counter is a band-aid.

### 10. The `transcriptQueue` Can Lose Messages

If `runBrainTurn` throws or the session is destroyed during the turn, queued transcripts are silently lost because the `finally` block checks `!this.destroyed`.

### 11. No Reconnection Logic

Zero reconnection logic. Transport disconnects → session closes → done. No retry, no backoff, no session resumption.

### 12. `eagerStream` Has No Backpressure

The `eagerStream()` function eagerly consumes the source iterable into an unbounded queue. If the consumer (TTS) is slower than the producer (brain), the queue grows without limit.

### 13. VAD is Energy-Based Only

```typescript
const energy = rmsEnergy(samples);
const confidence = Math.min(1, energy * 8);  // ← RMS × 8 as "confidence"
```

No Silero or ML-based VAD. Energy-based VAD can't distinguish speech from background noise, keyboard typing, or breathing.

### 14. Error Swallowing

| File:Line | Pattern |
|-----------|---------|
| `socket.ts:135-137` | `catch { /* ignore malformed JSON */ }` |
| `ws.ts:133-135` | `catch { /* ignore */ }` on close |
| `session.ts:266-268` | `.catch(() => {})` on pipeline/transport destroy |

### 15. No Wire Protocol Validation

Events are parsed with `JSON.parse()` and used directly. No schema validation (zod, valibot). A malformed event with a wrong `type` field could crash the session's `switch` statement.

### 16. Duplicated Utility Functions

The `concat(Array)Buffers` function is implemented **three times**:
- `packages/core/src/pipeline/vad.ts:119-127`
- `packages/core/src/utils/audio.ts:65-74`
- `packages/provider-sarvam/src/stt.ts:255-264`

## Lessons for VoiceMinusOne

### AVOID

1. **Don't build a god-class Session.** Split into: `SessionStateMachine`, `TurnManager`, `AudioRouter`, `HistoryManager`. Each independently testable.
2. **Don't break your own pipeline abstraction.** If STT results arrive asynchronously, make the pipeline async-native (processors return `AsyncGenerator<Frame>`) or use an explicit event bus.
3. **Don't use `any` in framework adapters.** Define minimal interfaces for Nitro peers, Next requests. Even a 5-field interface is better than `any`.
4. **Don't use deprecated Web APIs.** Use `AudioWorkletNode` from day one.
5. **Don't leave `console.log` in library code.** Use an injectable logger interface.
6. **Don't duplicate utility functions.** Put them in `core/utils` and import everywhere.
7. **Don't use energy-based VAD as the only option.** Integrate Silero VAD from the start, with energy-based as fallback.
8. **Don't base64-encode audio.** Use binary WebSocket frames or Ably binary extras. 33% overhead is unacceptable for real-time.
9. **Don't swallow errors silently.** Every `catch {}` should at minimum log to a debug channel.
10. **Don't skip wire protocol validation.** Validate incoming events with zod/valibot.
11. **Don't build heuristic binary/text detection.** Use the WebSocket frame type directly.
12. **Don't put TTS outside the pipeline.** If you have a pipeline abstraction, TTS should be a processor in it.

### KEEP

1. The 5-abstraction domain model (Session, Transport, Pipeline, Brain, Provider)
2. The Transport interface (`sendAudio`/`onAudio`/`sendEvent`/`onEvent`/`state`)
3. The Brain abstraction (function returning `string | AsyncGenerator<string>`)
4. The serial TTS queue pattern
5. The `eagerStream` concept (with backpressure added)
6. The typed event protocol (discriminated unions)
7. The `MemoryTransport` testing pattern
8. The provider factory pattern (`sarvam.stt({...})`, `sarvam.tts({...})`)
9. The `VoiceLineError` with typed codes
10. The WS integration test approach (real servers, not mocks)
