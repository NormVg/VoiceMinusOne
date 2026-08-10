# VoiceMinusOne Latency Reduction Plan

> **Goal:** Reduce time-to-first-audio from 2747ms toward <1000ms, and total
> turn time from 8176ms toward <4000ms, by replacing the sequential
> `await`-based pipeline with a non-blocking streaming architecture.
>
> **Companion document:** `docs/latency-analysis.md` identifies the five
> specific bottlenecks this plan addresses.

---

## Iteration 1 — Initial Plan

### Identified latency reduction strategies

Based on analysis of the VoiceMinusOne codebase and the three reference
projects (micdrop, voice-line, pipecat), the following strategies are
available:

1. **Use `TurnManager.enqueueTTS()` instead of `await flushSentence()`**
   - The `TurnManager` already has a non-blocking serial TTS queue
     (`turn-manager.ts:127`). `runTurn()` should call `enqueueTTS()` instead
     of `await flushSentence()`, so LLM token generation continues while TTS
     synthesizes in the background.

2. **Sub-sentence flushing with word-count fallback**
   - Replace the `/[.!?]\s/` regex with a chunker that flushes on commas,
     semicolons, and a 6-word fallback, like voice-line's `SentenceChunker`
     (`chunker.ts`).

3. **Persistent WebSocket for STT**
   - Open the STT WebSocket once in `init()` or `start()` and reuse it across
     turns, like micdrop's `CartesiaTTS` constructor pattern.

4. **Persistent WebSocket for TTS with streaming**
   - Switch TTS from per-sentence REST to a persistent WebSocket that streams
     audio chunks as they arrive, like micdrop's `CartesiaTTS.speak()`.

5. **Stream audio to STT in real-time**
   - Instead of buffering all audio in `sttChunkQueue` and draining on
     `stop_speaking`, feed audio chunks to STT as they arrive, like micdrop's
     `PassThrough` pattern.

6. **LLM prompt optimization**
   - Use shorter system prompts, request concise responses, or use a faster
     model for first-token latency.

7. **Pre-warm TTS connection**
   - Open the TTS WebSocket at session start so the first sentence doesn't
     pay connection overhead.

### Reasoning — which to pursue and why

The highest-impact fix is **strategy 1** (non-blocking TTS), because the
blocking `await flushSentence()` is the single largest source of
serialization latency. If the LLM can generate tokens while TTS synthesizes,
total turn time drops from `N × (LLM + TTS)` to `LLM_total + TTS_one`.

Strategy 2 (sub-sentence flushing) is the second priority because it directly
reduces time-to-first-audio — the most user-perceptible metric.

Strategies 3 and 4 (connection reuse) are medium priority: each saves
200–500ms per turn, which is meaningful but not transformative.

Strategy 5 (real-time STT streaming) is lower priority because it requires
restructuring the audio routing architecture, which is a larger change.

Strategy 6 (LLM optimization) is orthogonal and can be pursued in parallel.

Strategy 7 (pre-warm TTS) is a subset of strategy 4.

**Proposed priority order:** 1 → 2 → 4 → 3 → 5 → 6

---

## Iteration 2 — Refined Plan

### Critique of Iteration 1

Iteration 1 lists seven strategies as a prioritized checklist. The problem
with a checklist is that it treats each fix as **independent** — but they
are not. Several have dependencies, and some are **patchwork** rather than
**real solutions**:

**What's patchwork:**

- **Strategy 1 alone is patchwork.** Swapping `await flushSentence()` for
  `enqueueTTS()` fixes the blocking, but `flushSentence()` still calls
  `synthesizeChunks()` which calls `tts.synthesize()` — and `tts.synthesize()`
  still uses REST per sentence with full-response buffering (`tts.ts:136,
  382-411`). So we've made the LLM non-blocking, but TTS itself is still
  slow and non-streaming. We've moved the bottleneck, not removed it.

