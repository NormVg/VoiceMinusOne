# Reference Guide: pipecat

> **Repository**: `github.com/pipecat-ai/pipecat` (Python)
> **Location**: `.info/repo/pipecat`
> **License**: BSD-2-Clause | **Python**: >=3.11 | **Scale**: 60+ providers, 14 transports, 100+ frame types

## What It Is

Pipecat is a Python framework for building real-time voice and multimodal conversational AI agents. It provides a composable, frame-based pipeline architecture where each concern (audio I/O, STT, LLM, TTS, transport, turn-taking) is a pluggable processor, and the pipeline handles ordering, interruption, backpressure, and lifecycle automatically.

## Core Architecture

Pipecat's architecture is a **frame-based directed pipeline**. The core abstractions:

### Frame
The universal data unit. Every piece of data — audio chunks, text tokens, transcription results, control signals, lifecycle events — is a `Frame` object flowing through the pipeline.

### FrameProcessor
The base processing unit. Each processor receives frames, processes them, and pushes results downstream (or upstream for errors/interruptions). This is the central abstraction — services, transports, aggregators, and filters are all `FrameProcessor` subclasses.

### Pipeline
Chains `FrameProcessor`s in sequence with automatic source/sink management. A `Pipeline` is itself a `FrameProcessor`, so pipelines can be nested.

### Transport
Handles external I/O (WebRTC, WebSocket, telephony). A transport exposes two `FrameProcessor`s: `input()` (receives from network, pushes into pipeline) and `output()` (receives from pipeline, sends to network).

### Service
AI provider integrations (STT, TTS, LLM). All extend `AIService` → `FrameProcessor`. Services receive frames (audio for STT, text for TTS, context for LLM), call the provider API, and push result frames downstream.

### Frame Flow

```
                    DOWNSTREAM →
┌──────────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌──────────┐
│ Transport │───→│ STT │───→│ LLM │───→│ TTS │───→│ Transport│
│  Input    │    └─────┘    └─────┘    └─────┘    │  Output  │
└──────────┘                                    └──────────┘
                    ← UPSTREAM
              (errors, interruptions, acknowledgments)
```

Frames flow **downstream** (normal data path) and **upstream** (errors, interruptions, acknowledgments).

## Frame System (signature design)

### Frame Hierarchy

```
Frame (base)
├── SystemFrame       — high priority, processed immediately, not interrupted
├── DataFrame         — ordered data (audio, text, images), cancelled by interruptions
├── ControlFrame     — ordered control info, cancelled by interruptions
└── Mixins:
    ├── UninterruptibleFrame — preserved during interruptions
    ├── AudioRawFrame        — audio payload mixin
    └── ImageRawFrame        — image payload mixin
```

**Three priority tiers:**
1. **SystemFrame** — processed immediately, jumps the queue (StartFrame, CancelFrame, InterruptionFrame, UserStartedSpeakingFrame)
2. **DataFrame** — processed in order, cancelled by interruptions (TextFrame, TTSAudioRawFrame, TranscriptionFrame)
3. **ControlFrame** — processed in order, cancelled by interruptions (EndFrame, TTSStoppedFrame)

### Key Frame Types

- **Lifecycle**: `StartFrame` (initializes all processors with audio sample rates), `EndFrame` (graceful shutdown), `CancelFrame` (immediate shutdown), `StopFrame` (temporary pause)
- **Audio**: `InputAudioRawFrame`, `OutputAudioRawFrame`, `TTSAudioRawFrame` (carries `context_id`)
- **Text**: `TextFrame`, `LLMTextFrame`, `TranscriptionFrame`, `InterimTranscriptionFrame`, `AggregatedTextFrame`
- **Turn-taking**: `UserStartedSpeakingFrame`, `UserStoppedSpeakingFrame`, `InterruptionFrame`, `BotStartedSpeakingFrame`, `BotStoppedSpeakingFrame`
- **LLM**: `LLMFullResponseStartFrame`/`EndFrame`, `LLMContextFrame`, `FunctionCallInProgressFrame`, `FunctionCallResultFrame`

### Dual-Queue Priority Mechanism

Each `FrameProcessor` has two queues:
1. **Input queue** — `asyncio.PriorityQueue`, separates system frames (HIGH_PRIORITY=1) from others (LOW_PRIORITY=2)
2. **Process queue** — secondary queue for non-system frames, processed in order by a separate task

