/**
 * SentenceChunker — accumulates streaming LLM tokens and emits flushable
 * text chunks sized for low-latency TTS without splitting mid-sentence.
 *
 * Mirrors the voice-line SentenceChunker pattern (see
 * `.info/repo/voice-line/packages/core/src/pipeline/chunker.ts`) but
 * operates on plain strings instead of Frames: callers feed tokens via
 * `process(token)` and receive zero or more ready-to-synthesize chunks.
 *
 * Flush rules:
 *  1. Punctuation boundary — `.`, `,`, `!`, `?`, `;`, `:`, or newline.
 *     A period or comma adjacent to a digit is treated as part of a
 *     number (e.g. `3.14`, `1,000`) and does NOT trigger a flush.
 *     When a `.` or `,` lands at the very edge of the buffer we hold it
 *     back one token, because the next character decides whether it is a
 *     decimal/thousands separator or a real sentence boundary.
 *  2. Word-count fallback — after 6 words with no punctuation, flush to
 *     bound latency. Counting uses whitespace runs, so a trailing partial
 *     word never counts as a full word.
 *
 * Per R-012: a focused, independently testable component. No state beyond
 * its own buffer.
 */

/** Punctuation that can end a chunk. */
const PUNCT_CHARS = '.,!?;:\n'

/**
 * Maximum words accumulated before a punctuation-free flush. Tuned to
 * balance TTS naturalness against first-audio latency, matching the
 * voice-line reference.
 */
const WORD_BATCH_SIZE = 6

export class SentenceChunker {
  /** Accumulated text not yet flushed. */
  private buffer = ''

  /**
   * Feed a single LLM token and return any chunks that became flushable.
   *
   * The returned strings are trimmed and non-empty. An empty array means
   * the token was absorbed into the buffer pending more input.
   */
  process(token: string): string[] {
    this.buffer += token
    return this.drain()
  }

  /** Flush whatever remains in the buffer (e.g. at end of LLM stream). */
  flush(): string[] {
    const chunks: string[] = []
    const rem = this.buffer.trim()
    if (rem.length > 0) {
      chunks.push(rem)
    }
    this.buffer = ''
    return chunks
  }

  /** Reset internal state (e.g. between sessions or on interruption). */
  reset(): void {
    this.buffer = ''
  }

  /**
   * Repeatedly extract flushable chunks from the buffer.
   *
   * Each pass trims leading whitespace, then looks for the earliest
   * punctuation boundary that is safe to split on. If none is safe but
   * the word count has reached the batch limit, it splits after the 6th
   * word. When neither applies, it stops and waits for more tokens.
   */
  private drain(): string[] {
    const chunks: string[] = []

    while (true) {
      const trimmed = this.buffer.trimStart()
      if (trimmed.length === 0) {
        this.buffer = ''
        break
      }

      let splitIndex = this.findPunctuationSplit(trimmed)

      if (splitIndex === -1) {
        splitIndex = this.findWordCountSplit(trimmed)
      }

      if (splitIndex === -1) {
        // Not enough to flush yet — keep the trimmed buffer and stop.
        this.buffer = trimmed
        break
      }

      const chunk = trimmed.slice(0, splitIndex).trim()
      this.buffer = trimmed.slice(splitIndex)
      if (chunk.length > 0) {
        chunks.push(chunk)
      }
    }

    return chunks
  }

  /**
   * Find the index at which to split on punctuation, or -1.
   *
   * Scans for the first punctuation character. A `.` or `,` is only a
   * boundary when it is NOT adjacent to a digit on either side — that
   * keeps `3.14` and `1,000` intact. `!`, `?`, `;`, `:`, and newline
   * are always boundaries.
   *
   * Edge case: when a `.` or `,` is the last non-whitespace character in
   * the buffer, the next token decides its meaning (number vs. sentence
   * end). We decline to split there and let the next token resolve it.
   */
  private findPunctuationSplit(text: string): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (!PUNCT_CHARS.includes(ch)) {
        continue
      }

      if (ch === '.' || ch === ',') {
        const prev = i > 0 ? text[i - 1] : ''
        const next = i + 1 < text.length ? text[i + 1] : ''
        const prevIsDigit = prev !== undefined && prev !== '' && /\d/.test(prev)
        const nextIsDigit = next !== undefined && next !== '' && /\d/.test(next)

        // Decimal/thousands separator — part of a number, not a boundary.
        if (prevIsDigit || nextIsDigit) {
          continue
        }

        // Ambiguous at buffer edge — wait for the next token to resolve.
        // "next" here is either empty or non-digit whitespace; only the
        // truly-at-end case (no following char) is ambiguous, because a
        // following non-digit non-whitespace char means a real boundary.
        if (next === '') {
          return -1
        }
      }

      // Split just past the punctuation so it stays with the chunk.
      return i + 1
    }

    return -1
  }

  /**
   * Find a split point after the WORD_BATCH_SIZE-th word, or -1.
   *
   * Counts whitespace-delimited words and splits at the whitespace
   * following the 6th word. A trailing partial word is not counted, so
   * we never flush mid-word just to hit the limit.
   */
  private findWordCountSplit(text: string): number {
    let wordCount = 0
    let inWord = false

    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      const isSpace = char !== undefined && /\s/.test(char)
      if (!isSpace) {
        inWord = true
        continue
      }

      if (inWord) {
        wordCount++
        inWord = false
        if (wordCount === WORD_BATCH_SIZE) {
          // Split at the end of this whitespace run so the 7th word
          // starts the next chunk. Advance past consecutive whitespace.
          let j = i
          while (j < text.length) {
            const jc = text[j]
            if (jc === undefined || !/\s/.test(jc)) break
            j++
          }
          return j
        }
      }
    }

    return -1
  }
}
