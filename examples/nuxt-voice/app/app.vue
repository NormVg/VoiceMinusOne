<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { VoiceMinusOneClient } from '@voiceminusone/client'

const connectionState = ref('Disconnected')
const transcriptText = ref('')
const botText = ref('')
const micEnabled = ref(false)
let client: VoiceMinusOneClient | null = null

onMounted(() => {
  if (!import.meta.client) return
  client = new VoiceMinusOneClient({ url: 'ws://localhost:3001' })
  // Expose for browser testing
  ;(window as any).__voiceClient = client
  client.onStateChange((state) => {
    if (state.connecting) connectionState.value = 'Connecting...'
    else if (state.connected) connectionState.value = 'Connected'
    else connectionState.value = 'Disconnected'
    micEnabled.value = state.connected
  })
  client.onTranscript((text) => { transcriptText.value = text })
  client.onBotText((text) => { botText.value += text })
})

async function connect() {
  if (!client) return
  try {
    await client.connect()
    // Expose the WebSocket for test verification
    ;(window as any).__ws = (client as any).ws
  } catch (e) { console.error('Connect failed:', e) }
}
</script>

<template>
  <div>
    <h1>VoiceMinusOne Example</h1>
    <div id="connection-state">{{ connectionState }}</div>
    <button id="connect-btn" @click="connect" :disabled="connectionState === 'Connected' || connectionState === 'Connecting...'">Connect</button>
    <button id="mic-btn" :disabled="!micEnabled">Toggle Mic</button>
    <h2>Transcript</h2>
    <div id="transcript">{{ transcriptText }}</div>
    <h2>Bot Response</h2>
    <div id="bot-text">{{ botText }}</div>
  </div>
</template>
