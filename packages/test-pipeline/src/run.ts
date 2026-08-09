/**
 * Test pipeline runner — the main entry point.
 *
 * This script reads an audio file, streams it through the VoiceMinusOne
 * pipeline (STT → Brain → TTS), and verifies the results.
 *
 * Usage:
 *   pnpm --filter @voiceminusone/test-pipeline run test:audio
 *
 * Or with a custom audio file:
 *   node --experimental-strip-types src/run.ts /path/to/audio.mp3
 *
 * The test verifies:
 * 1. Audio file can be read and chunked
 * 2. STT receives all audio chunks and produces a transcript
 * 3. Brain receives the transcript and produces a response
 * 4. TTS receives the response and produces audio output
 * 5. The full pipeline completes without errors
 * 6. Timing is within acceptable bounds
 */

import { readAudioFile, getAudioInfo } from './audio-reader.ts'
import { MockSTT, MockTTS, mockBrain, createMockHistory } from './mocks.ts'
import type { AudioChunk, TranscriptResult } from '@voiceminusone/core'

// --- Test results ---

interface TestResult {
  name: string
  passed: boolean
  durationMs: number
  message: string
  details?: Record<string, unknown>
}

const results: TestResult[] = []

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now()
  try {
    await fn()
    results.push({
      name,
      passed: true,
      durationMs: Date.now() - start,
      message: 'PASSED',
    })
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
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

// --- Main ---

async function main(): Promise<void> {
  const audioPath = process.argv[2] ?? '../../test/test-clip.mp3'

  console.log('\n🎙️  VoiceMinusOne Test Pipeline')
  console.log('================================\n')
  console.log(`Audio file: ${audioPath}\n`)

  // Test 1: Audio file reading
  await runTest('Audio file exists and is readable', async () => {
    const info = await getAudioInfo(audioPath)
    assert(info.sizeBytes > 0, 'File should have content')
    console.log(`  Format: ${info.format}, Size: ${info.sizeBytes} bytes`)
    if (info.sampleRate > 0) {
      console.log(`  Sample rate: ${info.sampleRate}Hz, Channels: ${info.channels}`)
      console.log(`  Duration: ${info.durationSec.toFixed(2)}s`)
    }
  })

  // Test 2: Audio chunking
  let audioChunks: AudioChunk[] = []
  await runTest('Audio file can be chunked into PCM frames', async () => {
    for await (const chunk of readAudioFile(audioPath, 100)) {
      audioChunks.push(chunk)
    }
    assert(audioChunks.length > 0, 'Should produce at least one chunk')
    assert(audioChunks[0]!.data.byteLength > 0, 'Chunks should have audio data')
    console.log(`  Produced ${audioChunks.length} chunks`)
    console.log(`  First chunk: ${audioChunks[0]!.data.byteLength} bytes at ${audioChunks[0]!.sampleRate}Hz`)
  })

  // Test 3: STT processes audio and produces transcript
  let transcripts: TranscriptResult[] = []
  await runTest('STT provider receives audio and produces transcript', async () => {
    const stt = new MockSTT()
    const audioStream = (async function* () {
      for (const chunk of audioChunks) {
        yield chunk
      }
    })()

    for await (const result of stt.transcribe(audioStream, { language: 'en', mode: 'transcribe' })) {
      transcripts.push(result)
    }

    assert(transcripts.length > 0, 'STT should produce at least one result')
    const finalTranscript = transcripts.find((t) => t.isFinal)
    assert(finalTranscript !== undefined, 'Should have a final transcript')
    assert(finalTranscript!.text.length > 0, 'Transcript should not be empty')
    console.log(`  Produced ${transcripts.length} transcript segments`)
    console.log(`  Final: "${finalTranscript!.text}"`)
  })

  // Test 4: Brain processes transcript and produces response
  let brainResponse = ''
  await runTest('Brain (LLM) processes transcript and produces response', async () => {
    const finalTranscript = transcripts.find((t) => t.isFinal)!
    const history = createMockHistory('You are a helpful voice assistant.')
    const context = {
      sessionId: 'test-session-1',
      history,
      signal: new AbortController().signal,
    }

    const generator = mockBrain(finalTranscript.text, context)
    let wordCount = 0
    for await (const token of generator) {
      brainResponse += token
      wordCount++
    }

    assert(brainResponse.length > 0, 'Brain should produce a response')
    assert(wordCount > 0, 'Brain should stream at least one token')
    console.log(`  Response (${wordCount} tokens): "${brainResponse.slice(0, 100)}..."`)
  })

  // Test 5: TTS synthesizes audio from brain response
  let ttsChunks: AudioChunk[] = []
  await runTest('TTS provider synthesizes audio from brain response', async () => {
    const tts = new MockTTS()
    for await (const chunk of tts.synthesize(brainResponse, { speaker: 'shubh' })) {
      ttsChunks.push(chunk)
    }

    assert(ttsChunks.length > 0, 'TTS should produce at least one audio chunk')
    assert(ttsChunks[0]!.data.byteLength > 0, 'TTS chunks should have audio data')
    const totalBytes = ttsChunks.reduce((sum, c) => sum + c.data.byteLength, 0)
    console.log(`  Produced ${ttsChunks.length} audio chunks (${totalBytes} bytes)`)
  })

  // Test 6: Full pipeline timing
  await runTest('Full pipeline completes within reasonable time', async () => {
    const start = Date.now()

    // Re-run the full pipeline
    const stt = new MockSTT()
    const tts = new MockTTS()
    const audioStream = (async function* () {
      for (const chunk of audioChunks) {
        yield chunk
      }
    })()

    const sttResults: TranscriptResult[] = []
    for await (const result of stt.transcribe(audioStream, {})) {
      sttResults.push(result)
    }

    const finalTranscript = sttResults.find((t) => t.isFinal)!
    const context = {
      sessionId: 'test-session-2',
      history: createMockHistory('You are helpful.'),
      signal: new AbortController().signal,
    }

    let response = ''
    for await (const token of mockBrain(finalTranscript.text, context)) {
      response += token
    }

    const ttsResult: AudioChunk[] = []
    for await (const chunk of tts.synthesize(response, {})) {
      ttsResult.push(chunk)
    }

    const elapsed = Date.now() - start
    assert(elapsed < 30000, `Pipeline should complete in under 30s, took ${elapsed}ms`)
    console.log(`  Full pipeline: ${elapsed}ms`)
    console.log(`  STT → Brain → TTS all completed successfully`)
  })

  // --- Summary ---
  console.log('\n================================')
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

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
