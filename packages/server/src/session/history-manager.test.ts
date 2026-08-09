import { describe, it, expect } from 'vitest'
import { HistoryManager } from './history-manager'

describe('HistoryManager', () => {
  it('should start empty', () => {
    const h = new HistoryManager()
    expect(h.length).toBe(0)
    expect(h.getMessages()).toEqual([])
  })

  it('should add user messages', () => {
    const h = new HistoryManager()
    h.addUserMessage('hello')
    expect(h.length).toBe(1)
    expect(h.getMessages()[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('should add assistant messages', () => {
    const h = new HistoryManager()
    h.addAssistantMessage('hi there')
    expect(h.getMessages()[0]).toEqual({ role: 'assistant', content: 'hi there' })
  })

  it('should add messages in order', () => {
    const h = new HistoryManager()
    h.addUserMessage('hello')
    h.addAssistantMessage('hi')
    h.addUserMessage('how are you?')
    h.addAssistantMessage('good, thanks')

    const msgs = h.getMessages()
    expect(msgs).toHaveLength(4)
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[1]?.role).toBe('assistant')
    expect(msgs[2]?.role).toBe('user')
    expect(msgs[3]?.role).toBe('assistant')
  })

  it('should update existing assistant message', () => {
    const h = new HistoryManager()
    const id = h.addAssistantMessage('partial')
    h.updateAssistantMessage(id, 'full response', false)

    const msgs = h.getMessages()
    expect(msgs[0]?.content).toBe('full response')
  })

  it('should get last N messages', () => {
    const h = new HistoryManager()
    h.addUserMessage('a')
    h.addAssistantMessage('b')
    h.addUserMessage('c')
    h.addAssistantMessage('d')

    const last2 = h.getLast(2)
    expect(last2).toHaveLength(2)
    expect(last2[0]?.content).toBe('c')
    expect(last2[1]?.content).toBe('d')
  })

  it('should clear history', () => {
    const h = new HistoryManager()
    h.addUserMessage('hello')
    h.clear()
    expect(h.length).toBe(0)
  })

  it('should generate unique ids', () => {
    const h = new HistoryManager()
    const id1 = h.addUserMessage('a')
    const id2 = h.addUserMessage('b')
    expect(id1).not.toBe(id2)
  })

  it('should handle metadata', () => {
    const h = new HistoryManager()
    h.addUserMessage('hello', { source: 'voice' })
    const msgs = h.getMessages()
    expect(msgs[0]?.metadata).toEqual({ source: 'voice' })
  })
})
