<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue'
import { VoiceMinusOneClient } from '@voiceminusone/client'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

const messages = ref<ChatMessage[]>([])
const connectionState = ref('Disconnected')
const micEnabled = ref(false)
const micActive = ref(false)
const errorText = ref('')
const mounted = ref(false)
const isProcessing = ref(false)
const chatContainer = ref<HTMLElement | null>(null)

let client: VoiceMinusOneClient | null = null
let msgId = 0
let currentBotMsg: ChatMessage | null = null

onMounted(() => {
  mounted.value = true
  if (!import.meta.client) return
  client = new VoiceMinusOneClient({ url: 'ws://localhost:3001' })
  ;(window as any).__voiceClient = client

  client.onStateChange((state) => {
    if (state.connecting) connectionState.value = 'Connecting...'
    else if (state.connected) connectionState.value = 'Connected'
    else connectionState.value = 'Disconnected'
    micEnabled.value = state.connected
    if (state.error) errorText.value = state.error
  })

  client.onTranscript((text) => {
    // Add user message when we get a transcript
    messages.value.push({
      id: ++msgId,
      role: 'user',
      text,
      timestamp: Date.now(),
    })
    isProcessing.value = true
    scrollToBottom()
  })

  client.onBotText((text) => {
    // Accumulate bot text into the current bot message
    if (!currentBotMsg) {
      currentBotMsg = {
        id: ++msgId,
        role: 'assistant',
        text: '',
        timestamp: Date.now(),
      }
      messages.value.push(currentBotMsg)
    }
    currentBotMsg.text += text
    scrollToBottom()
  })

  client.onBotTextDone(() => {
    currentBotMsg = null
    isProcessing.value = false
  })
})

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

async function connect() {
  if (!client) return
  try {
    await client.connect()
    ;(window as any).__ws = (client as any).ws
  } catch (e) {
    errorText.value = `Connect failed: ${(e as Error).message}`
  }
}

async function toggleMic() {
  if (!client) return
  if (micActive.value) {
    client.stopMic()
    micActive.value = false
  } else {
    try {
      await client.startMic()
      micActive.value = true
    } catch (e) {
      errorText.value = `Mic error: ${(e as Error).message}`
    }
  }
}
</script>

<template>
  <div class="app">
    <div class="header">
      <h1>VoiceMinusOne</h1>
      <div class="status">
        <span class="status-dot" :class="connectionState.toLowerCase()" />
        <span>{{ connectionState }}</span>
        <span v-if="isProcessing" class="processing">thinking...</span>
      </div>
    </div>

    <div v-if="errorText" class="error">{{ errorText }}</div>

    <div class="chat-container" ref="chatContainer">
      <div v-if="messages.length === 0" class="empty-state">
        <p>Click Connect, then Start Mic to begin talking.</p>
        <p class="hint">The AI will respond with voice and text.</p>
      </div>
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="message"
        :class="msg.role"
      >
        <div class="bubble">{{ msg.text }}</div>
      </div>
    </div>

    <div v-if="mounted" class="controls">
      <button
        @click="connect"
        :disabled="connectionState === 'Connected' || connectionState === 'Connecting...'"
        class="btn btn-connect"
      >
        Connect
      </button>
      <button
        @click="toggleMic"
        :disabled="!micEnabled"
        class="btn"
        :class="micActive ? 'btn-mic-active' : 'btn-mic'"
      >
        {{ micActive ? 'Stop' : 'Start Mic' }}
      </button>
    </div>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: #f0f2f5; }

.app {
  max-width: 480px;
  margin: 0 auto;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e5e5e5;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header h1 { font-size: 1.1rem; font-weight: 700; color: #1a1a1a; }

.status { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: #666; }
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #ccc;
}
.status-dot.connected { background: #4CAF50; }
.status-dot.disconnected { background: #f44336; }
.status-dot.connecting... { background: #FF9800; }
.processing { color: #FF9800; font-style: italic; }

.error {
  padding: 0.5rem 1rem;
  background: #ffebee;
  color: #c62828;
  font-size: 0.85rem;
}

.chat-container {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #999;
  text-align: center;
}
.empty-state .hint { font-size: 0.85rem; margin-top: 0.5rem; }

.message { display: flex; }
.message.user { justify-content: flex-end; }
.message.assistant { justify-content: flex-start; }

.bubble {
  max-width: 75%;
  padding: 0.6rem 0.9rem;
  border-radius: 1rem;
  font-size: 0.95rem;
  line-height: 1.4;
  word-wrap: break-word;
}
.message.user .bubble {
  background: #0084ff;
  color: white;
  border-bottom-right-radius: 0.25rem;
}
.message.assistant .bubble {
  background: #f0f0f0;
  color: #1a1a1a;
  border-bottom-left-radius: 0.25rem;
}

.controls {
  padding: 0.75rem 1rem;
  border-top: 1px solid #e5e5e5;
  display: flex;
  gap: 0.5rem;
}
.btn {
  flex: 1;
  padding: 0.7rem;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  color: white;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-connect { background: #0084ff; }
.btn-mic { background: #4CAF50; }
.btn-mic-active { background: #f44336; }
</style>
