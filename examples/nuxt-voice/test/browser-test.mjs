/**
 * Browser automation test for the VoiceMinusOne Nuxt example.
 *
 * Launches the Nuxt preview server, opens it in a headless browser,
 * verifies the page loads, clicks Connect, verifies the WebSocket
 * connection is established, and exits 0.
 *
 * Uses Puppeteer (installed via pnpm).
 *
 * Usage: node test/browser-test.mjs
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// --- Configuration ---
const PREVIEW_PORT = 3000
const WS_PORT = 3001
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`
const TIMEOUT_MS = 30000

// --- Helper: sleep ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Main ---
async function main() {
  let puppeteer
  try {
    puppeteer = require('puppeteer')
  } catch {
    console.error('Puppeteer not found. Install it with: pnpm add -D puppeteer')
    process.exit(1)
  }

  // Start the Nuxt preview server
  console.log('Starting Nuxt preview server...')
  const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PREVIEW_PORT), HOST: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let serverOutput = ''
  server.stdout.on('data', (d) => {
    serverOutput += d.toString()
    process.stdout.write(`[server] ${d}`)
  })
  server.stderr.on('data', (d) => {
    serverOutput += d.toString()
    process.stderr.write(`[server] ${d}`)
  })

  // Wait for server to be ready
  console.log('Waiting for server to start...')
  let serverReady = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    try {
      const res = await fetch(PREVIEW_URL)
      if (res.ok) {
        serverReady = true
        console.log('Server is ready!')
        break
      }
    } catch {
      // Server not ready yet
    }
  }

  if (!serverReady) {
    console.error('Server failed to start within 15 seconds')
    server.kill('SIGKILL')
    process.exit(1)
  }

  // Launch headless browser
  console.log('Launching headless browser...')
  let browser
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
  } catch (err) {
    console.error('Failed to launch browser:', err.message)
    server.kill('SIGKILL')
    process.exit(1)
  }

  let exitCode = 1

  try {
    const page = await browser.newPage()

    // Collect console logs
    page.on('console', (msg) => {
      console.log(`[browser console.${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => {
      console.error(`[browser error] ${err.message}`)
    })

    // Navigate to the page
    console.log('Navigating to', PREVIEW_URL)
    await page.goto(PREVIEW_URL, { waitUntil: 'networkidle0', timeout: TIMEOUT_MS })

    // Verify page loaded
    const title = await page.$eval('h1', (el) => el.textContent)
    if (title !== 'VoiceMinusOne Example') {
      throw new Error(`Page title mismatch: expected "VoiceMinusOne Example", got "${title}"`)
    }
    console.log('✓ Page loaded with correct title')

    // Verify connection state shows "Disconnected"
    const initialState = await page.$eval('#connection-state', (el) => el.textContent)
    if (initialState !== 'Disconnected') {
      throw new Error(`Initial state should be "Disconnected", got "${initialState}"`)
    }
    console.log('✓ Initial connection state is "Disconnected"')

    // Click the Connect button
    console.log('Clicking Connect button...')
    await page.click('#connect-btn')

    // Wait for connection state to change to "Connected"
    console.log('Waiting for WebSocket connection...')
    let connected = false
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const state = await page.$eval('#connection-state', (el) => el.textContent)
      if (state === 'Connected') {
        connected = true
        break
      }
    }

    if (!connected) {
      throw new Error('WebSocket did not connect within 10 seconds')
    }
    console.log('✓ WebSocket connection established!')

    // Verify the WebSocket object exists on window
    const wsExists = await page.evaluate(() => {
      return typeof window.__ws !== 'undefined' && window.__ws.readyState === 1
    })
    if (!wsExists) {
      throw new Error('WebSocket object not found on window or not in OPEN state')
    }
    console.log('✓ WebSocket is in OPEN state (readyState=1)')

    // Verify the voice client exists
    const clientExists = await page.evaluate(() => {
      return typeof window.__voiceClient !== 'undefined'
    })
    if (!clientExists) {
      throw new Error('VoiceMinusOneClient not found on window')
    }
    console.log('✓ VoiceMinusOneClient is available on window')

    console.log('\n✅ All browser tests passed!')
    exitCode = 0
  } catch (err) {
    console.error('\n❌ Browser test failed:', err.message)
    exitCode = 1
  } finally {
    // Clean up
    if (browser) {
      await browser.close()
      console.log('Browser closed.')
    }
    server.kill('SIGKILL')
    console.log('Server stopped.')
  }

  process.exit(exitCode)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
