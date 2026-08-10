# VoiceMinusOne Latency Analysis

> **Measured latency profile** (from `turn_stats` events):
> STT 1175ms · LLM (Brain) 7001ms · First Audio 2747ms · Total 8176ms
>
> The single most damning number is the gap between **LLM start** and **First
> Audio**: the LLM begins producing tokens almost immediately after STT
> completes (~1175ms), yet the user hears nothing until 2747ms. That means
> **~1.5 seconds of already-generated LLM text is sitting in a buffer instead
> of coming out of the speaker.** This document explains exactly why.

---

## 1. Bottleneck #1 — Blocking `await flushSentence()` inside the LLM token loop

**Location:** `packages/server/src/session/session-manager.ts`, `runTurn()`, **line 328**

```ts
// session-manager.ts:317-329
for await (const token of brainResult) {
  if (signal.aborted) break
  assistantText += token
  sentenceBuffer += token
  this.sendEvent({ type: 'bot_text', text: token, messageId })

  // Check for sentence boundaries — flush to TTS immediately
  const sentenceEnd = sentenceBuffer.search(/[.!?]\s/)
  if (sentenceEnd !== -1) {
    const sentence = sentenceBuffer.slice(0, sentenceEnd + 2)
    sentenceBuffer = sentenceBuffer.slice(sentenceEnd + 2)
    await flushSentence(sentence)   // ← LINE 328: BLOCKS THE LLM LOOP
  }
}
```

### Why this is a latency source

`flushSentence()` (defined at line 294) does **three** things serially inside
the `for await` loop that consumes LLM tokens:

1. Calls `this.audioRouter.synthesizeChunks(trimmed)` — which calls
   `this.tts.synthesize(text, ttsConfig)` — which (per `tts.ts:136`) hits the
   Sarvam **REST** endpoint and **awaits the full HTTP response**.
2. Iterates over every audio chunk returned.
3. Sends each chunk via `this.transport.sendAudio(chunk.data)`.

Because this is an `await` **inside** the `for await (const token of
brainResult)` loop, **the LLM token generator is paused for the entire
duration of TTS synthesis + audio send.** The LLM cannot produce the *next*
token until TTS has finished synthesizing and the transport has finished
sending the *current* sentence.

This converts what should be a **pipelined** operation (LLM generates sentence
N+1 while TTS speaks sentence N) into a **strictly sequential** one:

```
LLM s1 → TTS s1 → send s1 → LLM s2 → TTS s2 → send s2 → ...
```

instead of the intended:

```
LLM s1 ──→ LLM s2 ──→ LLM s3 ──→ ...
    └──→ TTS s1 ──→ TTS s2 ──→ ...
            └──→ play s1 ──→ play s2
```

### The irony: the fix already exists but is unused

The `TurnManager` class (`packages/server/src/session/turn-manager.ts`,
line 127) already implements `enqueueTTS()` — a **non-blocking serial TTS
queue** that chains TTS tasks onto a `Promise` tail (`this.ttsTail`):

```ts
// turn-manager.ts:127-137
enqueueTTS(task: (generation: number) => Promise<void>): void {
  const gen = this.ttsGeneration
  this.ttsTail = this.ttsTail
    .then(async () => {
      if (gen !== this.ttsGeneration) return
      await task(gen)
    })
    .catch(...)
}
```

This is exactly the pattern needed: it preserves audio ordering (serial) while
**not blocking** the caller. But `runTurn()` never calls `enqueueTTS()`. It
calls `flushSentence()` directly with `await`. The reference project
voice-line uses the non-blocking `enqueueSentence()` pattern (see §6 below),
which is the same idea.

**Impact:** This is the dominant latency multiplier. With N sentences, the
total time is approximately `N × (LLM_sentence + TTS_sentence)` instead of
`LLM_total + TTS_one_sentence`. For a 7-second LLM response split into ~5
sentences, this can add **3–5 seconds** of avoidable serialization.

---

## 2. Bottleneck #2 — Sentence boundary detection only flushes on `/[.!?]\s/`

**Location:** `packages/server/src/session/session-manager.ts`, `runTurn()`, **line 324**

