import { describe, it, expect } from 'vitest'
import { MemoryTransport } from './memory-transport'

describe('MemoryTransport', () => {
  it('should create a linked pair', () => {
    const [a, b] = MemoryTransport.pair()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a.state.connected).toBe(false)
  })

  it('should connect and update state', async () => {
    const [a] = MemoryTransport.pair()
    await a.connect('session-1')
    expect(a.state.connected).toBe(true)
  })

  it('should send audio from one side to the other', async () => {
    const [a, b] = MemoryTransport.pair()
    await a.connect('session-1')
    await b.connect('session-1')

    const received: ArrayBuffer[] = []
    b.onAudio((chunk) => received.push(chunk))

    const audio = new ArrayBuffer(1024)
    a.sendAudio(audio)

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(audio)
  })

  it('should send events from one side to the other', async () => {
    const [a, b] = MemoryTransport.pair()
    await a.connect('session-1')
    await b.connect('session-1')

    const received: unknown[] = []
    b.onEvent((event) => received.push(event))

    const event = { type: 'start_speaking' }
    a.sendEvent(event)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  it('should support unsubscribe', async () => {
    const [a, b] = MemoryTransport.pair()
    await a.connect('session-1')
    await b.connect('session-1')

    const received: ArrayBuffer[] = []
    const unsub = b.onAudio((chunk) => received.push(chunk))

    a.sendAudio(new ArrayBuffer(512))
    expect(received).toHaveLength(1)

    unsub()
    a.sendAudio(new ArrayBuffer(512))
    expect(received).toHaveLength(1) // No new audio after unsubscribe
  })

  it('should disconnect and stop receiving', async () => {
    const [a, b] = MemoryTransport.pair()
    await a.connect('session-1')
    await b.connect('session-1')

    await a.disconnect()
    expect(a.state.connected).toBe(false)

    const received: ArrayBuffer[] = []
    b.onAudio((chunk) => received.push(chunk))
    a.sendAudio(new ArrayBuffer(512))
    expect(received).toHaveLength(0)
  })
})
