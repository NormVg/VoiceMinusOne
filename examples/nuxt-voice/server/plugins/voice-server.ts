import { WebSocketServer, SessionManager } from '@voiceminusone/server'
import type {
  PluginContext,
} from '@voiceminusone/core'
import { SarvamSTT, SarvamTTS } from '@voiceminusone/provider-sarvam'
import { aiSdkBrain } from '@voiceminusone/adapter-ai-sdk'
import { ollama } from 'ai-sdk-ollama'

// --- Real providers ---

const SARVAM_API_KEY = process.env.SARVAM_API_KEY!
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY!
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:31b-cloud'

// The ai-sdk-ollama package reads OLLAMA_API_KEY from process.env
// to authenticate with ollama.com cloud.
process.env.OLLAMA_API_KEY = OLLAMA_API_KEY

function createSTT() {
  return new SarvamSTT({
    apiKey: SARVAM_API_KEY,
    language: 'en-IN',
    model: 'saaras:v3',
    streaming: true,
  })
}

function createTTS() {
  return new SarvamTTS({
    apiKey: SARVAM_API_KEY,
    speaker: 'shubh',
    language: 'en-IN',
    model: 'bulbul:v3',
    sampleRate: 22050,
  })
}

function createBrain() {
  const model = ollama(OLLAMA_MODEL)
  return aiSdkBrain({
    model,
    systemPrompt:
      'You are a helpful voice assistant. Keep responses concise and conversational. Never use markdown.',
    temperature: 0.7,
  })
}

// --- Nuxt server plugin ---

export default defineNitroPlugin((nitroApp) => {
  const wsServer = new WebSocketServer({ port: 3001, host: '0.0.0.0' })

  wsServer.onConnection((transport) => {
    const session = new SessionManager({
      transport,
      stt: createSTT(),
      tts: createTTS(),
      brain: createBrain(),
      sampleRate: 16000,
    })

    session.start().catch((err) => {
      console.error('Session start failed:', err)
    })
  })

  wsServer
    .start()
    .then((port) => {
      console.log(`VoiceMinusOne WebSocket server listening on port ${port}`)
    })
    .catch((err) => {
      console.error('WebSocket server failed to start:', err)
    })

  nitroApp.hooks.hook('close', async () => {
    await wsServer.stop()
  })
})