```ts
// session-manager.ts:324
const sentenceEnd = sentenceBuffer.search(/[.!?]\s/)
```

### Why this is a latency source

The regex `/[.!?]\s/` requires a **period, exclamation, or question mark
followed by whitespace** before any text is sent to TTS. This means:

- **No sub-sentence flushing.** A 30-word sentence is held in its entirety
  until the period arrives. If the LLM generates a long clause before its
  first period, first audio is delayed by the entire clause.
- **Commas, semicolons, colons, and natural phrase boundaries are ignored.**
  These are perfectly good TTS chunking points — a comma pause is natural in
  speech — but the code waits for a full sentence terminator.
- **The final sentence** (no trailing punctuation yet) is only flushed
  *after* the LLM stream ends, at line 339–341. This adds the full remaining
  TTS latency to the tail.

The reference project voice-line solves this with a `SentenceChunker`
(`packages/core/src/pipeline/chunker.ts`) that flushes on **both** punctuation
boundaries (including commas, semicolons, colons) **and** a word-count
fallback (`WORD_BATCH_SIZE = 6`). This means even a run-on sentence with no
punctuation gets flushed after 6 words, dramatically reducing time-to-first-
audio.

**Impact:** For a response where the first sentence is 15 words, first audio
is delayed by the time to generate all 15 words + TTS for the full sentence.
With sub-sentence flushing at 6 words, first audio could arrive after just
6 words.

---

## 3. Bottleneck #3 — STT opens a fresh WebSocket per turn

**Location:** `packages/provider-sarvam/src/stt.ts`, `transcribeWs()`, **line 109**

```ts
// stt.ts:104-114
const url = `${this.baseUrl.replace('https', 'wss')}/speech-to-text/ws?${params}`

// Use the shared createSarvamWebSocket helper...
const ws = await this.openWebSocket(url, this.apiKey)  // ← LINE 109: NEW CONNECTION EVERY TURN
if (!ws) {
  yield* this.transcribeRest(audio, config)
  return
}
```

### Why this is a latency source

`openWebSocket()` (line 356) calls `createSarvamWebSocket()` (`shared.ts:41`),
which performs a full WebSocket handshake: TCP connect + TLS handshake +
WebSocket upgrade + `await` for the `open` event. This happens **every single
turn**. There is no connection pooling, no pre-warming, no keep-alive.

The `createSarvamWebSocket` helper (`shared.ts:107-119`) even has a 10-second
timeout on the open event, indicating the authors know this can be slow:

```ts
// shared.ts:107-119
if (rawWs.readyState !== WS_OPEN) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(...), 10_000)
    rawWs.on('open', () => { clearTimeout(timer); resolve() })
    rawWs.on('error', (err) => { clearTimeout(timer); reject(...) })
  })
}
```

A cold WebSocket connection to a cloud API typically takes **200–500ms** for
the handshake. This is pure overhead added to every turn's STT phase, on top
of the actual transcription time.

The reference project micdrop's `CartesiaTTS` (`packages/cartesia/src/CartesiaTTS.ts`,
line 38) opens its WebSocket **once in the constructor** and keeps it alive
for the entire session, reconnecting only on failure. The `initPromise` is
awaited on first use but subsequent calls reuse the connection.

**Impact:** ~200–500ms of avoidable connection overhead per turn, directly
added to the STT phase (which is already 1175ms).

---

## 4. Bottleneck #4 — TTS uses REST per sentence (HTTP overhead each call)

**Location:** `packages/provider-sarvam/src/tts.ts`, `synthesize()`, **line 136**

```ts
// tts.ts:134-145
try {
  // REST is faster for sentence-level synthesis (no WS connection overhead)
  yield* this.synthesizeRest(trimmed, {   // ← LINE 136: REST PER SENTENCE
    speaker, language, model, pace,
    sampleRate, numChannels, signal,
  })
} catch (err) {
  ...
  yield* this.synthesizeWs(trimmed, {...})
}
```

### Why this is a latency source

The code comment on line 135 says "REST is faster for sentence-level
synthesis (no WS connection overhead)" — but this is a **false economy**.
Each REST call incurs:

- TCP/TLS handshake (if no keep-alive connection pool) or HTTP/2 stream
  setup
