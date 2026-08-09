/**
 * HistoryManager — manages conversation message history.
 *
 * Focused component that only handles message storage and retrieval.
 * Does not manage state, pipelines, or transport.
 */

import type { ConversationMessage } from '@voiceminusone/core'

export interface HistoryEntry {
  readonly id: string
  readonly message: ConversationMessage
  readonly timestamp: number
  readonly partial?: boolean
}

export class HistoryManager {
  private entries: HistoryEntry[] = []
  private idCounter = 0

  /** Add a user message to history. */
  addUserMessage(content: string, metadata?: Record<string, unknown>): string {
    const id = this.nextId()
    const entry: HistoryEntry = {
      id,
      message: {
        role: 'user',
        content,
        ...(metadata !== undefined ? { metadata } : {}),
      },
      timestamp: Date.now(),
    }
    this.entries.push(entry)
    return id
  }

  /** Add an assistant message to history. */
  addAssistantMessage(
    content: string,
    opts?: { id?: string; partial?: boolean; metadata?: Record<string, unknown> },
  ): string {
    const id = opts?.id ?? this.nextId()
    const entry: HistoryEntry = {
      id,
      message: {
        role: 'assistant',
        content,
        ...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {}),
      },
      timestamp: Date.now(),
      ...(opts?.partial !== undefined ? { partial: opts.partial } : {}),
    }
    this.entries.push(entry)
    return id
  }

  /** Update an existing assistant message (e.g., append streaming text). */
  updateAssistantMessage(id: string, content: string, partial?: boolean): void {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx >= 0) {
      const existing = this.entries[idx]!
      const updated: HistoryEntry = {
        ...existing,
        message: { ...existing.message, content },
        ...(partial !== undefined ? { partial } : {}),
      }
      this.entries[idx] = updated
    }
  }

  /** Get all messages as ConversationMessage[]. */
  getMessages(): ConversationMessage[] {
    return this.entries.map((e) => e.message)
  }

  /** Get all entries (with metadata). */
  getEntries(): HistoryEntry[] {
    return [...this.entries]
  }

  /** Get the last N messages. */
  getLast(n: number): ConversationMessage[] {
    return this.entries.slice(-n).map((e) => e.message)
  }

  /** Clear all history. */
  clear(): void {
    this.entries = []
  }

  /** Get the number of messages. */
  get length(): number {
    return this.entries.length
  }

  private nextId(): string {
    this.idCounter += 1
    return `msg-${this.idCounter}`
  }
}
