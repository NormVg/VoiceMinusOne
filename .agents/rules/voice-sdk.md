# VoiceMinusOne — Mandatory Coding Rules

These rules are non-negotiable. Every agent working on this project MUST follow them.

---

## R-001: No Raw Time

**NEVER** use `Date.now()` or `new Date()` directly in core, pipeline, session, or plugin code.

✅ Correct:
```typescript
import { clock } from '../core/clock'
const now = clock.now()
```

❌ Wrong:
```typescript
const now = Date.now()
```

**Exception**: Test setup code may use `Date.now()` when configuring a mock clock.

---

## R-002: Interface-First Design

Every plugin category MUST have its interface defined BEFORE any implementation is written. The interface lives in `core/src/interfaces/`.

```
core/src/interfaces/stt.ts    ← Define first
packages/provider-sarvam/    ← Implement second
```

---

## R-003: No `any` Types

**NEVER** use `any` anywhere. Every interface, adapter, handler, and parameter must be fully typed.

✅ Correct:
```typescript
import type { WebSocketPeer } from 'crossws'
export function createNitroHandler(peer: WebSocketPeer): Handler { ... }
```

❌ Wrong:
```typescript
export function createNitroHandler(peer: any): any { ... }
```

If a third-party type is unknown, define a minimal interface for the subset you use.

---

## R-004: Structured Errors

All thrown errors MUST extend `VoiceMinusOneError` and include a machine-readable `code`.

```typescript
throw new TransportError('WS_CONNECTION_FAILED', 'Could not connect to WebSocket')
```

Never throw raw `Error('something broke')`.

---

## R-005: No Side Effects on Import

Importing any module MUST NOT trigger side effects (no DB connections, no timers, no network calls, no WebSocket connections). All initialization happens inside `start()` or `init()`.

✅ Correct:
```typescript
export function wsTransport(options: WsTransportOptions): Transport {
  return {
    input() { return new WsInputProcessor(options) },
    output() { return new WsOutputProcessor(options) },
  }
}
```

❌ Wrong:
```typescript
// Top-level side effect
const socket = new WebSocket('ws://localhost:3000')
```

---

## R-006: DAG Dependency Graph

Module dependencies MUST form a Directed Acyclic Graph. No circular imports.

```
core/ ← server/ ← plugins/ ← integrations/
```

Lower layers NEVER import from higher layers. `core` has zero dependencies on other VoiceMinusOne packages.

---

## R-007: No `console.log` in Library Code

**NEVER** use `console.log`, `console.error`, `console.warn`, or `console.debug` in library code. Use the injectable `Logger` interface.

✅ Correct:
```typescript
logger.debug('transport', `WebSocket connected to ${url}`)
logger.error('stt', `Transcription failed: ${error.message}`)
```

❌ Wrong:
```typescript
console.log('connected')
console.error('transcription failed', error)
```

Format: `[vm1:<namespace>] <message>`

---

## R-008: No Silent Errors

Every `catch` block MUST at minimum log to a debug channel. Never use empty catch blocks.

✅ Correct:
```typescript
try {
  await this.transport.sendAudio(chunk)
} catch (error) {
  logger.warn('transport', `Failed to send audio: ${(error as Error).message}`)
}
```

❌ Wrong:
```typescript
try {
  await this.transport.sendAudio(chunk)
} catch { /* ignore */ }
```

---

## R-009: Wire Protocol Validation

All incoming wire protocol events MUST be validated with zod before use.

✅ Correct:
```typescript
const EventSchema = z.object({
  type: z.literal('start_speaking'),
})
const parsed = EventSchema.parse(JSON.parse(data))
```

❌ Wrong:
```typescript
const event = JSON.parse(data)
if (event.type === 'start_speaking') { ... }  // No validation
```

---

## R-010: No Base64 Audio

**NEVER** base64-encode audio data. Use binary WebSocket frames or Ably binary extras. Base64 adds 33% overhead — unacceptable for real-time audio.

✅ Correct:
```typescript
socket.send(audioBuffer)  // Binary frame
```

❌ Wrong:
```typescript
socket.send(Buffer.from(audioBuffer).toString('base64'))  // 33% overhead
```

---

## R-011: No Deprecated Web APIs

**NEVER** use `ScriptProcessorNode`. Always use `AudioWorkletNode` for audio processing in the browser.

