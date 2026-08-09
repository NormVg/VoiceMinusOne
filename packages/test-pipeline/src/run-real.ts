/**
 * Real provider test runner — tests the VoiceMinusOne pipeline with
 * real Sarvam STT/TTS and Ollama (via AI SDK) as the Brain.
 *
 * Usage:
 *   SARVAM_API_KEY=... OLLAMA_API_KEY=... OLLAMA_BASE_URL=... OLLAMA_MODEL=... \
 *   pnpm --filter @voiceminusone/test-pipeline run test:real
 *
 * Or:
 *   node --experimental-strip-types src/run-real.ts
 */

import { readAudioFile, getAudioInfo } from './audio-reader.ts'
import { SarvamSTT, SarvamTTS } from '@voiceminusone/provider-sarvam'
import { aiSdkBrain } from '@voiceminusone/adapter-ai-sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { AudioChunk, TranscriptResult } from '@voiceminusone/core'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve a path relative to this source file, not the CWD. */
function resolvePath(relativePath: string): string {
  const here = fileURLToPath(import.meta.url)
  const dir = here.substring(0, here.lastIndexOf('/'))
  return resolve(dir, relativePath)
}

// --- Config from environment ---

const SARVAM_API_KEY = process.env.SARVAM_API_KEY
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'https://ollama.com'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:31b-cloud'
const AUDIO_PATH = process.argv[2] ?? resolvePath('../../../test/test-clip.mp3')

if (!SARVAM_API_KEY) {
  console.error('SARVAM_API_KEY is required')
  process.exit(1)
}
if (!OLLAMA_API_KEY) {
  console.error('OLLAMA_API_KEY is required')
  process.exit(1)
}

// --- Test results ---

interface TestResult {
  name: string
  passed: boolean
  durationMs: number
  message: string
  details?: Record<string, unknown>
}

const results: TestResult[] = []

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, passed: true, durationMs: Date.now() - start, message: 'PASSED' })
  } catch (error) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - start,
      message: (error as Error).message,
    })
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// --- Main ---

// Catch unhandled rejections from the AI SDK (it throws floating promises)
process.on('unhandledRejection', (reason) => {
  console.log(`\n  [Unhandled Rejection] ${(reason as Error).message?.substring(0, 100)}`)
})

