<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import { VoiceMinusOneClient, type TurnStats } from '@voiceminusone/client'

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
const showStats = ref(true)

// Stats state
const latestStats = ref<TurnStats | null>(null)
const statsHistory = ref<TurnStats[]>([])

let client: VoiceMinusOneClient | null = null
let msgId = 0
let currentBotMsg: ChatMessage | null = null

// Computed averages from history
const avgStats = computed(() => {
  if (statsHistory.value.length === 0) return null
  const n = statsHistory.value.length
  const sum = statsHistory.value.reduce(
    (acc, s) => ({
      sttMs: acc.sttMs + s.sttMs,
      brainMs: acc.brainMs + s.brainMs,
      firstAudioMs: acc.firstAudioMs + s.firstAudioMs,
      ttsMs: acc.ttsMs + s.ttsMs,
      totalMs: acc.totalMs + s.totalMs,
      e2eLatencyMs: acc.e2eLatencyMs + (s.e2eLatencyMs ?? 0),
      e2eCount: acc.e2eCount + (s.e2eLatencyMs != null ? 1 : 0),
    }),
    { sttMs: 0, brainMs: 0, firstAudioMs: 0, ttsMs: 0, totalMs: 0, e2eLatencyMs: 0, e2eCount: 0 },
  )
  return {
    sttMs: Math.round(sum.sttMs / n),
    brainMs: Math.round(sum.brainMs / n),
    firstAudioMs: Math.round(sum.firstAudioMs / n),
    ttsMs: Math.round(sum.ttsMs / n),
    totalMs: Math.round(sum.totalMs / n),
    e2eLatencyMs: sum.e2eCount > 0 ? Math.round(sum.e2eLatencyMs / sum.e2eCount) : null,
    count: n,
  }
})

