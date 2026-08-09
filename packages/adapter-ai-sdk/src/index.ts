/**
 * AI SDK 7 Brain adapter for VoiceMinusOne.
 *
 * Adapts the Vercel AI SDK's `streamText` to the VoiceMinusOne `Brain` interface.
 * Works with any AI SDK-compatible model (OpenAI, Anthropic, Google, Mistral, etc.).
 *
 * @example
 * ```typescript
 * import { aiSdkBrain } from '@voiceminusone/adapter-ai-sdk'
 * import { openai } from '@ai-sdk/openai'
 *
 * const brain = aiSdkBrain({
 *   model: openai('gpt-4o'),
 *   systemPrompt: 'You are a helpful voice assistant.',
 * })
 * ```
 */

import type { Brain, BrainContext, ConversationMessage } from '@voiceminusone/core'

/**
 * Minimal type shim for the AI SDK LanguageModel.
 * We don't depend on `ai` directly — the user passes the model from their app.
 * This keeps the adapter zero-dependency and compatible with any AI SDK version.
 */
export interface LanguageModelLike {
  readonly specificationVersion: string
  readonly provider: string
  readonly modelId: string
}

/**
 * Minimal type shim for AI SDK's streamText options.
 * The adapter calls streamText with these fields.
 */
export interface StreamTextOptionsLike {
  model: LanguageModelLike
  system?: string | undefined
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
  }>
  temperature?: number | undefined
  maxTokens?: number | undefined
  abortSignal?: AbortSignal | undefined
}

/**
 * Minimal type shim for AI SDK's streamText result.
 * We only need the textStream.
 */
export interface StreamTextResultLike {
  readonly textStream: AsyncIterable<string>
  readonly text: Promise<string>
}

/**
 * A function that calls the AI SDK's streamText.
 * The user can pass their own wrapper or we use the default import.
 */
export type StreamTextCaller = (options: StreamTextOptionsLike) => StreamTextResultLike

export interface AiSdkBrainOptions {
  /** The AI SDK model to use (e.g. `openai('gpt-4o')`). */
  model: LanguageModelLike
  /** System prompt for the assistant. */
  systemPrompt?: string
  /** Temperature for generation (default: 0.7). */
  temperature?: number
  /** Max tokens to generate (default: model default). */
  maxTokens?: number
  /**
   * Custom streamText function. If not provided, the adapter will try to
   * dynamically import `streamText` from the `ai` package.
   */
  streamText?: StreamTextCaller
}

/**
 * Create a Brain from an AI SDK model.
 *
 * The Brain streams text tokens as an async generator, which the
 * SessionManager pipes to TTS for low-latency voice output.
 *
 * @example
 * ```typescript
 * import { aiSdkBrain } from '@voiceminusone/adapter-ai-sdk'
 * import { openai } from '@ai-sdk/openai'
 *
 * const brain = aiSdkBrain({
 *   model: openai('gpt-4o'),
 *   systemPrompt: 'You are a helpful voice assistant. Keep responses concise.',
 * })
 * ```
 */
export function aiSdkBrain(options: AiSdkBrainOptions): Brain {
  return async function* (userText: string, context: BrainContext): AsyncGenerator<string, void, unknown> {
    const streamText = options.streamText ?? (await loadStreamText())

    const messages = buildMessages(userText, context.history, options.systemPrompt)

    const result = streamText({
      model: options.model,
      system: options.systemPrompt,
      messages,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      abortSignal: context.signal,
    })

    for await (const textPart of result.textStream) {
      if (context.signal.aborted) break
      yield textPart
    }
  }
}

/**
 * Create a Brain that returns a complete string (non-streaming).
 * Useful for models that don't support streaming or for testing.
 */
export function aiSdkBrainComplete(options: AiSdkBrainOptions): Brain {
  return async (userText: string, context: BrainContext): Promise<string> => {
    const streamText = options.streamText ?? (await loadStreamText())

    const messages = buildMessages(userText, context.history, options.systemPrompt)

    const result = streamText({
      model: options.model,
      system: options.systemPrompt,
      messages,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      abortSignal: context.signal,
    })

    return result.text
  }
}

/** Build the messages array from history + current user text. */
function buildMessages(
  userText: string,
  history: ConversationMessage[],
  systemPrompt?: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

  // Add system prompt if not already in history
  if (systemPrompt) {
    const hasSystemInHistory = history.some((m) => m.role === 'system')
    if (!hasSystemInHistory) {
      messages.push({ role: 'system', content: systemPrompt })
    }
  }

  // Add history (skip system messages if we already added one)
  for (const msg of history) {
    if (msg.role === 'system' && systemPrompt) continue
    messages.push({ role: msg.role, content: msg.content })
  }

  // Add current user message
  messages.push({ role: 'user', content: userText })

  return messages
}

/** Dynamically load streamText from the `ai` package. */
async function loadStreamText(): Promise<StreamTextCaller> {
  try {
    const aiModule = (await import('ai')) as unknown as { streamText?: StreamTextCaller }
    if (!aiModule.streamText) {
      throw new Error('streamText not found in `ai` package')
    }
    return aiModule.streamText
  } catch (err) {
    throw new Error(
      `Failed to load AI SDK. Install the \`ai\` package or pass streamText explicitly: ${(err as Error).message}`,
    )
  }
}
