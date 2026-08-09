# VoiceMinusOne

> Plugin-based voice SDK for application-based AI voice agents. Real-time voice layer for chat apps, co-pilots, creative tools, and in-browser assistants. Not telephony. Not WebRTC. Pure TypeScript/Node.js.

[![Tests](https://img.shields.io/badge/tests-112%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## What is this?

VoiceMinusOne is a real-time voice layer for AI agents. The user sits at a device with a mic and speakers, and an AI agent is embedded in their app. Every segment — STT, TTS, LLM, transport, VAD, audio processing — is a swappable plugin. No vendor lock-in.

```typescript
import { createVoiceSession } from '@voiceminusone/core'
import { sarvam } from '@voiceminusone/provider-sarvam'
import { aiSdkBrain } from '@voiceminusone/adapter-ai-sdk'
import { wsTransport } from '@voiceminusone/transport-ws'
import { sileroVAD } from '@voiceminusone/vad-silero'

const session = createVoiceSession({
  transport: wsTransport({ url: 'ws://localhost:3001' }),
  stt: sarvam.stt({ apiKey: process.env.SARVAM_API_KEY, model: 'saaras:v3' }),
  tts: sarvam.tts({ apiKey: process.env.SARVAM_API_KEY, model: 'bulbul:v3', speaker: 'shubh' }),
  brain: aiSdkBrain({ model: openai('gpt-4o') }),
  vad: sileroVAD(),
})
```

## Architecture

**Hybrid pipeline**: Frame-based core (inspired by pipecat) with stream adapters at provider boundaries (inspired by micdrop). Data flows as typed Frames through a directional pipeline — downstream for normal data, upstream for errors and interruptions. Providers implement simple async iterables that the framework adapts to frames.

### Pipeline data flow

```mermaid
graph LR
    subgraph Client["Browser Client"]
        MIC["Mic<br/>(AudioWorklet)"]
        SPK["Speaker<br/>(Prebuffered)"]
        VAD["EnergyVAD<br/>(3-phase)"]
    end

    subgraph Transport["WebSocket Transport"]
        TIN["Transport Input"]
        TOUT["Transport Output"]
    end

    subgraph Server["Server Pipeline"]
        STT["STT Plugin<br/>(Sarvam Saaras)"]
        LLM["Brain / LLM<br/>(AI SDK 7)"]
        TTS["TTS Plugin<br/>(Sarvam Bulbul)"]
    end

    MIC -->|"PCM 16kHz binary"| TIN
    VAD -.->|"start/stop speaking"| TIN
    TIN -->|"AudioRawFrame"| STT
    STT -->|"TranscriptFrame"| LLM
    LLM -->|"LLMTextFrame"| TTS
    TTS -->|"TTSAudioRawFrame"| TOUT
    TOUT -->|"PCM binary"| SPK

    STT -.->|"InterruptionFrame"| TIN
    TTS -.->|"ErrorFrame"| TIN

    style Client fill:#1a1a2e,color:#e0e0e0
    style Transport fill:#16213e,color:#e0e0e0
    style Server fill:#0f3460,color:#e0e0e0
```

### Session architecture (no god classes)

```mermaid
graph TB
    subgraph SessionManager["SessionManager (coordinator)"]
        SM["SessionManager"]
    end

    subgraph Components["Focused Components"]
        SSM["SessionStateMachine<br/>idle, connected, listening,<br/>receiving, processing, speaking"]
        TM["TurnManager<br/>turn-taking, interruption,<br/>serial TTS queue"]
        AR["AudioRouter<br/>transport, STT, TTS<br/>audio buffering"]
        HM["HistoryManager<br/>conversation messages,<br/>partial updates"]
    end

    subgraph Plugins["Plugins (swappable)"]
        STT["STTProvider"]
        TTS["TTSProvider"]
        BRAIN["Brain"]
        VAD["VADProvider"]
        TRANS["Transport"]
    end

    SM --> SSM
    SM --> TM
    SM --> AR
    SM --> HM

    AR --> STT
    AR --> TTS
    TM --> BRAIN
    SM --> TRANS

    style SessionManager fill:#0f3460,color:#e0e0e0
    style Components fill:#16213e,color:#e0e0e0
    style Plugins fill:#1a1a2e,color:#e0e0e0
```

### Session state machine

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Connected: transport.connect()
    Connected --> Listening: startListening()
    Listening --> Receiving: start_speaking
    Receiving --> Processing: stop_speaking
    Processing --> Speaking: TTS starts
    Speaking --> Listening: TTS done
    Receiving --> Processing: stop_speaking (no speech)
    Processing --> Listening: error / empty transcript
    Listening --> Receiving: start_speaking (barge-in)
    Speaking --> Receiving: start_speaking (interruption)
    Connected --> Closed: disconnect()
    Listening --> Closed: disconnect()
    Speaking --> Closed: disconnect()
```

### Turn lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant T as Transport
    participant S as SessionManager
    participant STT as STTProvider
    participant B as Brain
    participant TTS as TTSProvider

    C->>T: start_speaking (event)
    T->>S: handleStartSpeaking()
    S->>S: interruptTurn() if active

    C->>T: audio chunks (binary)
    T->>S: buffer audio

    C->>T: stop_speaking (event)
    T->>S: handleStopSpeaking()
    S->>STT: transcribe(audio)
    STT-->>S: TranscriptResult (final)
    S->>B: brain(transcript, context)
    B-->>S: token stream
    S->>C: bot_text events
    S->>TTS: synthesize(response)
    TTS-->>S: audio chunks
    S->>C: audio (binary)
    S->>C: bot_text_done
    S->>S: backToListening()
```

### Package dependency graph

```mermaid
graph TB
    CORE["@voiceminusone/core<br/>frames, pipeline, interfaces"]

    SERVER["@voiceminusone/server<br/>session, wire protocol, WS transport"]
    CLIENT["@voiceminusone/client<br/>mic, speaker, VAD, client"]

    TRANSPORT_WS["transport-ws<br/>(planned)"]
    TRANSPORT_ABLY["transport-ably<br/>(planned)"]
    PROVIDER_SARVAM["provider-sarvam<br/>(planned)"]
    ADAPTER_AI_SDK["adapter-ai-sdk<br/>(planned)"]
    VAD_SILERO["vad-silero<br/>(planned)"]
    VAD_ENERGY["vad-energy<br/>(planned)"]
    NUXT["nuxt<br/>(planned)"]

    TEST_PIPELINE["test-pipeline<br/>audio file testing"]
    EXAMPLE["example-nuxt<br/>Nuxt v4 demo app"]

    CORE --> SERVER
    CORE --> CLIENT
    CORE --> TRANSPORT_WS
    CORE --> TRANSPORT_ABLY
    CORE --> PROVIDER_SARVAM
    CORE --> ADAPTER_AI_SDK
    CORE --> VAD_SILERO
    CORE --> VAD_ENERGY

    SERVER --> NUXT
    CLIENT --> EXAMPLE
    SERVER --> EXAMPLE

    CORE --> TEST_PIPELINE
    SERVER --> TEST_PIPELINE

    style CORE fill:#e94560,color:#fff
    style SERVER fill:#0f3460,color:#e0e0e0
    style CLIENT fill:#0f3460,color:#e0e0e0
    style EXAMPLE fill:#16213e,color:#e0e0e0
```

### VAD three-phase state machine

```mermaid
stateDiagram-v2
    [*] --> Silence
    Silence --> MaybeSpeaking: energy > threshold
    MaybeSpeaking --> Speaking: sustained for confirmDuration
    MaybeSpeaking --> Silence: silence for cancelDuration
    Speaking --> Silence: silence for stopDuration
    Speaking --> MaybeSpeaking: energy spike (new utterance)
```

**No god classes.** The session is split into focused, independently testable components:
- `SessionStateMachine` — state transitions
- `TurnManager` — turn-taking, interruption, serial TTS queue
- `AudioRouter` — routes audio between transport/STT/TTS
- `HistoryManager` — conversation messages

## Packages

| Package | Description |
|---------|-------------|
| `@voiceminusone/core` | Frame types, FrameProcessor, Pipeline, plugin interfaces, errors, logger, clock |
| `@voiceminusone/server` | SessionManager, wire protocol (zod-validated), WebSocket transport |
| `@voiceminusone/client` | Mic (AudioWorklet), Speaker (prebuffered gapless), EnergyVAD, VoiceMinusOneClient |
| `@voiceminusone/provider-sarvam` | Sarvam STT (Saaras v3, WebSocket streaming) + TTS (Bulbul v3, HTTP streaming) |
| `@voiceminusone/adapter-ai-sdk` | Vercel AI SDK 7 → Brain adapter (streaming + complete modes) |
| `@voiceminusone/transport-ably` | Ably pub/sub transport (binary extras, not base64) |
| `@voiceminusone/vad-silero` | Silero VAD via ONNX Runtime Web (WASM) |
| `@voiceminusone/vad-energy` | Energy-based VAD (zero-dependency fallback) |
| `@voiceminusone/nuxt` | Nuxt v4 server module (crossws WebSocket handler) |
| `@voiceminusone/test-pipeline` | Automated end-to-end test from an audio file |

## Quick start

### Prerequisites

- Node.js >= 20
- pnpm >= 9

### Install

```bash
git clone https://github.com/NormVg/VoiceMinusOne.git
cd VoiceMinusOne
pnpm install
```

### Build

```bash
pnpm build
```

### Run tests

```bash
# Unit + integration tests (112 tests)
pnpm test

# Automated audio pipeline test (reads test/test-clip.mp3)
pnpm test:audio

# Browser automation test (launches Nuxt app + headless Chrome)
cd examples/nuxt-voice
pnpm test:browser
```

### Run the example app

```bash
cd examples/nuxt-voice

# Build the Nuxt app
pnpm build

# Start the preview server
node .output/server/index.mjs

# In another terminal, run the browser test
node test/browser-test.mjs
```

The example app starts a WebSocket server on port 3001 with mock STT/TTS/Brain providers. Open `http://localhost:3000` in a browser and click Connect.

## Plugin system

Every segment is a plugin with a TypeScript interface. Providers export factory functions:

```typescript
import type { STTProvider, AudioChunk, TranscriptResult, STTConfig } from '@voiceminusone/core'

export class MySTT implements STTProvider {
  readonly name = 'my-stt'

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    config: STTConfig,
  ): AsyncIterable<TranscriptResult> {
    for await (const chunk of audio) {
      // Send to your STT API, yield transcripts
      yield { text: '...', isFinal: false }
    }
  }

  async init() {}
  async start() {}
  async stop() {}
  async destroy() {}
}

// Factory
export const myStt = (options: MySTTOptions): STTProvider => new MySTT(options)
```

Plugins receive a `PluginContext` with lifecycle hooks, logger, event bus, and clock:

```typescript
interface PluginContext {
  readonly logger: Logger
  readonly events: EventBus
  readonly clock: Clock
  readonly signal: AbortSignal
}
```

## Tech stack

| Concern | Technology |
|---------|-----------|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Runtime | Node.js >= 20 |
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

## Design principles

1. **Plugin-first** — Every capability is a swappable plugin. Core has zero opinions on providers.
2. **No vendor lock-in** — Swap any plugin without changing application code.
3. **No god classes** — Split concerns into focused, independently testable components.
4. **No `any`** — Every interface is fully typed, including framework adapters.
5. **No silent errors** — Every `catch` logs. Wire protocol validated with zod.
6. **No base64 audio** — Binary WebSocket frames only. No 33% overhead.
7. **No deprecated APIs** — AudioWorklet, never ScriptProcessorNode.
8. **No Python** — Pure TypeScript/Node.js end to end.

## Reference projects

Three reference repos were studied deeply (guides in `.info/guides/`):

| Repo | What we learned |
|------|----------------|
| [micdrop](https://github.com/Godefroy/micdrop) | Three-abstraction model, stream-based pipeline, fallback chains, VAD state machine |
| [pipecat](https://github.com/pipecat-ai/pipecat) | Frame-based directional pipeline, dual-queue priority, transport as processor pair |
| [voice-line](https://github.com/NormVg/voice-line) | What NOT to do: god-class Session, broken pipeline, pervasive `any` |

## License

MIT
