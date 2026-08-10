# VoiceMinusOne — Real-Time Runtime Redesign Plan

## Current diagnosis

The current runtime is a request/response waterfall, not a streaming voice
pipeline. The browser uploads one complete utterance, the server buffers it,
Sarvam STT opens a new socket and submits the complete audio payload, and the
server blocks LLM token consumption while each TTS request completes. The
current latency counters also overlap these stages, so the displayed LLM and
TTS numbers are not independent measurements.

The target is a bounded, cancellable, session-oriented stream:

```text
AudioWorklet frames → VAD gate → persistent STT → final transcript
    → streaming Brain → bounded text channel → persistent TTS
    → bounded binary transport → epoch-aware playback
```

## Acceptance targets

All targets are measured at p50 and p95 on the same end-to-end scenario:

| Boundary | Target |
| --- | ---: |
| VAD endpoint → server receives last audio | ≤ 50ms p95 |
| Server routing/queue overhead | ≤ 25ms p95 |
| Speech endpoint → final STT result | ≤ 400ms p95 |
| Final transcript → first LLM token | ≤ 450ms p95 |
| First text phrase → first TTS PCM | ≤ 350ms p95 |
| First PCM received → audible playback | ≤ 75ms p95 |
| Speech endpoint → first audible response | ≤ 900ms p50, ≤ 1.3s p95 |

Full-response duration is tracked separately; a long response must not delay
the first audible phrase.

## Work phases

### Phase 0 — Measurement contract

- Replace overlapping `Date.now()` timers with monotonic trace timestamps.
- Trace VAD endpoint, last audio sent, server receive, STT first/final,
  LLM request/first token, phrase ready, TTS request/first PCM, socket send,
  socket receive, playback scheduled, and playback audible.
- Add queue depth, buffered bytes, cancelled frames, stale-frame drops, and
  provider reconnect counters.
- Keep the real-provider benchmark separate from deterministic unit tests.

### Phase 1 — Streaming runtime kernel

- Replace request/response provider contracts with explicit streaming session
  contracts (`open`, `write`, `flush`, `abort`, `close`).
- Add bounded async channels measured in bytes or milliseconds of audio.
- Give each turn a `TurnScope` containing its abort signal, generation/epoch,
  owned tasks, provider sessions, and trace.
- Make system/control frames preempt data work; interruption must not wait for
  an in-flight provider loop.
- Reject all frames from an invalidated turn epoch.

### Phase 2 — Browser capture and playback

- Capture 16kHz mono PCM continuously in an AudioWorklet using 20ms frames.
- Use VAD for gating and pre-roll, not as the audio recorder itself.
- Send binary audio while the user is speaking; send an explicit turn-end
  event only after VAD endpoint.
- Replace the speaker queue with epoch-aware scheduled-source tracking.
- On interruption, stop/disconnect every scheduled source and flush stale PCM.
- Use adaptive 40–60ms prebuffering, not a fixed long quiet-flush delay.

### Phase 3 — Provider sessions

- Keep one Sarvam STT WebSocket alive per VoiceMinusOne session and send live
  audio frames; flush on VAD endpoint.
- Keep one Sarvam TTS streaming connection alive per session, with a context
  id per turn and incremental text input.
- Yield provider audio as soon as it arrives; never concatenate a full TTS
  response before yielding.
- Keep Sarvam’s vendor-required encoding inside the provider package only;
  VoiceMinusOne application transports remain binary.
- Add explicit batch-provider adapters for providers that cannot stream.

### Phase 4 — Streaming turn orchestration

- LLM tokens flow into a phrase-aware chunker and bounded text channel.
- TTS consumes phrases concurrently while the Brain continues generating.
- Preserve audio order with a bounded ordered scheduler, not an unbounded
  eager stream or blocking `await` in the Brain loop.
- Limit default response length for voice and expose model/provider timing so a
  slow model can be identified instead of hidden in “TTS” time.
- Interrupting a turn aborts Brain, STT, TTS, queued phrases, and playback in
  one operation.

### Phase 5 — Protocol and transport V2

- Add versioned binary audio envelopes containing turn epoch and sequence.
- Keep control events Zod-validated and high priority.
- Add bounded WebSocket/Ably output queues and congestion reporting.
- Make reconnect/resume explicitly epoch-safe.
- Migrate Nuxt integration to the same server runtime; do not maintain a
  second session implementation in the adapter.

### Phase 6 — Verification and cleanup

- Deterministic fake-provider tests for queue ordering, cancellation,
  backpressure, first-audio latency, and stale audio rejection.
- Browser E2E tests for audible latency, barge-in, playback flush, reconnect,
  and throttled networks.
- Live Sarvam/Ollama benchmark through the actual browser-to-server path.
- Remove the old utterance-buffered session path once V2 passes the gates.
- Update package API docs and mark the breaking change explicitly; this project
  is still pre-1.0.

## First implementation slice

The first code change is intentionally narrow but on the real hot path:

1. route LLM phrases through the existing ordered TTS queue;
2. feed phrases from the existing six-word/punctuation chunker;
3. wait for queued audio only after Brain generation finishes;
4. add tests proving TTS latency cannot pause Brain token production.

This is a prerequisite for the provider-session rewrite, not the final
architecture. The next slice must replace the buffered STT and per-request TTS
contracts rather than layering more orchestration onto them.
