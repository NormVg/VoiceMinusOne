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

import { PluginError } from '@voiceminusone/core'
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
  /** System prompt. AI SDK v7 renamed this to `instructions`. */
  system?: string | undefined
  /** System prompt (AI SDK v7+). */
  instructions?: string | undefined
  messages?: Array<{
    role: 'user' | 'assistant' | 'tool'
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

    const messages = buildMessages(userText, context.history)

    let result: StreamTextResultLike
    try {
      result = streamText({
        model: options.model,
        instructions: options.systemPrompt,
        messages,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens,
        abortSignal: context.signal,
      })
    } catch (err) {
      throw err
    }

    // Consume the textStream — errors from the HTTP request surface here
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

    const messages = buildMessages(userText, context.history)

    const result = streamText({
      model: options.model,
      instructions: options.systemPrompt,
      messages,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      abortSignal: context.signal,
    })

    return result.text
  }
}

/** Build the messages array from history + current user text.
 *
 *  Per AI SDK v7: system messages are NOT allowed in the messages array.
 *  System prompts must be passed via the `instructions` option instead.
 *  This function filters out any system messages from history.
 */
function buildMessages(
  userText: string,
  history: ConversationMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  // Add history (skip system messages — they go via `instructions`)
  for (const msg of history) {
    if (msg.role === 'system') continue
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
      throw new PluginError('LLM_FAILED', 'streamText not found in the `ai` package')
    }
    return aiModule.streamText
  } catch (err) {
      throw new PluginError(
        'LLM_FAILED',
        `Failed to load AI SDK. Install the \`ai\` package or pass streamText explicitly: ${(err as Error).message}`,
      )
  }
}
