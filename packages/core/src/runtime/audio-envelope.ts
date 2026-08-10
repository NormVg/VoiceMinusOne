/** Versioned binary envelope for PCM transport frames. */
export interface AudioEnvelope {
  readonly epoch: number
  readonly sequence: number
  readonly payload: ArrayBuffer
}

const MAGIC = 0x564d4f31
const HEADER_BYTES = 12

export function encodeAudioEnvelope(epoch: number, sequence: number, payload: ArrayBuffer): ArrayBuffer {
  if (!Number.isInteger(epoch) || epoch < 0 || !Number.isInteger(sequence) || sequence < 0) {
    throw new RangeError('Audio envelope epoch and sequence must be non-negative integers')
  }
  const data = new Uint8Array(HEADER_BYTES + payload.byteLength)
  const view = new DataView(data.buffer)
  view.setUint32(0, MAGIC)
  view.setUint32(4, epoch)
  view.setUint32(8, sequence)
  data.set(new Uint8Array(payload), HEADER_BYTES)
  return data.buffer
}

/** Returns null for legacy raw PCM frames so rolling upgrades remain possible. */
export function decodeAudioEnvelope(data: ArrayBuffer): AudioEnvelope | null {
  if (data.byteLength < HEADER_BYTES) return null
  const view = new DataView(data)
  if (view.getUint32(0) !== MAGIC) return null
  return { epoch: view.getUint32(4), sequence: view.getUint32(8), payload: data.slice(HEADER_BYTES) }
}