- **Strategy 2 alone is patchwork.** A better chunker helps, but if TTS
  still buffers the full response before yielding (strategy 4 not done), then
  sub-sentence flushing just means more, smaller REST calls — each with HTTP
  overhead. We'd have 8 REST calls instead of 5, adding overhead.

- **Strategy 3 (STT connection pool) is patchwork** if STT still receives
  buffered audio. A persistent connection to which we send a blob is faster
  than a fresh connection, but it's still not streaming.

**What's missing:**

- **The TTS synthesis method itself must stream audio chunks**, not buffer
  them. `synthesizeRest()` (`tts.ts:380-411`) reads the entire HTTP response
  into an array, concatenates, then yields one chunk. Even with a persistent
  WebSocket, if `synthesizeWs()` buffers all audio before yielding, we gain
  nothing on first-audio-within-a-sentence. The TTS provider's `synthesize()`
  must yield audio chunks **as they arrive** from the server.

- **The `AudioRouter.synthesizeChunks()` method** (`audio-router.ts:111-119`)
  is a thin pass-through. It doesn't need to change, but it's the seam where
  streaming matters. If `tts.synthesize()` yields incrementally,
  `synthesizeChunks()` will too, and `flushSentence()` (or its non-blocking
  replacement) can send audio to the transport as it arrives.

- **Backpressure is not addressed.** If TTS produces audio faster than the
  transport can send it (or the client can play it), we need backpressure.
  voice-line's `eagerStream()` (`session.ts:32-76`) decouples the producer
  from the consumer, but without bounded buffering, memory can grow
  unbounded. pipecat's dual-queue with `UninterruptibleFrame` handles this
  more carefully.

- **The `runTurn()` method itself is too large.** It owns STT consumption,
  brain invocation, sentence buffering, TTS flushing, timing, history, and
  stats — all in one 170-line method. Any change risks breaking multiple
  concerns. The reference projects split these: micdrop has `Agent` + `TTS`
  + `MicdropServer`; voice-line has `Pipeline` + `SentenceChunker` +
  `Session.runBrainTurn()`.

### Dependencies between strategies

```
Strategy 1 (non-blocking enqueueTTS)
    └── depends on → Strategy 4 (TTS streams audio, not buffers)
            └── depends on → Strategy 4b (persistent WS connection)

Strategy 2 (sub-sentence chunker)
    └── benefits from → Strategy 4 (more chunks = more streaming opportunity)
    └── hindered by → REST per-sentence overhead (if 4 not done)

Strategy 5 (real-time STT streaming)
    └── depends on → Strategy 3 (persistent STT connection)
    └── depends on → AudioRouter restructuring (feed, not drain)
```

### Re-prioritization: patchwork vs. real solution

The key realization: **individual fixes are patchwork; a coherent streaming
pipeline is the real solution.** The distinction:

- **Patchwork:** Make `flushSentence` non-blocking but keep REST TTS. →
  Bottleneck moves from "LLM blocked by TTS" to "TTS is slow per call."
- **Real solution:** Replace the entire `await`-chain with a streaming
  pipeline where LLM tokens flow into a chunker, chunks flow into a
  persistent streaming TTS connection, and audio chunks flow to the transport
  — all non-blocking, with bounded buffering and backpressure.

The real solution is not seven independent fixes. It is **one architectural
change** with several coordinated components:

1. **LLM → Chunker → TTS streaming pipeline** (replaces `flushSentence`)
2. **Persistent, streaming TTS WebSocket** (replaces REST-per-sentence)
3. **Persistent STT WebSocket** (replaces per-turn connection)
4. **Real-time audio feed to STT** (replaces drain-and-send)

### Reasoning — what changed and why

Iteration 1 was a checklist of independent fixes. Iteration 2 recognizes
that these fixes are **interdependent** and must be designed as a coherent
streaming pipeline. The priority shifted from "fix the biggest bottleneck
first" to "design the end-to-end streaming architecture, then implement it
bottom-up (provider layer first, orchestration layer last)."