System frames are dequeued and processed immediately, never blocked behind data frames. This guarantees sub-millisecond interruption response even with a full audio buffer.

## Pipeline & FrameProcessor

### FrameProcessor Contract

```python
class FrameProcessor:
    def link(self, processor):     # Forms doubly-linked list
        self._next = processor
        processor._prev = self

    async def queue_frame(self, frame, direction=DOWNSTREAM):
        # Routes to input queue (or direct mode for passthrough)

    async def process_frame(self, frame, direction):
        # Base class handles StartFrame, CancelFrame, InterruptionFrame
        # Subclasses call super().process_frame() first, then add custom handling

    async def push_frame(self, frame, direction=DOWNSTREAM):
        # Routes to self._next (downstream) or self._prev (upstream)
```

### Pipeline Composition

```python
pipeline = Pipeline([
    transport.input(),      # Transport user input
    stt,                    # Speech-to-text
    user_aggregator,        # User response context aggregation
    llm,                    # LLM
    tts,                    # Text-to-speech
    transport.output(),     # Transport bot output
    assistant_aggregator,   # Assistant response context aggregation
])
```

`Pipeline` wraps processors with `PipelineSource` (catches upstream frames) and `PipelineSink` (catches downstream frames), both using `enable_direct_mode=True` for zero-overhead passthrough.

## Transport Layer

A transport is a **pair of `FrameProcessor`s**:

```python
class BaseTransport:
    @abstractmethod
    def input(self) -> FrameProcessor: ...
    @abstractmethod
    def output(self) -> FrameProcessor: ...
```

`BaseInputTransport` handles: audio input queue, audio filtering, VAD integration, passthrough.
`BaseOutputTransport` handles: resampling, chunking (40ms default), mixing, bot-speaking detection, interruption handling.

Concrete transports implement only `write_audio_frame()` and the receive loop.

### Transport Catalog

| Transport | Protocol |
|-----------|----------|
| Daily | WebRTC (daily-python SDK) |
| LiveKit | WebRTC (LiveKit SDK) |
| WebSocket Server | WebSocket (websockets lib) |
| WebSocket Client | WebSocket client |
| FastAPI WebSocket | WebSocket via FastAPI/Starlette |
| SmallWebRTC | WebRTC via aiortc (SDP over HTTP) |
| Local Audio | PyAudio local device |
| MoQ | Media over QUIC |
| Vonage | Vonage Video API (WebRTC) |
| HeyGen/Tavus/LemonSlice | Avatar WebSocket APIs |
| WhatsApp | WhatsApp Cloud API + SmallWebRTC |

### Serializers

| Serializer | Wire Format | Audio Encoding |
|-----------|-------------|----------------|
| ProtobufFrameSerializer | Protocol Buffers (binary) | Raw 16-bit PCM |
| TwilioFrameSerializer | JSON (Twilio Media Streams) | μ-law 8kHz, base64 |
| VonageFrameSerializer | JSON (Vonage Voice API) | μ-law 16kHz, base64 |
| Telnyx/Plivo/Exotel | JSON | μ-law 8kHz, base64 |
| GenesysAudioHook | JSON | Raw PCM or μ-law |

## Service Hierarchy

```
FrameProcessor
└── AIService
    ├── STTService (abstract: run_stt(audio) → AsyncGenerator[Frame])
    │   └── WebsocketSTTService
    ├── TTSService (abstract: run_tts(text, context_id) → AsyncGenerator[Frame])
    │   ├── WebsocketTTSService
    │   └── InterruptibleTTSService
    ├── LLMService (implements _process_context(context))
    │   └── BaseOpenAILLMService
    ├── VisionService
    └── ImageService
```

**22 STT providers**, **29 TTS providers**, **26 LLM providers** — each is a separate installable extra (`pip install "pipecat-ai[deepgram]"`).

### ServiceSettings System

Dual-mode dataclass pattern:
- **Store mode**: full current state, every field has a real value
- **Delta mode**: sparse update — only changed fields are set, others are `NOT_GIVEN`

`apply_update(delta)` merges only non-`NOT_GIVEN` fields and returns changed fields → pre-update values. Enables clean runtime reconfiguration.

## Real-Time Audio

### Default Audio Parameters