- HTTP request/response overhead (headers, JSON serialization of the body)
- The full response must arrive before `synthesizeRest` yields anything (it
  reads the stream to completion, concatenates chunks, then strips the WAV
  header — see `tts.ts:380-412`)

Critically, `synthesizeRest` **buffers the entire audio response** before
yielding (lines 382–411): it reads all chunks into an array, concatenates
them, strips the WAV header, and yields a **single** chunk. This means
**first audio for each sentence is delayed until the entire sentence's audio
is synthesized and downloaded.** There is no streaming of audio chunks as
they arrive from the server.

The WebSocket fallback path (`synthesizeWs`, line 171) is even worse for
latency: it opens a **new WebSocket connection per call** (line 189), which
the comment at line 111 admits "adds ~1s latency per sentence."

The reference project micdrop's `CartesiaTTS` streams audio chunks as they
arrive over a persistent WebSocket (`CartesiaTTS.ts:182-207`), emitting each
`chunk` immediately via `this.emit('Audio', chunk)`. No buffering, no
per-call connection overhead.

**Impact:** Per sentence: HTTP overhead (~50–150ms) + full-response buffering
(no streaming). Across 5 sentences: ~250–750ms of avoidable overhead, plus
delayed first audio within each sentence.

---

## 5. Bottleneck #5 — STT buffers all audio chunks, not true streaming

**Location:** `packages/provider-sarvam/src/stt.ts`, `transcribeWs()`, **lines 143–162** (message handling) combined with `session-manager.ts:246` (consumption pattern)

### Why this is a latency source

Looking at the full flow in `session-manager.ts`:

```ts
// session-manager.ts:246-253
for await (const result of this.audioRouter.transcribe(audioStream)) {
  transcripts.push(result)
  this.sendEvent({ type: 'transcript', text: result.text, isFinal: result.isFinal })
}
```

And in `audio-router.ts:96-105`, the `transcribe` method just forwards from
`this.opts.stt.transcribe()`. The STT provider's `transcribeWs` receives
audio via the `audio: AsyncIterable<AudioChunk>` parameter, but the audio
arrives **already fully buffered** — because `handleStopSpeaking()`
(`session-manager.ts:204-224`) calls `this.audioRouter.drainAudio()` which
returns the **entire** accumulated chunk array, then converts it to an async
iterable via `chunksToAsyncIterable()` (line 409).

This means the pipeline is:

```
[user speaks] → audio chunks buffered in sttChunkQueue
                    ↓ (user stops speaking)
              drainAudio() → all chunks at once → STT WebSocket
                    ↓
              STT transcribes → final transcript
                    ↓
              Brain starts → TTS starts
```

Instead of true streaming:

```
[user speaks] → audio chunks streamed to STT in real-time
                    ↓ (partial transcripts arrive as user speaks)
              partial transcripts available
                    ↓ (user stops speaking)
              final transcript arrives almost immediately
                    ↓
              Brain starts immediately
```

The STT WebSocket *does* support streaming (it has `flush_signal: 'true'`
and `high_vad_sensitivity: 'true'` in the URL params, `stt.ts:98-99`), but
the architecture feeds it a pre-buffered blob. The Sarvam STT could be
sending partial transcripts while the user is still speaking, allowing the
Brain to start earlier (speculatively) or at least warming up.

The reference project micdrop streams audio to STT in real-time via a
`PassThrough` (`MicdropServer.ts:192-193`):

```ts
// MicdropServer.ts:188-195
private onStartSpeaking() {
  this.currentUserStream?.end()
  this.currentUserStream = new PassThrough()
  this.config.stt.transcribe(this.currentUserStream)  // ← STREAM, not buffer
  this.cancel()
}
```

Audio chunks are written to the stream as they arrive (`onUserAudio`, line
174–179), and STT processes them incrementally.

**Impact:** The entire STT phase (1175ms) happens **after** the user stops
speaking, when it could overlap with the tail end of the user's speech. This
could shave 500ms–1s off the perceived latency.

---

## 6. Reference Projects' Approaches to Latency Reduction

