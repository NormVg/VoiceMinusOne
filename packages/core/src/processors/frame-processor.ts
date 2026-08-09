/**
 * FrameProcessor — the base processing unit.
 *
 * Each processor receives frames, processes them, and pushes results
 * downstream (normal data path) or upstream (errors, interruptions).
 *
 * Features a dual-queue priority system (inspired by pipecat):
 * - System frames (interruptions, cancel) are processed immediately
 * - Data frames are processed in order
 *
 * This guarantees sub-millisecond interruption response even with a
 * full audio buffer.
 */

import type { AnyFrame } from '../frames/frames'
import { FrameDirection, FramePriority, isSystemFrame, isUninterruptible } from '../frames/frames'
import type { Logger } from '../utils/logger'
import { SilentLogger } from '../utils/logger'

export type FrameHandler = (frame: AnyFrame) => void | Promise<void>

export abstract class FrameProcessor {
  protected logger: Logger = new SilentLogger()
  private next: FrameProcessor | null = null
  private prev: FrameProcessor | null = null

  private systemQueue: AnyFrame[] = []
  private dataQueue: Array<{ frame: AnyFrame; direction: FrameDirection }> = []
  private processing = false
  private started = false
  private cancelling = false

  /** Link to the next processor in the pipeline (downstream). */
  link(processor: FrameProcessor): void {
    this.next = processor
    processor.prev = this
  }

  /** Set the logger for this processor. */
  setLogger(logger: Logger): void {
    this.logger = logger
  }

  /** Queue a frame for processing. System frames jump the queue. */
  async queueFrame(frame: AnyFrame, direction: FrameDirection = FrameDirection.Downstream): Promise<void> {
    if (this.cancelling && !isUninterruptible(frame)) {
      return
    }

    if (isSystemFrame(frame)) {
      // System frames are processed immediately
      this.systemQueue.push(frame)
    } else {
      this.dataQueue.push({ frame, direction })
    }

    await this.drainQueues()
  }

  /** Override this to handle specific frame types. */
  abstract processFrame(frame: AnyFrame, direction: FrameDirection): Promise<void>

  /** Push a frame downstream (to the next processor). */
  async pushFrame(frame: AnyFrame, direction: FrameDirection = FrameDirection.Downstream): Promise<void> {
    if (direction === FrameDirection.Downstream && this.next) {
      await this.next.queueFrame(frame, FrameDirection.Downstream)
    } else if (direction === FrameDirection.Upstream && this.prev) {
      await this.prev.queueFrame(frame, FrameDirection.Upstream)
    }
  }

  /** Start the processor. Called when a StartFrame arrives. */
  protected async start(): Promise<void> {
    this.started = true
  }

  /** Stop the processor. Called when a StopFrame arrives. */
  protected async stop(): Promise<void> {
    this.started = false
  }

  /** Cancel the processor. Called when a CancelFrame arrives. */
  protected async cancel(): Promise<void> {
    this.cancelling = true
    // Keep uninterruptible frames, drop the rest
    this.dataQueue = this.dataQueue.filter((item) => isUninterruptible(item.frame))
  }

  /** Handle an interruption. Override for custom behavior. */
  protected async handleInterruption(): Promise<void> {
    // Drop all non-uninterruptible data frames
    this.dataQueue = this.dataQueue.filter((item) => isUninterruptible(item.frame))
    this.cancelling = false
  }

  /** Whether this processor has been started. */
  isStarted(): boolean {
    return this.started
  }

  /** Process built-in frames, then delegate to subclass. */
  private async processFrameInternal(frame: AnyFrame, direction: FrameDirection): Promise<void> {
    // Handle built-in lifecycle frames first
    switch (frame.kind) {
      case 'start':
        await this.start()
        break
      case 'stop':
        await this.stop()
        break
      case 'cancel':
        await this.cancel()
        break
      case 'turn:interruption':
        await this.handleInterruption()
        break
    }

    // Delegate to subclass
    await this.processFrame(frame, direction)
  }

  /** Drain both queues — system frames first, then data frames. */
  private async drainQueues(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      // Process all system frames first
      while (this.systemQueue.length > 0) {
        const frame = this.systemQueue.shift()
        if (frame) {
          await this.processFrameInternal(frame, FrameDirection.Downstream)
        }
      }

      // Then process data frames in order
      while (this.dataQueue.length > 0) {
        const item = this.dataQueue.shift()
        if (item) {
          await this.processFrameInternal(item.frame, item.direction)
        }
      }
    } catch (error) {
      this.logger.error('processor', `Error processing frame: ${(error as Error).message}`)
      // Push error frame upstream
      const errorFrame = {
        id: 0,
        kind: 'error' as const,
        priority: FramePriority.System,
        code: 'PIPELINE_ERROR',
        message: (error as Error).message,
        fatal: false,
      } as AnyFrame
      await this.pushFrame(errorFrame, FrameDirection.Upstream)
    } finally {
      this.processing = false
    }

    // If more frames arrived during processing, drain again
    if (this.systemQueue.length > 0 || this.dataQueue.length > 0) {
      await this.drainQueues()
    }
  }
}