| Parameter | Default |
|-----------|---------|
| Input sample rate | 16000 Hz |
| Output sample rate | 24000 Hz |
| Audio format | 16-bit signed PCM |
| Channels | 1 (mono) |
| Output chunk size | 40ms (1920 bytes at 24kHz) |
| VAD gating block | 400ms |
| Bot VAD stop | 350ms |
| Audio input timeout | 500ms |

### Bidirectional Audio Flow

**Input**: Remote peer → transport receives bytes → serializer.deserialize() → `InputAudioRawFrame` → `push_audio_frame()` → audio queue → filter → push downstream

**Output**: TTS generates `TTSAudioRawFrame` → resample to transport rate → buffer → chunk into 40ms pieces → (optional) mix → `write_audio_frame()` → transport send

### VAD

`VADAnalyzer` — abstract base with state machine: `QUIET → STARTING → SPEAKING → STOPPING → QUIET`. Uses `start_secs`/`stop_secs` (default 0.2s each) to confirm transitions. Implementations: Silero (ONNX), Krisp VIVA, AIC.

## Patterns to Adopt in TypeScript

1. **Frame-based directional pipeline** — the core abstraction that makes everything composable. Interruption is trivial (push an InterruptionFrame upstream), error propagation is automatic, observability is uniform.
2. **System frame priority** — dual-queue design ensures real-time events never wait behind audio frame backlogs. Critical for voice — a 500ms delay on an interruption frame means the bot talks over the user.
3. **Transport as processor pair** — `input(): FrameProcessor` + `output(): FrameProcessor`. The transport plugs into the pipeline at both ends with no special-casing. Base classes handle 90% of complexity (buffering, chunking, resampling, VAD, bot-speaking detection).
4. **`NOT_GIVEN` settings sentinel** — dual-mode settings (store vs. delta) enables clean runtime configuration updates without null-checking every field.
5. **UninterruptibleFrame mixin** — clean way to mark frames that must survive interruptions.
6. **Service metadata broadcasting** — services broadcast configuration at startup, letting downstream processors auto-configure.
7. **Event handler system** — `@processor.event_handler("on_connected")` for decoupled lifecycle reactions.

## Patterns to Avoid

1. **Python asyncio specificity** — dual-task-per-processor design is deeply asyncio-specific. Use async iterators/ReadableStreams in TS.
2. **100+ frame types in one file** — `frames.py` is 2245 lines. Split into domain modules.
3. **Deep inheritance hierarchies** — `TTSService → WebsocketTTSService → InterruptibleTTSService` (3 levels), `LLMService → BaseOpenAILLMService → OpenAILLMService → GroqLLMService` (4 levels). Use composition instead.
4. **Protobuf dependency** — adds build complexity. Consider MessagePack or JSON-based binary format.
5. **Configuration sprawl** — `TransportParams` has 25+ fields. Use builder pattern or config objects.
6. **GIL/threading assumptions** — `ThreadPoolExecutor` for VAD. Use Web Workers or WASM in TS.

## TypeScript Translation Guide

| Pipecat Concept | TypeScript Translation |
|---|---|
| `Frame` (@dataclass) | `interface Frame` with `id`, `name`, `pts`, `metadata` |
| `SystemFrame`/`DataFrame`/`ControlFrame` | Discriminated union types or `type` field enum |
| `FrameDirection` enum | `enum FrameDirection { Downstream, Upstream }` |
| `FrameProcessor` (asyncio queues) | `abstract class FrameProcessor` with async `processFrame()` + internal queue |
| `Pipeline` (linked list) | `class Pipeline extends FrameProcessor` with linked processors |
| `BaseTransport` (input/output pair) | `abstract class Transport { abstract input(); abstract output() }` |
| `AIService` → `STTService`/`TTSService`/`LLMService` | Same hierarchy, abstract methods return `AsyncIterable<Frame>` |
| `ServiceSettings` + `NOT_GIVEN` | `Partial<T>` for deltas, `Symbol` sentinel |
| `FrameSerializer` | `abstract class FrameSerializer { serialize(): Buffer; deserialize(): Frame }` |
| `VADAnalyzer` (ThreadPoolExecutor) | Web Worker or WASM module |
| `SOXRStreamAudioResampler` | Web Audio API or WASM resampler |
| `BaseObject` event handlers | `EventEmitter` or RxJS `Subject` |