The three reference projects under `.info/repo/` each demonstrate distinct,
citable patterns for reducing voice agent latency. Below are the specific
techniques found in their actual source code.

### 6.1 micdrop — Non-blocking stream pipeline + persistent connections

#### Pattern A: PassThrough stream connecting LLM → TTS (non-blocking)

**File:** `.info/repo/micdrop/packages/server/src/MicdropServer.ts:273-320`

micdrop's core insight is that the LLM and TTS are connected by a **Node.js
`PassThrough` stream**, not by `await` calls. The `Agent.answer()` method
(`Agent.ts:96-121`) returns a `Readable` stream immediately, and `_speak()`
(`MicdropServer.ts:304-320`) passes that stream directly to
`this.config.tts.speak(textStream)`:

```ts
// MicdropServer.ts:304-320
private async _speak(message: string | Readable) {
  let textStream: Readable
  if (typeof message === 'string') {
    const stream = new PassThrough()
    stream.write(message)
    stream.end()
    textStream = stream
  } else {
    textStream = message   // ← LLM stream passed directly to TTS
  }
  this.config.tts.speak(textStream)  // ← NOT awaited; fire-and-forget
}
```

The TTS provider reads from the stream as chunks arrive
(`CartesiaTTS.ts:51-67`):

```ts
// CartesiaTTS.ts:44-67
speak(textStream: Readable) {
  this.counter++
  const counter = this.counter
  const context_id = counter.toString()

  textStream.on('data', async (chunk: Buffer) => {
    if (counter !== this.counter) return
    const text = chunk.toString('utf-8').replace(/[\r\n ]+/g, ' ')
    await this.initPromise
    this.socket?.send(JSON.stringify({
      ...this.getConfig(),
      transcript: text,
      context_id,
      continue: true,   // ← STREAM: more text coming
    }))
  })

  textStream.on('end', async () => {
    this.socket?.send(JSON.stringify({
      ...this.getConfig(),
      transcript: '',
      context_id,
      continue: false,  // ← END OF STREAM
    }))
  })
}
```

**Why this matters for latency:** The LLM writes tokens to the stream; TTS
reads them as they arrive. Neither blocks the other. The `continue: true`
flag tells Cartesia "more text is coming, synthesize this incrementally" —
this is **true streaming TTS**, not sentence-batched. First audio can arrive
after the first few tokens, not after a full sentence.

#### Pattern B: Persistent WebSocket connection (pre-warmed)

**File:** `.info/repo/micdrop/packages/cartesia/src/CartesiaTTS.ts:34-42, 140-209`

The WebSocket is opened **once in the constructor** and kept alive for the
session lifetime:

```ts
// CartesiaTTS.ts:34-42
constructor(private readonly options: CartesiaTTSOptions) {
  super()
  this.initPromise = this.initWS().catch((error) => {
    this.reconnect()
  })
}
```

Subsequent `speak()` calls await `this.initPromise` (which resolves after
the first connection) but **reuse the same socket**. There is no per-call
connection overhead. If the connection drops, `reconnect()` (line 211) handles
reconnection with retry and even replays buffered text (`textSent`, line 228).

#### Pattern C: Counter-based cancellation (instant barge-in)

**File:** `.info/repo/micdrop/packages/cartesia/src/CartesiaTTS.ts:88-106`

```ts
// CartesiaTTS.ts:88-106
cancel() {
  if (!this.isProcessing) return
  this.isProcessing = false
  this.textSent = ''
  if (this.socket?.readyState === WebSocket.OPEN) {
    this.socket.send(JSON.stringify({
      context_id: this.counter.toString(),
      cancel: true,
    }))
  }
  this.counter++  // ← invalidates all in-flight messages
}
```

The `counter` is incremented on cancel, so any audio messages still in flight
from the server are ignored (line 187: `if (this.counter.toString() !==
message.context_id) return`). This gives **instant barge-in** without waiting
for pending TTS to drain.

#### Pattern D: Operation queue for serializing concurrent operations

**File:** `.info/repo/micdrop/packages/server/src/MicdropServer.ts:38-114`

micdrop serializes operations (answer, speak) through an `operationQueue`
rather than relying on `await` chains. This prevents overlapping audio while
keeping the event loop unblocked.

