import { describe, it, expect } from 'vitest'
import {
  parseClientEvent,
  serializeServerEvent,
  isValidServerEvent,
  WireProtocolParseError,
} from './protocol'

describe('Wire protocol', () => {
  describe('parseClientEvent', () => {
    it('should parse a valid start_speaking event', () => {
      const event = parseClientEvent(JSON.stringify({ type: 'start_speaking' }))
      expect(event.type).toBe('start_speaking')
    })

    it('should parse a valid stop_speaking event', () => {
      const event = parseClientEvent(JSON.stringify({ type: 'stop_speaking' }))
      expect(event.type).toBe('stop_speaking')
    })

    it('should parse a valid mute event', () => {
      const event = parseClientEvent(JSON.stringify({ type: 'mute', muted: true }))
      expect(event.type).toBe('mute')
      expect(event.muted).toBe(true)
    })

    it('should throw on malformed JSON', () => {
      expect(() => parseClientEvent('not json')).toThrow(WireProtocolParseError)
    })

    it('should throw on unknown event type', () => {
      expect(() =>
        parseClientEvent(JSON.stringify({ type: 'unknown_event' })),
      ).toThrow(WireProtocolParseError)
    })

    it('should throw on missing required field', () => {
      expect(() =>
        parseClientEvent(JSON.stringify({ type: 'mute' })),
      ).toThrow(WireProtocolParseError)
    })
  })

  describe('serializeServerEvent', () => {
    it('should serialize a transcript event', () => {
      const serialized = serializeServerEvent({
        type: 'transcript',
        text: 'hello',
        isFinal: true,
      })
      const parsed = JSON.parse(serialized)
      expect(parsed.type).toBe('transcript')
      expect(parsed.text).toBe('hello')
      expect(parsed.isFinal).toBe(true)
    })

    it('should serialize a bot_text event', () => {
      const serialized = serializeServerEvent({
        type: 'bot_text',
        text: 'response',
        messageId: 'msg-1',
      })
      const parsed = JSON.parse(serialized)
      expect(parsed.type).toBe('bot_text')
      expect(parsed.messageId).toBe('msg-1')
    })

    it('should serialize an error event', () => {
      const serialized = serializeServerEvent({
        type: 'error',
        code: 'STT_FAILED',
        message: 'transcription failed',
      })
      const parsed = JSON.parse(serialized)
      expect(parsed.code).toBe('STT_FAILED')
    })

    it('should serialize a state event', () => {
      const serialized = serializeServerEvent({
        type: 'state',
        state: 'listening',
      })
      const parsed = JSON.parse(serialized)
      expect(parsed.state).toBe('listening')
    })
  })

  describe('isValidServerEvent', () => {
    it('should return true for valid events', () => {
      expect(
        isValidServerEvent({ type: 'transcript', text: 'hi', isFinal: true }),
      ).toBe(true)
    })

    it('should return false for invalid events', () => {
      expect(isValidServerEvent({ type: 'unknown' })).toBe(false)
      expect(isValidServerEvent({ foo: 'bar' })).toBe(false)
      expect(isValidServerEvent(null)).toBe(false)
    })
  })
})