✅ Correct:
```typescript
const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor')
```

❌ Wrong:
```typescript
const processor = audioContext.createScriptProcessor(4096, 1, 1)
```

---

## R-012: No God Classes

Never build a single class that owns multiple concerns. Split into focused, independently testable components.

✅ Correct:
```typescript
class SessionStateMachine { ... }
class TurnManager { ... }
class AudioRouter { ... }
class HistoryManager { ... }
```

❌ Wrong:
```typescript
class Session {
  // state machine + pipelines + TTS queue + brain + interruption + history + transport
  // 577 lines of everything
}
```

If a class exceeds ~200 lines, consider splitting it.

---

## R-013: No `process.env` in Core

Configuration MUST be passed programmatically. Never read `process.env` directly in core, server, or plugin code.

✅ Correct:
```typescript
const session = createVoiceSession({
  stt: sarvam.stt({ apiKey: config.sarvamApiKey }),
})
```

❌ Wrong:
```typescript
const apiKey = process.env.SARVAM_API_KEY  // In library code
```

Environment reading only in entry points (example apps, Nuxt module config).

---

## R-014: Clean Async

- All async functions MUST have proper error handling.
- No floating promises. Every `Promise` must be awaited or explicitly handled.
- Use transactions where atomicity is required.

✅ Correct:
```typescript
await this.transport.disconnect()
```

❌ Wrong:
```typescript
this.transport.disconnect()  // Floating promise
```

---

## R-015: Test Naming

Test files MUST use the pattern `<module>.test.ts` and live next to the source file or in a mirrored `__tests__/` directory.

Test names MUST be descriptive:
```typescript
it('should emit InterruptionFrame when user starts speaking during TTS', async () => { ... })
```

---

## R-016: Export Hygiene

Each package's `index.ts` MUST explicitly re-export only the public API. Internal implementation details stay internal.

✅ Correct:
```typescript
export { createVoiceSession } from './session'
export type { VoiceSession, SessionConfig } from './session'
export { Pipeline } from './pipeline'
export type { Frame, FrameProcessor } from './types'
```

❌ Wrong:
```typescript
export * from './everything'  // Leaks internals
```

---

## R-017: No Heuristic Frame Detection

**NEVER** guess whether a WebSocket message is binary or text by inspecting byte values. Use the WebSocket frame type from the transport layer.

✅ Correct:
```typescript
socket.on('message', (data, isBinary) => {
  if (isBinary) {
    handleAudio(data)
  } else {
    handleEvent(data.toString())
  }
})
```

❌ Wrong:
```typescript
// Guessing from first byte — silent data corruption
if (buf[0] === 123) {  // '{' means JSON?
  isBinary = false
}
```

---

## R-018: Backpressure Awareness

Always check `bufferedAmount` before sending on a WebSocket. If the buffer is growing, apply backpressure.

✅ Correct:
```typescript
if (socket.bufferedAmount > MAX_BUFFER) {
  await waitForDrain(socket)
}
socket.send(audio)
```

❌ Wrong:
```typescript
socket.send(audio)  // No backpressure check — memory growth under load
```

---

## R-019: No Python

**NEVER** write, import, or depend on Python code. This is a pure TypeScript/Node.js project. VAD model inference uses ONNX Runtime Web (WASM), not Python. Audio processing uses Web Audio API / AudioWorklet, not Python audio libraries.

---

## R-020: Plugin Context

Every plugin receives a `PluginContext` with `logger`, `events`, `clock`, and `signal`. Plugins MUST NOT create their own logger, event bus, or clock — they use the injected ones.

✅ Correct:
```typescript
class MySTT implements STTProvider, Plugin {
  async init(context: PluginContext) {
    this.logger = context.logger
    this.events = context.events
  }
}
```

❌ Wrong:
```typescript
class MySTT implements STTProvider {
  private logger = console  // Don't use console
  private events = new EventEmitter()  // Don't create own event bus
}
```

---

## R-021: Changelog Maintenance

After completing any architectural change, bug fix, or feature, update `CHANGELOG.md` in the project root with a dated entry:

```
## [YYYY-MM-DD] — Short Title

### Changed
- Description of change (file.ts)

### Why
- Root cause / motivation

### Impact
- Before → After metrics (if available)
```

Never overwrite existing entries. Always prepend new entries at the top.