### 6.2 voice-line — Non-blocking serial TTS queue + eager streaming + sub-sentence chunking

#### Pattern A: `enqueueSentence()` — non-blocking serial TTS queue

**File:** `.info/repo/voice-line/packages/core/src/session/session.ts:465-484`

voice-line's `Session` class uses the same `ttsTail` promise-chaining pattern
that VoiceMinusOne's `TurnManager.enqueueTTS()` implements — but voice-line
**actually uses it** in its brain turn loop:

```ts
// voice-line session.ts:400-409
for await (const token of stream) {
  if (signal.aborted || this.destroyed) break
  this.assistantBuffer += token
  this.transport.sendEvent({ type: "bot:text:delta", delta: token, messageId })
  await this.outbound.push({ kind: "text", text: token })  // ← NON-BLOCKING
}
```

The `outbound` pipeline pushes text tokens through a `SentenceChunker`, which
emits `sentence` frames. These are consumed and enqueued via
`enqueueSentence()` (line 465):

```ts
// voice-line session.ts:465-484
private enqueueSentence(text: string): void {
  const gen = this.ttsGeneration
  const stream = eagerStream(this.tts.synthesize(text, this.ttsConfig))
  this.ttsTail = this.ttsTail
    .then(async () => {
      if (gen !== this.ttsGeneration || this.destroyed) return
      if (this.turnAbort?.signal.aborted) return
      for await (const chunk of stream) {
        if (gen !== this.ttsGeneration || this.destroyed) break
        if (this.turnAbort?.signal.aborted) break
        this.transport.sendAudio(chunk.data)
      }
    })
    .catch(...)
}
```

**Key difference from VoiceMinusOne:** The `for await` loop over LLM tokens
**never awaits TTS**. It pushes tokens to the outbound pipeline and keeps
consuming. TTS happens asynchronously on the `ttsTail` chain.

#### Pattern B: `eagerStream()` — decouple producer from consumer

**File:** `.info/repo/voice-line/packages/core/src/session/session.ts:32-76`

```ts
function eagerStream<T>(iterable: AsyncIterable<T>): AsyncIterable<T> {
  const queue: (T | Error)[] = []
  let done = false
  const state: { resolveWaiting: (() => void) | null } = { resolveWaiting: null }

  void (async () => {
    try {
      for await (const item of iterable) {
        queue.push(item)
        if (state.resolveWaiting) {
          const rw = state.resolveWaiting
          state.resolveWaiting = null
          rw()
        }
      }
    } catch (err) {
      queue.push(err instanceof Error ? err : new Error(String(err)))
    } finally {
      done = true
      if (state.resolveWaiting) { state.resolveWaiting = null; rw() }
    }
  })()

  return { async *[Symbol.asyncIterator]() { ... } }
}
```

This wraps a TTS `AsyncIterable` so that the producer (TTS synthesis) runs
**immediately and concurrently** with the consumer (the serial queue). The
TTS starts synthesizing the moment `enqueueSentence` is called, not when the
queue reaches it. This means by the time the previous sentence's audio
finishes sending, the next sentence's audio is likely **already partially
synthesized**.

#### Pattern C: Sub-sentence chunking with word-count fallback

**File:** `.info/repo/voice-line/packages/core/src/pipeline/chunker.ts:1-112`

voice-line's `SentenceChunker` flushes on **both** punctuation and a word
count:

```ts
// chunker.ts:4
const SENTENCE_END = /(?:(?<!\d)[.,]|[.,](?!\d)|[!?…;:…。！？،、，\n])/u

// chunker.ts:16
private readonly WORD_BATCH_SIZE = 6

// chunker.ts:61-78 — word count fallback
if (splitIndex === -1 && words.length >= this.WORD_BATCH_SIZE) {
  // If we reached our X-word batch limit, split after the Xth word
  let wordCount = 0
  let inWord = false
  for (let i = 0; i < trimmed.length; i++) {
    ...
    if (wordCount === this.WORD_BATCH_SIZE) { splitIndex = i; break }
  }
}
```

