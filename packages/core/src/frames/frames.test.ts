import { describe, it, expect } from 'vitest'
import {
  FrameKind,
  FramePriority,
  FrameDirection,
  frames,
  createFrame,
  isSystemFrame,
  isUninterruptible,
} from './frames'

describe('Frame system', () => {
  describe('createFrame', () => {
    it('should create a frame with auto-generated id', () => {
      const frame = createFrame(FrameKind.Text, { text: 'hello' })
      expect(frame.id).toBeGreaterThan(0)
      expect(frame.kind).toBe(FrameKind.Text)
    })

    it('should assign System priority to system frame kinds', () => {
      const frame = frames.interruption()
      expect(frame.priority).toBe(FramePriority.System)
    })

    it('should assign Data priority to data frame kinds', () => {
      const frame = frames.text('hello')
      expect(frame.priority).toBe(FramePriority.Data)
    })

    it('should generate unique ids for each frame', () => {
      const f1 = frames.text('a')
      const f2 = frames.text('b')
      expect(f1.id).not.toBe(f2.id)
    })
  })

  describe('frame constructors', () => {
    it('should create a start frame with default sample rates', () => {
      const frame = frames.start()
      expect(frame.kind).toBe(FrameKind.Start)
      expect(frame.audioInSampleRate).toBe(16000)
      expect(frame.audioOutSampleRate).toBe(24000)
    })

    it('should create an end frame marked as uninterruptible', () => {
      const frame = frames.end()
      expect(frame.kind).toBe(FrameKind.End)
      expect(isUninterruptible(frame)).toBe(true)
    })

    it('should create an audio raw frame with correct fields', () => {
      const audio = new ArrayBuffer(1024)
      const frame = frames.audioRaw(audio, 16000)
      expect(frame.kind).toBe(FrameKind.AudioRaw)
      expect(frame.audio).toBe(audio)
      expect(frame.sampleRate).toBe(16000)
      expect(frame.numChannels).toBe(1)
    })

    it('should create a TTS audio frame with context id', () => {
      const audio = new ArrayBuffer(512)
      const frame = frames.ttsAudioRaw(audio, 24000, 'ctx-1')
      expect(frame.kind).toBe(FrameKind.TTSAudioRaw)
      expect(frame.contextId).toBe('ctx-1')
    })

    it('should create a transcript frame', () => {
      const frame = frames.transcript('hello world', 1000)
      expect(frame.kind).toBe(FrameKind.Transcript)
      expect(frame.text).toBe('hello world')
      expect(frame.timestamp).toBe(1000)
    })

    it('should create an error frame', () => {
      const frame = frames.error('STT_FAILED', 'transcription failed')
      expect(frame.kind).toBe(FrameKind.Error)
      expect(frame.code).toBe('STT_FAILED')
      expect(frame.fatal).toBe(false)
    })

    it('should create tool call and result frames', () => {
      const call = frames.toolCall('tc-1', 'search', '{"q":"test"}')
      expect(call.kind).toBe(FrameKind.ToolCall)
      expect(call.toolName).toBe('search')

      const result = frames.toolResult('tc-1', 'search', '{"results":[]}')
      expect(result.kind).toBe(FrameKind.ToolResult)
    })
  })

  describe('isSystemFrame', () => {
    it('should return true for interruption frames', () => {
      expect(isSystemFrame(frames.interruption())).toBe(true)
    })

    it('should return true for user started speaking frames', () => {
      expect(isSystemFrame(frames.userStartedSpeaking())).toBe(true)
    })

    it('should return false for text frames', () => {
      expect(isSystemFrame(frames.text('hello'))).toBe(false)
    })
  })

  describe('FrameDirection', () => {
    it('should have downstream and upstream values', () => {
      expect(FrameDirection.Downstream).toBe('downstream')
      expect(FrameDirection.Upstream).toBe('upstream')
    })
  })
})
