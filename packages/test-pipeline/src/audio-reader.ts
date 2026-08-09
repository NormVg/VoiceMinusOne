/**
 * Audio file reader — reads an audio file and converts it to PCM chunks
 * suitable for streaming through the STT pipeline.
 *
 * Supports:
 * - WAV files (parsed directly)
 * - MP3 files (decoded via ffmpeg if available, otherwise raw bytes)
 *
 * The reader outputs AudioChunk objects that can be fed to any STTProvider.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import type { AudioChunk } from '@voiceminusone/core'

export interface AudioFileInfo {
  readonly format: 'wav' | 'mp3' | 'unknown'
  readonly sampleRate: number
  readonly channels: number
  readonly durationSec: number
  readonly sizeBytes: number
}

/** Detect audio format from file extension. */
function detectFormat(filePath: string): 'wav' | 'mp3' | 'unknown' {
  if (filePath.endsWith('.wav')) return 'wav'
  if (filePath.endsWith('.mp3')) return 'mp3'
  return 'unknown'
}

/** Parse WAV header to get audio info. */
function parseWavHeader(buffer: Buffer): AudioFileInfo {
  // RIFF header: bytes 0-3 = "RIFF", 8-11 = "WAVE"
  // fmt chunk: bytes 12-15 = "fmt ", 16-19 = chunk size
  // Audio format: bytes 20-21 (1 = PCM)
  // Channels: bytes 22-23
  // Sample rate: bytes 24-27
  // Bits per sample: bytes 34-35

  const sampleRate = buffer.readUInt32LE(24)
  const channels = buffer.readUInt16LE(22)
  const bitsPerSample = buffer.readUInt16LE(34)
  const dataSize = buffer.readUInt32LE(40)
  const durationSec = dataSize / (sampleRate * channels * (bitsPerSample / 8))

  return {
    format: 'wav',
    sampleRate,
    channels,
    durationSec,
    sizeBytes: buffer.length,
  }
}

/** Check if ffmpeg is available. */
function hasFfmpeg(): boolean {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return result.status === 0
  } catch {
    return false
  }
}

/** Convert MP3 to WAV using ffmpeg, returning raw PCM. */
async function decodeMp3WithFfmpeg(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', filePath,
      '-f', 's16le',           // 16-bit signed little-endian PCM
      '-acodec', 'pcm_s16le',
      '-ar', '16000',          // 16kHz sample rate
      '-ac', '1',              // Mono
      '-',                     // Output to stdout
    ], { stdio: ['ignore', 'pipe', 'ignore'] })

    const chunks: Buffer[] = []
    ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    ff.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`))
      } else {
        resolve(Buffer.concat(chunks))
      }
    })
    ff.on('error', reject)
  })
}

/** Read an audio file and return its info. */
export async function getAudioInfo(filePath: string): Promise<AudioFileInfo> {
  if (!existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`)
  }

  const format = detectFormat(filePath)
  const stat = await import('node:fs/promises').then((fs) => fs.stat(filePath))

  if (format === 'wav') {
    const buffer = await readFile(filePath)
    return parseWavHeader(buffer)
  }

  // For MP3 and unknown formats, return basic info
  return {
    format,
    sampleRate: 0,
    channels: 0,
    durationSec: 0,
    sizeBytes: stat.size,
  }
}

/**
 * Read an audio file and yield PCM audio chunks.
 *
 * For WAV: reads directly, chunks the PCM data.
 * For MP3: decodes via ffmpeg to 16kHz mono PCM, then chunks.
 */
export async function* readAudioFile(
  filePath: string,
  chunkDurationMs = 100,
): AsyncIterable<AudioChunk> {
  if (!existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`)
  }

  const format = detectFormat(filePath)
  let pcmBuffer: Buffer
  let sampleRate = 16000
  let channels = 1

  if (format === 'wav') {
    const fileBuffer = await readFile(filePath)
    const info = parseWavHeader(fileBuffer)
    sampleRate = info.sampleRate
    channels = info.channels
    // Skip the 44-byte WAV header to get raw PCM data
    pcmBuffer = fileBuffer.subarray(44)
  } else if (format === 'mp3') {
    if (!hasFfmpeg()) {
      throw new Error(
        'ffmpeg is required to decode MP3 files. Install it or provide a WAV file.',
      )
    }
    pcmBuffer = await decodeMp3WithFfmpeg(filePath)
    sampleRate = 16000
    channels = 1
  } else {
    throw new Error(`Unsupported audio format: ${format}. Use WAV or MP3.`)
  }

  // Calculate chunk size: samples_per_chunk = sampleRate * (chunkDurationMs / 1000) * channels * 2 bytes
  const bytesPerSample = 2 // 16-bit PCM
  const chunkBytes = Math.floor(sampleRate * (chunkDurationMs / 1000) * channels * bytesPerSample)

  let offset = 0
  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + chunkBytes, pcmBuffer.length)
    const chunk = pcmBuffer.subarray(offset, end)
    // Copy to a new ArrayBuffer to avoid sharing the large buffer
    const copy = new ArrayBuffer(chunk.length)
    new Uint8Array(copy).set(new Uint8Array(chunk))

    yield {
      data: copy,
      sampleRate,
      numChannels: channels,
    }

    offset = end
  }
}
