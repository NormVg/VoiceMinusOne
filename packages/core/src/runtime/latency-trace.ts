import type { Clock } from '../utils/clock'

export type LatencyMark =
  | 'vad_endpoint'
  | 'audio_sent'
  | 'audio_received'
  | 'stt_first'
  | 'stt_final'
  | 'llm_requested'
  | 'llm_first_token'
  | 'tts_first_pcm'
  | 'audio_sent_to_client'
  | 'audio_received_by_client'
  | 'playback_scheduled'

export interface LatencyTraceSnapshot {
  readonly startedAt: number
  readonly marks: Readonly<Partial<Record<LatencyMark, number>>>
}

export class LatencyTrace {
  private readonly startedAt: number
  private readonly marks: Partial<Record<LatencyMark, number>> = {}

  constructor(private readonly clock: Clock) {
    this.startedAt = clock.now()
  }

  mark(name: LatencyMark): number {
    const elapsed = this.clock.now() - this.startedAt
    this.marks[name] ??= elapsed
    return this.marks[name] ?? elapsed
  }

  snapshot(): LatencyTraceSnapshot {
    return { startedAt: this.startedAt, marks: { ...this.marks } }
  }
}
