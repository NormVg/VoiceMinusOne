/**
 * Pipeline — chains FrameProcessors in sequence.
 *
 * A Pipeline is itself a FrameProcessor, so pipelines can nest.
 * Frames flow downstream (input → output) and upstream (output → input).
 *
 * The Pipeline wraps its processors with a source and sink that intercept
 * frames at both ends, allowing the pipeline runner to observe and control
 * the flow.
 */

import type { AnyFrame } from '../frames/frames'
import { FrameDirection } from '../frames/frames'
import { FrameProcessor } from '../processors/frame-processor'
import type { FrameHandler } from '../processors/frame-processor'

export class Pipeline extends FrameProcessor {
  private processors: FrameProcessor[]
  private source: PipelineSource
  private sink: PipelineSink

  constructor(processors: FrameProcessor[]) {
    super()
    if (processors.length === 0) {
      throw new Error('Pipeline requires at least one processor')
    }
    this.processors = processors
    this.source = new PipelineSource()
    this.sink = new PipelineSink()

    // Link: source → processor[0] → ... → processor[n] → sink
    const chain = [this.source as FrameProcessor, ...processors, this.sink]
    for (let i = 0; i < chain.length - 1; i++) {
      chain[i]?.link(chain[i + 1] as FrameProcessor)
    }
  }

  async processFrame(frame: AnyFrame, direction: FrameDirection): Promise<void> {
    // Route to source (downstream) or sink (upstream)
    if (direction === FrameDirection.Downstream) {
      await this.source.queueFrame(frame, FrameDirection.Downstream)
    } else {
      await this.sink.queueFrame(frame, FrameDirection.Upstream)
    }
  }

  /** Push a frame into the pipeline from outside (entry point). */
  async push(frame: AnyFrame): Promise<void> {
    await this.source.queueFrame(frame, FrameDirection.Downstream)
  }

  /** Set a handler for frames that exit the pipeline downstream (output). */
  onOutput(handler: FrameHandler): void {
    this.sink.onDownstream(handler)
  }

  /** Set a handler for frames that exit the pipeline upstream (errors, etc). */
  onUpstream(handler: FrameHandler): void {
    this.source.onUpstream(handler)
  }

  /** Get the processors in this pipeline. */
  getProcessors(): FrameProcessor[] {
    return [...this.processors]
  }
}

/**
 * PipelineSource — first processor in the chain.
 * Forwards upstream frames to an external handler, pushes downstream normally.
 */
class PipelineSource extends FrameProcessor {
  private upstreamHandler: FrameHandler | null = null

  async processFrame(frame: AnyFrame, direction: FrameDirection): Promise<void> {
    if (direction === FrameDirection.Upstream) {
      if (this.upstreamHandler) {
        await this.upstreamHandler(frame)
      }
    } else {
      // Downstream frames pass through to the next processor
      await this.pushFrame(frame, FrameDirection.Downstream)
    }
  }

  onUpstream(handler: FrameHandler): void {
    this.upstreamHandler = handler
  }
}

/**
 * PipelineSink — last processor in the chain.
 * Forwards downstream frames to an external handler, pushes upstream normally.
 */
class PipelineSink extends FrameProcessor {
  private downstreamHandler: FrameHandler | null = null

  async processFrame(frame: AnyFrame, direction: FrameDirection): Promise<void> {
    if (direction === FrameDirection.Downstream) {
      if (this.downstreamHandler) {
        await this.downstreamHandler(frame)
      }
    } else {
      // Upstream frames pass through to the previous processor
      await this.pushFrame(frame, FrameDirection.Upstream)
    }
  }

  onDownstream(handler: FrameHandler): void {
    this.downstreamHandler = handler
  }
}