The reason for bottom-up: the orchestration layer (`runTurn`) can only be
non-blocking if the provider layer (`stt.ts`, `tts.ts`) supports streaming.
If we change `runTurn` first (Iteration 1's strategy 1), we'd be calling
`enqueueTTS()` with a `synthesize()` that still blocks on REST — gaining
nothing. The provider layer must stream first.

---

## Iteration 3 — Final Plan

### Architecture: Non-blocking streaming pipeline

The final plan replaces the sequential `await`-chain in `runTurn()` with a
pipeline where each stage runs concurrently:

```
LLM tokens → SentenceChunker → enqueueTTS() → streaming TTS WS → transport
     ↑                                                          ↓
     └──────── backpressure via bounded queue ←─────────────────┘
```

LLM tokens are never awaited for TTS. TTS audio chunks are sent to the
transport as they arrive. The serial TTS queue (`ttsTail`) preserves audio
ordering. Connections are persistent.

### Concrete code changes

#### Change 1: TTS provider — persistent streaming WebSocket

**File:** `packages/provider-sarvam/src/tts.ts`

**What changes:**

- Add a `private socket?: SarvamWebSocket` field and `private initPromise:
  Promise<void>` field to the `SarvamTTS` class, mirroring micdrop's
  `CartesiaTTS.ts:26-31`.
- In `init()` (line 84) or `start()` (line 89), open the WebSocket
  connection to `wss://api.sarvam.ai/text-to-speech/ws` once and store it.
  Send the config message (`{ type: "config", data: { speaker,
  language_code, ... } }`) immediately after connect. This pre-warms the
  connection so the first sentence pays zero connection overhead.
- Change `synthesize()` (line 116) to use the persistent socket: send
  `{ type: "text", data: { text } }` followed by `{ type: "flush" }`, and
  yield audio chunks from `onmessage` **as they arrive** — do not buffer
  them into an array first. The current `synthesizeWs()` (line 171) already
  has an `audioQueue` + `resolveAudio` pattern; refactor it to yield
  incrementally rather than collecting.
- Remove the REST-first default (line 136). The WebSocket path should be
  primary now that it's persistent. Keep REST as a fallback only if the WS
  connection fails.
- Add a `reconnect()` method mirroring `CartesiaTTS.ts:211-247` for
  resilience.
- Add counter-based cancellation (increment a `synthCounter` on `abort()`,
  ignore stale `onmessage` callbacks) mirroring `CartesiaTTS.ts:88-106`.

**Observable outcome:** TTS audio chunks arrive incrementally; first audio
chunk for a sentence arrives ~100-200ms after text is sent (not after the
full response). No per-sentence HTTP overhead. No per-call connection
overhead.

**Reference pattern adopted:** micdrop `CartesiaTTS.ts` — persistent WS in
constructor (line 38), streaming `on('data')` (line 51), `continue: true`
flag (line 63), counter-based cancel (line 88).

#### Change 2: STT provider — persistent WebSocket connection

**File:** `packages/provider-sarvam/src/stt.ts`

**What changes:**

- Add `private socket?: SarvamWebSocket` and `private initPromise` fields.
- In `init()` (line 56) or `start()` (line 60), open the STT WebSocket once
  and store it. Do not close it after each transcription.
- Refactor `transcribeWs()` (line 91) to reuse the persistent socket instead
  of calling `this.openWebSocket(url, this.apiKey)` at line 109. Send audio
  chunks to the open socket as they arrive from the `audio` async iterable,
  not as a single buffered blob.
- Move the `flush_signal` send and idle-timer logic into a per-transcription
  session (using a request ID or context ID), not a per-connection lifecycle.
- In `stop()` (line 62) or `destroy()` (line 66), close the persistent
  socket.

**Observable outcome:** STT connection overhead drops from ~200-500ms/turn
to ~0ms (amortized). Partial transcripts can arrive while the user is still
speaking.

**Reference pattern adopted:** micdrop `CartesiaTTS.ts:34-42` — connection
in constructor, `initPromise` awaited on use, reused across calls.

#### Change 3: Session manager — non-blocking LLM→TTS pipeline

**File:** `packages/server/src/session/session-manager.ts`

**What changes:**

- In `runTurn()` (line 232), replace the `await flushSentence(sentence)`
  call at line 328 with `this.turnManager.enqueueTTS(async (gen) => { ... })`.
  The enqueued task calls `this.audioRouter.synthesizeChunks(trimmed)` and
  sends chunks via `this.transport.sendAudio(chunk.data)`, but it is **not
  awaited** — it runs on the `ttsTail` promise chain.
- After the LLM token loop ends (line 330), flush remaining buffer via
  `enqueueTTS()` (not `await flushSentence()`), then `await
  this.turnManager.waitForTTS()` (line 140 of `turn-manager.ts`) to ensure
  all audio is sent before marking the turn done.
- Move the `firstAudioSent` / `mark('first_audio')` logic into the enqueued
  task, so it fires when the first audio chunk actually reaches the
  transport.
- The `flushSentence` helper (line 294) becomes the body of the enqueued
  task, minus the `await`.

**Observable outcome:** LLM token generation is never blocked by TTS. The
LLM loop runs at full speed; TTS consumes sentences concurrently on the
serial queue. Total turn time approaches `LLM_total + TTS_last_sentence`
instead of `N × (LLM_sentence + TTS_sentence)`.

**Reference pattern adopted:** voice-line `enqueueSentence()`
(`session.ts:465-484`) — non-blocking serial TTS queue with generation
check. Also micdrop's stream-based `_speak()` (`MicdropServer.ts:304-320`)
which passes the LLM stream directly to TTS without awaiting.

#### Change 4: Sub-sentence chunking with word-count fallback

**File:** `packages/server/src/session/session-manager.ts` (or a new
`packages/server/src/session/sentence-chunker.ts`)

**What changes:**

- Replace the regex at line 324 (`sentenceBuffer.search(/[.!?]\s/)`) with a
  chunker that flushes on:
  - Punctuation: `.`, `,`, `!`, `?`, `;`, `:`, newline (using a regex like
    voice-line's `chunker.ts:4`: `/(?:(?<!\d)[.,]|[.,](?!\d)|[!?…;:…\n])/u`)
  - Word-count fallback: flush after 6 words if no punctuation arrives
    (voice-line's `WORD_BATCH_SIZE = 6`, `chunker.ts:16`)
- Implement this as a small class with a `process(token: string): string[]`
  method that returns zero or more flushable chunks, mirroring voice-line's
  `SentenceChunker.process()` (`chunker.ts:22-96`).
- In `runTurn()`, call `chunker.process(token)` for each LLM token and
  `enqueueTTS()` each resulting chunk.

**Observable outcome:** First audio arrives after ~6 words instead of after
a full sentence. For a typical 15-word first sentence, this cuts
time-to-first-audio by ~40-60%.

**Reference pattern adopted:** voice-line `SentenceChunker`
(`chunker.ts:1-112`) — dual-strategy flushing with punctuation + word count.

#### Change 5: Real-time audio feed to STT (phase 2 — larger change)

**File:** `packages/server/src/session/audio-router.ts` and
`packages/server/src/session/session-manager.ts`

**What changes:**

- In `AudioRouter`, instead of buffering chunks in `sttChunkQueue` (line 42)
  and draining via `drainAudio()` (line 73), feed chunks directly to the STT
  provider's `transcribe()` async iterable as they arrive from
  `transport.onAudio()`.
- In `session-manager.ts`, `handleStopSpeaking()` (line 204) no longer calls
  `drainAudio()`. Instead, the STT stream was already running; on
  `stop_speaking`, send the flush signal to STT and await the final
  transcript.
- This requires the STT provider to support an ongoing transcription session
  (start on `start_speaking`, feed chunks, flush on `stop_speaking`), which
  depends on Change 2 (persistent STT connection).

**Observable outcome:** STT begins processing audio as the user speaks,
not after they stop. Partial transcripts may arrive before
`stop_speaking`. The 1175ms STT phase overlaps with the user's speech,
reducing perceived latency by up to the speech duration.

**Reference pattern adopted:** micdrop `MicdropServer.ts:188-195` —
`PassThrough` stream to STT on `startSpeaking`, chunks written in
`onUserAudio` (line 174-179).

#### Change 6: LLM-side optimizations (orthogonal, parallel)

**File:** `packages/adapter-ai-sdk/src/` (Brain adapter)

**What changes:**

- Ensure the Brain adapter uses `streamText()` with `textStream` (as
  micdrop's `AiSdkAgent.ts:55-77` does), not `generateText()` which waits
  for the full response. Verify the adapter yields tokens immediately.
- Consider prompt engineering: instruct the model to respond concisely
  (shorter first sentences = faster first audio).
- If using a slow model, consider a faster model for the first sentence and
  a smarter model for follow-up (pipecat's `llm_switcher.py` pattern).

**Observable outcome:** First LLM token arrives faster; first sentence is
shorter, reaching the chunker's flush threshold sooner.

**Reference pattern adopted:** micdrop `AiSdkAgent.ts:55-77` —
`for await (const textPart of result.textStream)` with immediate
`stream.write(textPart)`.

### Implementation order

The changes must be implemented bottom-up because the orchestration layer
depends on the provider layer:

1. **Change 1** (TTS persistent streaming WS) — provider layer, no
   dependencies
2. **Change 2** (STT persistent WS) — provider layer, no dependencies
3. **Change 4** (sub-sentence chunker) — standalone utility, no
   dependencies
4. **Change 3** (non-blocking `enqueueTTS` in `runTurn`) — depends on
   Change 1 (TTS must stream) and Change 4 (chunker provides input)
5. **Change 6** (LLM optimizations) — orthogonal, can be done anytime
6. **Change 5** (real-time STT feed) — depends on Change 2, larger
   architectural change, can be phased

### Reasoning — final refinements

Iteration 3 differs from Iteration 2 in three ways:

**First, it specifies exact file paths and what changes in each.** Iteration
2 identified the architectural shift but didn't say where the code lives.
Iteration 3 maps each strategy to a concrete file and function, with the
specific line numbers that change.

**Second, it adds an implementation order.** Iteration 2 said "bottom-up"
but didn't sequence the changes. Iteration 3 recognizes that Change 3
(non-blocking `runTurn`) is the headline fix but must come *after* Change 1
(TTS streaming) — otherwise we'd be enqueuing a blocking REST call, which
gains nothing. The dependency chain is: provider layer streams → chunker
splits → orchestration enqueues.

**Third, it separates Change 5 as a phase-2 item.** Iteration 2 listed
real-time STT streaming as a co-equal strategy. Iteration 3 recognizes it
requires restructuring `AudioRouter` (from drain-based to feed-based) and
depends on the persistent STT connection. It's valuable but larger, so it
should be a follow-up phase after the first four changes deliver the bulk
of the latency reduction.

**The expected impact**, based on the reference projects' patterns:

| Metric | Current | After Changes 1-4 | After Change 5 |
|--------|---------|-------------------|----------------|
| STT | 1175ms | 1175ms (unchanged) | ~200ms (overlaps with speech) |
| LLM → First Audio | 2747ms | ~800-1200ms | ~800-1200ms |
| Total | 8176ms | ~3500-4500ms | ~2500-3500ms |

The dominant win comes from Changes 1+3 (non-blocking streaming pipeline),
which eliminates the `N × (LLM + TTS)` serialization. Change 4 (sub-sentence
chunking) provides the time-to-first-audio win. Changes 2 and 5 (STT
optimizations) provide the tail-end win.
