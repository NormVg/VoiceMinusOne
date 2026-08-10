import { describe, expect, it } from 'vitest'
import { BoundedChannel } from './bounded-channel'

describe('BoundedChannel', () => {
  it('applies backpressure until a reader consumes a value', async () => {
    const channel = new BoundedChannel<number>({ capacity: 1 })
    await channel.write(1)

    let completed = false
    const blockedWrite = channel.write(2).then(() => {
      completed = true
    })

    await Promise.resolve()
    expect(completed).toBe(false)

    const iterator = channel[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: 1, done: false })
    await blockedWrite
    expect(completed).toBe(true)
    expect(await iterator.next()).toEqual({ value: 2, done: false })
  })

  it('ends readers after close', async () => {
    const channel = new BoundedChannel<string>({ capacity: 1 })
    channel.close()
    const iterator = channel[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })
})
