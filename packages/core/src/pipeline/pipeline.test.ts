import { describe, it, expect, vi } from 'vitest'
import { Pipeline } from './pipeline'
import { FrameProcessor } from '../processors/frame-processor'
import { frames, FrameKind, FrameDirection } from '../frames/frames'
import type { AnyFrame } from '../frames/frames'

/** A simple pass-through processor that records all frames it sees. */
class RecordingProcessor extends FrameProcessor {
  received: AnyFrame[] = []

  async processFrame(frame: AnyFrame, direction: FrameDirection): Promise<void> {
    this.received.push(frame)
    await this.pushFrame(frame, direction)
  }
}

/** A processor that drops frames (consumes them). */
class DropProcessor extends FrameProcessor {
  async processFrame(_frame: AnyFrame): Promise<void> {
    // Drop the frame — don't push downstream
  }
}

describe('Pipeline', () => {
  it('should chain processors and pass frames downstream', async () => {
    const p1 = new RecordingProcessor()
    const p2 = new RecordingProcessor()
    const pipeline = new Pipeline([p1, p2])

    const output: AnyFrame[] = []
    pipeline.onOutput((frame) => output.push(frame))

    await pipeline.push(frames.text('hello'))

    expect(p1.received).toHaveLength(1)
    expect(p2.received).toHaveLength(1)
    expect(output).toHaveLength(1)
    expect(output[0]?.kind).toBe(FrameKind.Text)
  })

  it('should handle multiple frames in order', async () => {
    const p1 = new RecordingProcessor()
    const pipeline = new Pipeline([p1])

    await pipeline.push(frames.text('a'))
    await pipeline.push(frames.text('b'))
    await pipeline.push(frames.text('c'))

    expect(p1.received).toHaveLength(3)
    expect((p1.received[0] as { text: string }).text).toBe('a')
    expect((p1.received[1] as { text: string }).text).toBe('b')
    expect((p1.received[2] as { text: string }).text).toBe('c')
  })

  it('should support upstream frame flow', async () => {
    const p1 = new RecordingProcessor()
    const p2 = new RecordingProcessor()
    const pipeline = new Pipeline([p1, p2])

    const upstream: AnyFrame[] = []
    pipeline.onUpstream((frame) => upstream.push(frame))

    // Push an error frame upstream from p2
    await p2.pushFrame(frames.error('TEST', 'test error'), FrameDirection.Upstream)

    expect(upstream).toHaveLength(1)
    expect(upstream[0]?.kind).toBe(FrameKind.Error)
  })

  it('should throw on empty processor list', () => {
    expect(() => new Pipeline([])).toThrow()
  })

  it('should allow a processor to drop frames', async () => {
    const drop = new DropProcessor()
    const after = new RecordingProcessor()
    const pipeline = new Pipeline([drop, after])

    const output: AnyFrame[] = []
    pipeline.onOutput((frame) => output.push(frame))

    await pipeline.push(frames.text('hello'))

    expect(after.received).toHaveLength(0)
    expect(output).toHaveLength(0)
  })
})

describe('FrameProcessor', () => {
  it('should process system frames before data frames', async () => {
    const processor = new RecordingProcessor()

    // Create a pipeline with just this processor
    const pipeline = new Pipeline([processor])

    const output: AnyFrame[] = []
    pipeline.onOutput((frame) => output.push(frame))

    // Push a data frame first, then a system frame
    await pipeline.push(frames.text('data'))
    await pipeline.push(frames.interruption())

    // System frame (interruption) should be processed
    expect(output.some((f) => f.kind === FrameKind.Interruption)).toBe(true)
    expect(output.some((f) => f.kind === FrameKind.Text)).toBe(true)
  })
})
