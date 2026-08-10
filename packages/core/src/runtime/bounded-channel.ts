import { PipelineError } from '../errors'

export interface BoundedChannelOptions {
  readonly capacity: number
}

/**
 * A bounded async FIFO channel. Writers wait when the channel is full, which
 * makes backpressure explicit instead of accumulating unbounded audio/text.
 */
export class BoundedChannel<T> implements AsyncIterable<T> {
  private readonly capacity: number
  private readonly values: T[] = []
  private readonly readers: Array<(result: IteratorResult<T>) => void> = []
  private readonly writers: Array<() => void> = []
  private closed = false
  private failure: Error | null = null

  constructor(options: BoundedChannelOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new PipelineError('PIPELINE_ERROR', 'Channel capacity must be a positive integer')
    }
    this.capacity = options.capacity
  }

  get size(): number {
    return this.values.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  async write(value: T, signal?: AbortSignal): Promise<void> {
    this.throwIfUnavailable()
    if (signal?.aborted) return

    while (this.values.length >= this.capacity && this.readers.length === 0) {
      await this.waitForSpace(signal)
      this.throwIfUnavailable()
      if (signal?.aborted) return
    }

    const reader = this.readers.shift()
    if (reader) {
      reader({ value, done: false })
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.resolveReaders()
    this.resolveWriters()
  }

  abort(error: Error): void {
    if (this.closed) return
    this.failure = error
    this.closed = true
    this.values.length = 0
    this.resolveReaders()
    this.resolveWriters()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = await this.read()
      if (next.done) return
      yield next.value
    }
  }

  private async read(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) {
      this.releaseWriter()
      return { value, done: false }
    }
    this.throwIfFailed()
    if (this.closed) return { value: undefined, done: true }
    return new Promise<IteratorResult<T>>((resolve) => this.readers.push(resolve))
  }

  private waitForSpace(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const onAbort = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const writer = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.writers.push(writer)
    })
  }

  private releaseWriter(): void {
    this.writers.shift()?.()
  }

  private resolveReaders(): void {
    while (this.readers.length > 0) {
      this.readers.shift()?.({ value: undefined, done: true })
    }
  }

  private resolveWriters(): void {
    while (this.writers.length > 0) this.writers.shift()?.()
  }

  private throwIfUnavailable(): void {
    this.throwIfFailed()
    if (this.closed) {
      throw new PipelineError('PIPELINE_ERROR', 'Cannot write to a closed channel')
    }
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure
  }
}
