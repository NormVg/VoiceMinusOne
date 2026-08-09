# VoiceMinusOne Agent Instructions

## Identity

You are working on **VoiceMinusOne** — a plugin-based voice SDK for application-based AI voice agents. This is a library/SDK, not a standalone application. It embeds into existing apps (Nuxt v4, Next.js, Express) to add real-time voice capabilities.

**Not telephony. Not WebRTC.** Application-based real-time voice over WebSockets and pub/sub (Ably). The user sits at a device with a mic and speakers, and an AI agent is embedded in their app.

**Pure TypeScript/Node.js. No Python.** Ever.

## Core Principles

1. **Plugin-first architecture** — Every capability (STT, TTS, LLM, transport, VAD, audio processing) is a swappable plugin with a TypeScript interface. Core has zero opinions on providers.
2. **No vendor lock-in** — Users can swap any plugin without changing application code. Provider packages export factories (`sarvam.stt({...})`).
3. **Frame-based core, stream-based providers** — Internally, data flows as typed Frames through a directional pipeline (downstream + upstream) for observability and interruption handling. Providers implement simple async iterables that the framework adapts to frames.
4. **No god classes** — Split concerns into focused, independently testable components. Never let a single class own state machine, pipelines, TTS queue, brain execution, interruption logic, history, and transport wiring.
5. **No `any`** — Every interface, adapter, and handler is fully typed. Framework adapters (Nuxt, crossws) define minimal typed interfaces.
6. **No silent errors** — Every `catch` logs to a debug channel at minimum. Wire protocol events validated with zod.
7. **No side effects on import** — Importing any module never triggers connections, timers, or network calls. All init in explicit `start()` / `init()` calls.
8. **Observable** — All significant operations emit events. Structured logging with levels, not `console.log`.
9. **Pure TypeScript/Node.js** — No Python. VAD via ONNX Runtime Web (WASM). Audio via Web Audio API / AudioWorklet.
10. **Production-grade from day one** — Tests (Vitest), structured errors, backpressure, reconnection, wire protocol validation.

## Architecture

This is a **pnpm monorepo** with these packages:

- `packages/core` — Frame types, FrameProcessor, Pipeline, Session (split components), plugin interfaces, errors, logger, clock
- `packages/server` — Server runtime, session manager, pipeline runner, crossws/Nitro handlers
- `packages/client` — Browser: mic (AudioWorklet), speaker (prebuffered gapless), VAD, VoiceMinusOneClient
- `packages/transport-ws` — WebSocket transport (crossws for Nuxt, ws for Node)
- `packages/transport-ably` — Ably pub/sub transport
- `packages/provider-sarvam` — Sarvam STT (Saaras v3) + TTS (Bulbul v3)
- `packages/adapter-ai-sdk` — Vercel AI SDK 7 → Brain adapter
- `packages/vad-silero` — Silero VAD via ONNX Runtime Web
- `packages/vad-energy` — Energy-based VAD (zero-dependency fallback)
- `packages/nuxt` — Nuxt v4 server module

## Before Writing Code

1. Read `project.md` for current status, architecture, and key design decisions.
2. Read `.agents/rules/voice-sdk.md` for mandatory coding constraints.
3. Read the reference guides in `.info/guides/` (micdrop, pipecat, voice-line) for patterns to adopt and avoid.
4. Check the implementation phases in `project.md` to know what's been done and what's next.

## When Making Changes

- Always update `project.md` status checkboxes when completing a phase or task.
- Run `pnpm build` after any change to verify compilation.
- Run `pnpm test` to verify tests pass.
- Run `pnpm lint` to verify Biome passes.
- Add structured debug logs for non-trivial operations via the `Logger` interface.
- Write tests for any new public API surface.
- Never commit build output (`dist/`), `node_modules/`, or runtime state.

## Tech Stack Reference

| Concern | Technology |
|---------|-----------|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Runtime | Node.js >=20 |
| Package manager | pnpm with workspaces |
| Bundler | tsup |
| Tests | Vitest |
| Linter | Biome |
| Schema validation | zod |
| WebSocket (Nuxt) | crossws |
| WebSocket (Node) | ws |
| Pub/sub | Ably |
| AI/LLM | Vercel AI SDK 7 |
| STT/TTS | Sarvam AI (Saaras v3, Bulbul v3) |
| VAD | Silero (ONNX Runtime Web) + energy-based fallback |
| Framework | Nuxt v4 |

## Skills Available

The following skills are available in `.agents/skills/` — load them when the task matches:

- **ably** — Ably realtime integration patterns
- **ai-sdk** — Vercel AI SDK 7 (always verify against bundled docs in `node_modules/ai/docs/`, never from memory)
- **nuxt** — Nuxt v4 patterns (server modules, crossws, Nitro)
- **websockets** — WebSocket patterns (crossws, ws library, binary frames)
- **voice-agents** — Sarvam AI voice agent integration (STT, TTS, LLM)
- **speech-to-text** — Sarvam Saaras v3 STT (WebSocket streaming, REST, batch)
- **text-to-speech** — Sarvam Bulbul v3 TTS (REST, HTTP stream, WebSocket)
- **living-architecture** — Architectural patterns and principles

## Critical Lessons from Reference Projects

### From voice-line (what NOT to do)
- Never build a god-class Session — split into SessionStateMachine, TurnManager, AudioRouter, HistoryManager
- Never break your own pipeline abstraction — if STT is async, make the pipeline async-native
- Never use `any` in framework adapters — define minimal typed interfaces
- Never use ScriptProcessorNode — use AudioWorkletNode
- Never leave `console.log` in library code — use injectable Logger
- Never base64-encode audio — use binary WebSocket frames
- Never swallow errors silently — every catch logs
- Never skip wire protocol validation — validate with zod
- Never build heuristic binary/text detection — use WebSocket frame type directly

### From micdrop (what to adopt)
- Three-abstraction model (Agent/STT/TTS as abstract classes with stream interfaces)
- Stream-based pipeline with PassThrough for natural backpressure
- Fallback pattern with data replay for provider resilience
- VAD three-phase state machine (Start → Confirm → Cancel/Stop)
- Counter-based cancellation for invalidating in-flight work
- Operation queue for serializing concurrent operations
- Prebuffered gapless audio playback

### From pipecat (what to adopt, translated to TS)
- Frame-based directional pipeline (downstream + upstream)
- System frame priority (dual-queue for instant interruptions)
- Transport as processor pair (input() + output())
- NOT_GIVEN settings sentinel for runtime reconfiguration
- UninterruptibleFrame for frames that survive interruptions
- Service metadata broadcasting for auto-configuration
