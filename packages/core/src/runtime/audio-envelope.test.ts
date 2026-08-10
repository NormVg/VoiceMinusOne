import { describe, expect, it } from 'vitest'
import { decodeAudioEnvelope, encodeAudioEnvelope } from './audio-envelope'

describe('audio envelope', () => {
  it('round-trips the epoch, sequence, and PCM payload', () => {
    const decoded = decodeAudioEnvelope(encodeAudioEnvelope(7, 42, new Uint8Array([1, 2, 3]).buffer))
    expect(decoded?.epoch).toBe(7)
    expect(decoded?.sequence).toBe(42)
    expect(Array.from(new Uint8Array(decoded?.payload ?? new ArrayBuffer(0)))).toEqual([1, 2, 3])
  })

  it('leaves legacy raw PCM identifiable', () => {
    expect(decodeAudioEnvelope(new ArrayBuffer(8))).toBeNull()
  })
})