const connectionStateClass = computed(() => {
  if (connectionState.value === 'Connected') return 'connected'
  if (connectionState.value === 'Connecting...') return 'connecting'
  return 'disconnected'
})

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

  client.onTurnStats((stats) => {
    latestStats.value = stats
    statsHistory.value.push(stats)
    // Keep last 20 turns
    if (statsHistory.value.length > 20) {
      statsHistory.value = statsHistory.value.slice(-20)
    }
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

function clearStats() {
  statsHistory.value = []
  latestStats.value = null
}

function latencyColor(ms: number): string {
  if (ms < 500) return '#4CAF50'
  if (ms < 1500) return '#FF9800'
  return '#f44336'
}
</script>

<template>
  <div class="app">
    <div class="header">
      <h1>VoiceMinusOne</h1>
      <div class="status">
        <span class="status-dot" :class="connectionStateClass" />
        <span>{{ connectionState }}</span>
        <span v-if="isProcessing" class="processing">thinking...</span>
      </div>
    </div>

    <div v-if="errorText" class="error">{{ errorText }}</div>

    <!-- Stats Panel -->
    <div v-if="showStats && mounted" class="stats-panel">
      <div class="stats-header">
        <span class="stats-title">Latency Stats</span>
        <div class="stats-actions">
          <span v-if="avgStats" class="stats-count">{{ avgStats.count }} turns</span>
          <button class="stats-toggle" @click="showStats = false">hide</button>
        </div>
      </div>

      <!-- Latest turn -->
      <div v-if="latestStats" class="stats-grid">
        <div class="stat-cell">
          <span class="stat-label">E2E</span>
          <span class="stat-value" :style="{ color: latencyColor(latestStats.e2eLatencyMs ?? latestStats.firstAudioMs) }">
            {{ latestStats.e2eLatencyMs != null ? latestStats.e2eLatencyMs + 'ms' : '—' }}
          </span>
          <span class="stat-sub">client measured</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">First Audio</span>
          <span class="stat-value" :style="{ color: latencyColor(latestStats.firstAudioMs) }">
            {{ latestStats.firstAudioMs }}ms
          </span>
          <span class="stat-sub">server TTFB</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">STT</span>
          <span class="stat-value" :style="{ color: latencyColor(latestStats.sttMs) }">
            {{ latestStats.sttMs }}ms
          </span>
          <span class="stat-sub">speech→text</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">LLM</span>
          <span class="stat-value" :style="{ color: latencyColor(latestStats.brainMs) }">
            {{ latestStats.brainMs }}ms
          </span>
          <span class="stat-sub">brain</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">TTS</span>
          <span class="stat-value" :style="{ color: latencyColor(latestStats.ttsMs) }">
            {{ latestStats.ttsMs }}ms
          </span>
          <span class="stat-sub">synthesis</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Total</span>
          <span class="stat-value" :style="{ color: latencyColor(latestStats.totalMs) }">
            {{ latestStats.totalMs }}ms
          </span>
          <span class="stat-sub">turn wall</span>
        </div>
      </div>

      <!-- Averages -->
      <div v-if="avgStats" class="stats-averages">
        <span class="avg-label">Avg ({{ avgStats.count }} turns):</span>
        <span class="avg-item">E2E <b :style="{ color: latencyColor(avgStats.e2eLatencyMs ?? 9999) }">{{ avgStats.e2eLatencyMs ?? '—' }}ms</b></span>
        <span class="avg-item">1st Aud <b :style="{ color: latencyColor(avgStats.firstAudioMs) }">{{ avgStats.firstAudioMs }}ms</b></span>
        <span class="avg-item">STT <b :style="{ color: latencyColor(avgStats.sttMs) }">{{ avgStats.sttMs }}ms</b></span>
        <span class="avg-item">LLM <b :style="{ color: latencyColor(avgStats.brainMs) }">{{ avgStats.brainMs }}ms</b></span>
        <span class="avg-item">TTS <b :style="{ color: latencyColor(avgStats.ttsMs) }">{{ avgStats.ttsMs }}ms</b></span>
        <span class="avg-item">Total <b :style="{ color: latencyColor(avgStats.totalMs) }">{{ avgStats.totalMs }}ms</b></span>
        <button class="stats-clear" @click="clearStats">clear</button>
      </div>

      <!-- Sparkline history -->
      <div v-if="statsHistory.length > 1" class="stats-sparkline">
        <span class="spark-label">E2E trend</span>
        <div class="spark-bars">
          <div
            v-for="s in statsHistory"
            :key="s.turnId"
            class="spark-bar"
            :style="{
              height: Math.min(100, ((s.e2eLatencyMs ?? s.firstAudioMs) / Math.max(...statsHistory.map(x => x.e2eLatencyMs ?? x.firstAudioMs))) * 100) + '%',
              background: latencyColor(s.e2eLatencyMs ?? s.firstAudioMs),
            }"
            :title="`Turn ${s.turnId}: ${s.e2eLatencyMs ?? s.firstAudioMs}ms`"
          />
        </div>
      </div>

      <div v-if="!latestStats" class="stats-empty">
        No turns yet. Connect and talk to see latency stats.
      </div>
    </div>
    <div v-else-if="mounted" class="stats-collapsed">
      <button class="stats-toggle" @click="showStats = true">show stats</button>
    </div>

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
.status-dot.connecting { background: #FF9800; }
.processing { color: #FF9800; font-style: italic; }

.error {
  padding: 0.5rem 1rem;
  background: #ffebee;
  color: #c62828;
  font-size: 0.85rem;
}

/* Stats Panel */
.stats-panel {
  border-bottom: 1px solid #e5e5e5;
  background: #fafafa;
  padding: 0.6rem 1rem;
}
.stats-collapsed {
  border-bottom: 1px solid #e5e5e5;
  padding: 0.4rem 1rem;
  background: #fafafa;
}
.stats-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
.stats-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #999; }
.stats-actions { display: flex; align-items: center; gap: 0.5rem; }
.stats-count { font-size: 0.7rem; color: #aaa; }
.stats-toggle {
  background: none; border: 1px solid #ddd; border-radius: 4px;
  padding: 0.15rem 0.5rem; font-size: 0.7rem; color: #888; cursor: pointer;
}
.stats-toggle:hover { background: #eee; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.stat-label { font-size: 0.65rem; color: #999; text-transform: uppercase; letter-spacing: 0.03em; }
.stat-value { font-size: 0.85rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat-sub { font-size: 0.6rem; color: #bbb; }

.stats-averages {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid #eee;
  font-size: 0.7rem;
  color: #888;
}
.avg-label { font-weight: 600; }
.avg-item { font-variant-numeric: tabular-nums; }
.avg-item b { font-weight: 700; }
.stats-clear {
  margin-left: auto;
  background: none; border: 1px solid #ddd; border-radius: 4px;
  padding: 0.1rem 0.4rem; font-size: 0.65rem; color: #888; cursor: pointer;
}
.stats-clear:hover { background: #eee; }

.stats-sparkline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid #eee;
}
.spark-label { font-size: 0.65rem; color: #aaa; white-space: nowrap; }
.spark-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 24px;
  flex: 1;
}
.spark-bar {
  flex: 1;
  min-width: 4px;
  border-radius: 2px 2px 0 0;
  transition: height 0.2s;
}

.stats-empty {
  font-size: 0.75rem;
  color: #bbb;
  text-align: center;
  padding: 0.5rem;
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