This accepts commas, semicolons, colons, and newlines as split points, and
falls back to splitting every 6 words if no punctuation arrives. This
ensures first audio arrives after ~6 words, not after a full sentence.

### 6.3 pipecat — Dual-queue frame pipeline with system frame priority

#### Pattern A: System frame priority (dual-queue)

**File:** `.info/repo/pipecat/src/pipecat/processors/frame_processor.py:119-135, 1095-1121`

pipecat's `FrameProcessorQueue` is a **priority queue** that processes
`SystemFrame` instances (interruptions, cancellations, start/stop) before
regular frames:

```python
# frame_processor.py:119-135
class FrameProcessorQueue(asyncio.PriorityQueue):
    HIGH_PRIORITY = 1
    LOW_PRIORITY = 2

    async def put(self, item):
        frame, _, _ = item
        if isinstance(frame, SystemFrame):
            # HIGH_PRIORITY — processed before any other frames
            ...
```

Two separate tasks handle frames
(`frame_processor.py:1095-1141`):

- `__input_frame_task_handler` — processes **system frames immediately**
  (interruptions, cancels)
- `__process_frame_task_handler` — processes **regular frames** (audio, text)
  in order

**Why this matters for latency:** When a user barge-in occurs, the
`InterruptionFrame` (a `SystemFrame`) jumps the queue and is processed
**before** any pending audio frames. This gives near-instant interruption
response, even if there are seconds of audio frames queued ahead. Without
this, interruption latency would grow with the queue depth.

#### Pattern B: Directional pipeline (downstream + upstream)

**File:** `.info/repo/pipecat/src/pipecat/pipeline/pipeline.py:57-88, 183-195`

pipecat's `Pipeline` processes frames in two directions:

- **DOWNSTREAM**: audio/text flows from input → output (STT → LLM → TTS →
  transport)
- **UPSTREAM**: control signals flow back (e.g., "TTS finished", "buffer
  drained") from output → input

This bidirectional flow allows the transport to signal backpressure upstream
without blocking. The `PipelineSource` and `PipelineSink` classes
(`pipeline.py:21-88`) handle routing frames in and out of the pipeline.

#### Pattern C: UninterruptibleFrame — frames that survive interruptions

**File:** `.info/repo/pipecat/src/pipecat/processors/frame_processor.py:43`

pipecat defines an `UninterruptibleFrame` mixin. Frames marked with this
interface are **not** cancelled by `InterruptionFrame`. This is critical for
metadata frames, end-of-turn markers, and cleanup frames that must be
processed even when the user barge-ins.

---

## Summary: Bottleneck → Impact → Reference Pattern

| # | Bottleneck | Location (file:line) | Impact | Reference Pattern |
|---|-----------|----------------------|--------|-------------------|
| 1 | Blocking `await flushSentence()` in LLM loop | `session-manager.ts:328` | Serializes LLM+TTS; ~3-5s added | micdrop PassThrough stream (`MicdropServer.ts:304`); voice-line `enqueueSentence` (`session.ts:465`) |
| 2 | Sentence-only flush regex `/[.!?]\s/` | `session-manager.ts:324` | Delays first audio to full sentence | voice-line `SentenceChunker` with word-count fallback (`chunker.ts:16`) |
| 3 | STT opens fresh WebSocket per turn | `stt.ts:109` | ~200-500ms connection overhead/turn | micdrop persistent WS in constructor (`CartesiaTTS.ts:38`) |
| 4 | TTS uses REST per sentence, buffers full response | `tts.ts:136, 382-411` | HTTP overhead + no audio streaming | micdrop streaming WS TTS with `continue: true` (`CartesiaTTS.ts:51-85`) |
| 5 | STT buffers all audio, not true streaming | `session-manager.ts:246` + `stt.ts` consumption | STT can't overlap with user speech | micdrop PassThrough to STT (`MicdropServer.ts:192`) |

The root cause is architectural: VoiceMinusOne's `runTurn()` uses a
**synchronous `await`-based pipeline** where each stage blocks the next,
while all three reference projects use **non-blocking streaming** patterns
where stages run concurrently and communicate via streams, queues, or frame
pipelines. The `TurnManager.enqueueTTS()` method already exists to enable
this — it just isn't called.