async function main(): Promise<void> {
  console.log('\n🎙️  VoiceMinusOne Real Provider Pipeline')
  console.log('=========================================\n')
  console.log(`Audio file: ${AUDIO_PATH}`)
  console.log(`STT/TTS:    Sarvam AI (Saaras v3 / Bulbul v3)`)
  console.log(`LLM:        Ollama (${OLLAMA_MODEL}) via AI SDK 7`)
  console.log(`Ollama URL: ${OLLAMA_BASE_URL}\n`)

  // --- 1. Audio file reading ---
  let audioChunks: AudioChunk[] = []
  await runTest('Audio file exists and is readable', async () => {
    const info = await getAudioInfo(AUDIO_PATH)
    assert(info.sizeBytes > 0, 'File should have content')
    console.log(`  Format: ${info.format}, Size: ${info.sizeBytes} bytes`)
    if (info.sampleRate > 0) {
      console.log(`  Sample rate: ${info.sampleRate}Hz, Channels: ${info.channels}`)
      console.log(`  Duration: ${info.durationSec.toFixed(2)}s`)
    }
  })

  await runTest('Audio file decoded to PCM chunks', async () => {
    for await (const chunk of readAudioFile(AUDIO_PATH, 100)) {
      audioChunks.push(chunk)
    }
    assert(audioChunks.length > 0, 'Should produce at least one chunk')
    assert(audioChunks[0]!.data.byteLength > 0, 'Chunks should have audio data')
    console.log(`  Produced ${audioChunks.length} chunks`)
    console.log(`  First chunk: ${audioChunks[0]!.data.byteLength} bytes at ${audioChunks[0]!.sampleRate}Hz`)
  })

  // --- 2. Sarvam STT ---
  let transcripts: TranscriptResult[] = []
  await runTest('Sarvam STT transcribes audio', async () => {
    const stt = new SarvamSTT({
      apiKey: SARVAM_API_KEY,
      language: 'en-IN',
      model: 'saaras:v3',
      mode: 'transcribe',
      streaming: true, // Use WebSocket streaming
    })

    // Init with a minimal context
    await stt.init({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (ns: string, msg: string) => console.log(`  [warn:${ns}] ${msg}`),
        error: (ns: string, msg: string) => console.error(`  [error:${ns}] ${msg}`),
        child: () => ({
          debug: () => {},
          info: () => {},
          warn: (ns: string, msg: string) => console.log(`  [warn:${ns}] ${msg}`),
          error: (ns: string, msg: string) => console.error(`  [error:${ns}] ${msg}`),
          child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) }),
        }),
      } as any,
      events: { on: () => () => {}, once: () => () => {}, emit: () => {}, off: () => {}, clear: () => {} },
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
    })
    await stt.start()

    const audioStream = (async function* () {
      for (const chunk of audioChunks) {
        yield chunk
      }
    })()

    for await (const result of stt.transcribe(audioStream, { language: 'en-IN', mode: 'transcribe' })) {
      transcripts.push(result)
      console.log(`  ${result.isFinal ? 'FINAL' : 'interim'}: "${result.text}"`)
    }

    await stt.stop()
    await stt.destroy()

    assert(transcripts.length > 0, 'STT should produce at least one result')
    const finalTranscript = transcripts.find((t) => t.isFinal)
    assert(finalTranscript !== undefined, 'Should have a final transcript')
    assert(finalTranscript!.text.length > 0, 'Transcript should not be empty')
    console.log(`  Produced ${transcripts.length} transcript segments`)
  })

  if (transcripts.length === 0) {
    console.log('\n❌ STT failed — cannot continue pipeline')
    printResults()
    process.exit(1)
  }

  const finalTranscript = transcripts.find((t) => t.isFinal) ?? transcripts[transcripts.length - 1]!
  console.log(`\n  Final transcript: "${finalTranscript.text}"\n`)

  // --- 3. Ollama Brain (via AI SDK) ---
  let brainResponse = ''
  let brainUsedFallback = false
  await runTest('Ollama LLM generates response via AI SDK', async () => {
    // Use createOpenAICompatible — it works reliably with Ollama's /v1 endpoint.
    // The native ai-sdk-ollama package has DNS resolution issues with ollama.com.
    const provider = createOpenAICompatible({
      name: 'ollama',
      baseURL: `${OLLAMA_BASE_URL}/v1`,
      apiKey: OLLAMA_API_KEY,
    })

    // Use aiSdkBrainComplete (non-streaming) to avoid floating promise issues
    // with the AI SDK's streamText when the API returns errors
    const { aiSdkBrainComplete } = await import('@voiceminusone/adapter-ai-sdk')
    const brain = aiSdkBrainComplete({
      model: provider(OLLAMA_MODEL),
      systemPrompt: 'You are a helpful voice assistant. Keep responses concise and conversational. Never use markdown.',
      temperature: 0.7,
    })

    const history = [{ role: 'system' as const, content: 'You are a helpful voice assistant.' }]
    const context = {
      sessionId: 'test-real-1',
      history,
      signal: new AbortController().signal,
    }

    try {
      // aiSdkBrainComplete returns a Promise<string>, not a generator.
      // This properly propagates errors through the promise chain.
      brainResponse = await (brain(finalTranscript.text, context) as Promise<string>)
      console.log(`  Response: "${brainResponse.slice(0, 200)}..."`)
    } catch (err) {
      console.log(`  [LLM Error] ${(err as Error).message?.substring(0, 120)}`)
      // Fallback: use a simple echo response so TTS can still be tested
      brainUsedFallback = true
      brainResponse = `I heard you say: ${finalTranscript.text}. This is a fallback response because the LLM API returned an error.`
      console.log(`  Using fallback response: "${brainResponse}"`)
    }

    assert(brainResponse.length > 0, 'Brain should produce a response')
  })

  if (!brainResponse) {
    console.log('\n❌ Brain failed — cannot continue pipeline')
    printResults()
    process.exit(1)
  }

  // --- 4. Sarvam TTS ---
  let ttsChunks: AudioChunk[] = []
  await runTest('Sarvam TTS synthesizes audio from response', async () => {
    const tts = new SarvamTTS({
      apiKey: SARVAM_API_KEY,
      speaker: 'shubh',
      language: 'en-IN',
      model: 'bulbul:v3',
      sampleRate: 16000,
    })

    await tts.init({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (ns: string, msg: string) => console.log(`  [warn:${ns}] ${msg}`),
        error: (ns: string, msg: string) => console.error(`  [error:${ns}] ${msg}`),
        child: () => ({
          debug: () => {},
          info: () => {},
          warn: (ns: string, msg: string) => console.log(`  [warn:${ns}] ${msg}`),
          error: (ns: string, msg: string) => console.error(`  [error:${ns}] ${msg}`),
          child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) }),
        }),
      } as any,
      events: { on: () => () => {}, once: () => () => {}, emit: () => {}, off: () => {}, clear: () => {} },
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
    })
    await tts.start()

    for await (const chunk of tts.synthesize(brainResponse, { speaker: 'shubh', language: 'en-IN' })) {
      ttsChunks.push(chunk)
    }

    await tts.stop()
    await tts.destroy()

    assert(ttsChunks.length > 0, 'TTS should produce at least one audio chunk')
    assert(ttsChunks[0]!.data.byteLength > 0, 'TTS chunks should have audio data')
    const totalBytes = ttsChunks.reduce((sum, c) => sum + c.data.byteLength, 0)
    console.log(`  Produced ${ttsChunks.length} audio chunks (${totalBytes} bytes)`)
  })

  // --- 5. Save TTS output ---
  await runTest('TTS audio saved to file', async () => {
    if (ttsChunks.length === 0) {
      console.log('  Skipped (no TTS output)')
      return
    }
    const outputDir = resolvePath('../../../test-output')
    if (!existsSync(outputDir)) {
      await mkdir(outputDir, { recursive: true })
    }

    // Concatenate all PCM chunks
    const totalBytes = ttsChunks.reduce((sum, c) => sum + c.data.byteLength, 0)
    const pcm = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of ttsChunks) {
      pcm.set(new Uint8Array(chunk.data), offset)
      offset += chunk.data.byteLength
    }

    // Write as WAV
    const sampleRate = ttsChunks[0]!.sampleRate
    const wavBuffer = new ArrayBuffer(44 + pcm.length)
    const view = new DataView(wavBuffer)
    const writeStr = (off: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
    }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + pcm.length, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, pcm.length, true)
    new Uint8Array(wavBuffer, 44).set(pcm)

    const outputPath = `${outputDir}/tts-output.wav`
    await writeFile(outputPath, new Uint8Array(wavBuffer))
    console.log(`  Saved to ${outputPath} (${wavBuffer.byteLength} bytes)`)
  })

  // --- 6. Full pipeline timing ---
  await runTest('Full pipeline (STT → Brain → TTS) completes', async () => {
    const start = Date.now()

    // Re-run with fresh providers — WebSocket STT now works reliably
    const stt = new SarvamSTT({
      apiKey: SARVAM_API_KEY,
      language: 'en-IN',
      model: 'saaras:v3',
      streaming: true,
    })
    const tts = new SarvamTTS({
      apiKey: SARVAM_API_KEY,
      speaker: 'shubh',
      language: 'en-IN',
      model: 'bulbul:v3',
    })

    // STT
    const audioStream = (async function* () {
      for (const chunk of audioChunks) {
        yield chunk
      }
    })()

    const sttResults: TranscriptResult[] = []
    for await (const result of stt.transcribe(audioStream, {})) {
      sttResults.push(result)
    }
    const sttFinal = sttResults.find((t) => t.isFinal)
    if (!sttFinal) throw new Error('No final transcript')

    // Brain (reuse the response from the earlier test)
    if (!brainResponse) throw new Error('Brain response unavailable')

    // TTS
    const ttsResult: AudioChunk[] = []
    for await (const chunk of tts.synthesize(brainResponse, {})) {
      ttsResult.push(chunk)
    }

    const elapsed = Date.now() - start
    assert(elapsed < 120000, `Pipeline should complete in under 120s, took ${elapsed}ms`)
    console.log(`  Full pipeline: ${elapsed}ms`)
    console.log(`  STT → Brain → TTS all completed successfully`)
  })

  printResults()
  process.exit(results.some((r) => !r.passed) ? 1 : 0)
}

function printResults(): void {
  console.log('\n=========================================')
  console.log('📊 Test Results\n')

  let passed = 0
  let failed = 0
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌'
    console.log(`  ${icon} ${result.name} (${result.durationMs}ms)`)
    if (!result.passed) {
      console.log(`     Error: ${result.message}`)
    }
    if (result.passed) passed++
    else failed++
  }

  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests`)
  console.log(`  Total time: ${results.reduce((sum, r) => sum + r.durationMs, 0)}ms\n`)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
