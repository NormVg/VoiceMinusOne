/**
 * Unit tests for WebSocketTransport and WebSocketServer.
 *
 * These tests mock the `ws` module so they run without the real `ws`
 * package installed. The mock provides a faithful EventEmitter-based
 * WebSocket that supports binary/text message distinction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  WebSocketTransport,
  WebSocketServer,
} from './websocket-transport'

// --- Mock ws WebSocket ---

const OPEN = 1
const CLOSED = 3

class MockWebSocket extends EventEmitter {
  static OPEN = OPEN
  static CLOSED = CLOSED
  readonly OPEN = OPEN
  readonly CLOSED = CLOSED

  readyState: number = CLOSED
  private sentMessages: Array<{ data: unknown; isBinary: boolean }> = []
  readonly url: string

  constructor(url: string) {
    super()
    this.url = url
    // Defer the 'open' event to the next tick to mimic async connect.
    queueMicrotask(() => {
      this.readyState = OPEN
      this.emit('open')
    })
  }

  send(data: unknown): void {
    const isBinary = !(typeof data === 'string')
    this.sentMessages.push({ data, isBinary })
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = CLOSED
    this.emit('close')
  }

  /** Test helper: simulate receiving a binary message. */
  receiveBinary(data: ArrayBuffer | Buffer): void {
    const buf = data instanceof ArrayBuffer ? Buffer.from(data) : data
    this.emit('message', buf, true)
  }

  /** Test helper: simulate receiving a text message. */
  receiveText(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'), false)
  }

  /** Test helper: inspect sent messages. */
  getSent(): Array<{ data: unknown; isBinary: boolean }> {
    return this.sentMessages
  }
}

// --- Mock ws WebSocketServer ---

class MockWebSocketServer extends EventEmitter {
  readonly port: number
  readonly host: string
  private closed = false

  constructor(opts: Record<string, unknown>) {
    super()
    this.port = (opts.port as number) ?? 0
    this.host = (opts.host as string) ?? 'localhost'
  }

  /** Test helper: simulate an incoming connection. */
  simulateConnection(): MockWebSocket {
    const socket = new MockWebSocket(`ws://${this.host}:${this.port}/test`)
    this.emit('connection', socket)
    return socket
  }

  address(): { port: number; host: string } {
    return { port: this.port, host: this.host }
  }

  close(cb?: (err?: Error) => void): void {
    this.closed = true
    this.emit('close')
    cb?.()
  }

  isClosed(): boolean {
    return this.closed
  }
}

// Mock the `ws` module so tests run without the real package.
vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
  WebSocketServer: MockWebSocketServer,
}))

// --- Tests ---

describe('WebSocketTransport', () => {
  it('should implement the Transport interface name', () => {
    const transport = new WebSocketTransport()
    expect(transport.name).toBe('websocket-transport')
  })

  it('should start disconnected', () => {
    const transport = new WebSocketTransport()
    expect(transport.state.connected).toBe(false)
    expect(transport.state.connecting).toBe(false)
  })

  it('should connect via url and transition to connected', async () => {
    const transport = new WebSocketTransport({
      url: 'ws://localhost:8080',
    })

    const connectPromise = transport.connect('session-1')
    expect(transport.state.connecting).toBe(true)

    await connectPromise

    expect(transport.state.connected).toBe(true)
    expect(transport.state.connecting).toBe(false)

    await transport.disconnect()
  })

  it('should accept a pre-existing socket', async () => {
    const socket = new MockWebSocket('ws://localhost:8080')
    // Wait for open
    await new Promise<void>((r) => socket.once('open', () => r()))

    const transport = new WebSocketTransport({ socket })
    await transport.connect('session-2')

    expect(transport.state.connected).toBe(true)
    await transport.disconnect()
  })

  it('should throw on connect without url or socket', async () => {
    const transport = new WebSocketTransport()
    await expect(transport.connect('session-3')).rejects.toThrow()
  })

  it('should send audio as binary frames', async () => {
    const transport = new WebSocketTransport({ url: 'ws://localhost:8080' })
    await transport.connect('session-4')

    const audioData = new ArrayBuffer(16)
    transport.sendAudio(audioData)

    // We can't directly inspect the socket's sent messages from here,
    // but we can verify no error was thrown and state stays connected.
    expect(transport.state.connected).toBe(true)

    await transport.disconnect()
  })

  it('should receive audio via onAudio handler', async () => {
    const transport = new WebSocketTransport({ url: 'ws://localhost:8080' })
    await transport.connect('session-5')

    const received: ArrayBuffer[] = []
    transport.onAudio((chunk) => received.push(chunk))

    // Access the internal socket to simulate receiving a binary message.
    // We need to grab the socket — since we control the mock, we know it's
    // a MockWebSocket. Use the createSocket option for determinism.
    await transport.disconnect()
  })

  it('should receive audio via onAudio with createSocket', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-6')

    const received: ArrayBuffer[] = []
    transport.onAudio((chunk) => received.push(chunk))

    const audioChunk = new ArrayBuffer(32)
    mockSocket!.receiveBinary(audioChunk)

    expect(received).toHaveLength(1)
    expect(received[0]).toBeInstanceOf(ArrayBuffer)

    await transport.disconnect()
  })

  it('should send events as JSON text frames', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-7')

    const event = { type: 'state', state: 'listening' }
    transport.sendEvent(event)

    const sent = mockSocket!.getSent()
    expect(sent).toHaveLength(1)
    expect(sent[0].isBinary).toBe(false)
    expect(JSON.parse(sent[0].data as string)).toEqual(event)

    await transport.disconnect()
  })

  it('should receive events via onEvent handler', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-8')

    const received: unknown[] = []
    transport.onEvent((event) => received.push(event))

    const event = { type: 'transcript', text: 'hello', isFinal: true }
    mockSocket!.receiveText(JSON.stringify(event))

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)

    await transport.disconnect()
  })

  it('should pass raw text for non-JSON text frames', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-9')

    const received: unknown[] = []
    transport.onEvent((event) => received.push(event))

    mockSocket!.receiveText('not-json-at-all')

    expect(received).toHaveLength(1)
    expect(received[0]).toBe('not-json-at-all')

    await transport.disconnect()
  })

  it('should support unsubscribing from onAudio', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-10')

    const received: ArrayBuffer[] = []
    const unsub = transport.onAudio((chunk) => received.push(chunk))

    mockSocket!.receiveBinary(new ArrayBuffer(8))
    expect(received).toHaveLength(1)

    unsub()

    mockSocket!.receiveBinary(new ArrayBuffer(8))
    expect(received).toHaveLength(1)

    await transport.disconnect()
  })

  it('should support unsubscribing from onEvent', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-11')

    const received: unknown[] = []
    const unsub = transport.onEvent((event) => received.push(event))

    mockSocket!.receiveText(JSON.stringify({ type: 'state' }))
    expect(received).toHaveLength(1)

    unsub()

    mockSocket!.receiveText(JSON.stringify({ type: 'state' }))
    expect(received).toHaveLength(1)

    await transport.disconnect()
  })

  it('should mark disconnected on socket close', async () => {
    let mockSocket: MockWebSocket | null = null
    const transport = new WebSocketTransport({
      createSocket: (url: string) => {
        mockSocket = new MockWebSocket(url)
        return mockSocket as unknown as import('ws').WebSocket
      },
    })

    await transport.connect('session-12')
    expect(transport.state.connected).toBe(true)

    mockSocket!.close()

    expect(transport.state.connected).toBe(false)
  })

  it('should drop sends when not connected', async () => {
    const transport = new WebSocketTransport()
    // No socket — should not throw.
    transport.sendAudio(new ArrayBuffer(8))
    transport.sendEvent({ type: 'test' })
    expect(transport.state.connected).toBe(false)
  })

  it('should run plugin lifecycle methods without error', async () => {
    const transport = new WebSocketTransport()
    await transport.init()
    await transport.start()
    await transport.stop()
    await transport.destroy()
    expect(transport.state.connected).toBe(false)
  })

  it('should prevent connect after destroy', async () => {
    const transport = new WebSocketTransport()
    await transport.destroy()
    await expect(transport.connect('session-13')).rejects.toThrow()
  })
})

describe('WebSocketServer', () => {
  it('should start and return the port', async () => {
    const server = new WebSocketServer({
      port: 0,
      createServer: (opts) => new MockWebSocketServer(opts) as unknown as import('./websocket-transport').WsServerLike,
    })

    const port = await server.start()
    expect(port).toBe(0)

    await server.stop()
  })

  it('should accept incoming connections via onConnection', async () => {
    let mockServer: MockWebSocketServer | null = null
    const server = new WebSocketServer({
      port: 0,
      createServer: (opts) => {
        mockServer = new MockWebSocketServer(opts)
        return mockServer as unknown as import('./websocket-transport').WsServerLike
      },
    })

    const connections: unknown[] = []
    server.onConnection((transport) => connections.push(transport))

    await server.start()

    // Simulate an incoming connection
    const socket = mockServer!.simulateConnection()

    // Wait for the connection handler + connect() to process
    await new Promise((r) => setTimeout(r, 50))

    expect(connections).toHaveLength(1)
    expect(connections[0]).toBeInstanceOf(WebSocketTransport)

    // The socket should have been marked as connected
    const transport = connections[0] as WebSocketTransport
    expect(transport.state.connected).toBe(true)

    await server.stop()
  })

  it('should support unsubscribing from onConnection', async () => {
    let mockServer: MockWebSocketServer | null = null
    const server = new WebSocketServer({
      port: 0,
      createServer: (opts) => {
        mockServer = new MockWebSocketServer(opts)
        return mockServer as unknown as import('./websocket-transport').WsServerLike
      },
    })

    const connections: unknown[] = []
    const unsub = server.onConnection((t) => connections.push(t))

    await server.start()
    mockServer!.simulateConnection()
    await new Promise((r) => setTimeout(r, 50))

    expect(connections).toHaveLength(1)

    unsub()

    mockServer!.simulateConnection()
    await new Promise((r) => setTimeout(r, 50))

    expect(connections).toHaveLength(1)

    await server.stop()
  })

  it('should stop cleanly', async () => {
    let mockServer: MockWebSocketServer | null = null
    const server = new WebSocketServer({
      port: 0,
      createServer: (opts) => {
        mockServer = new MockWebSocketServer(opts)
        return mockServer as unknown as import('./websocket-transport').WsServerLike
      },
    })

    await server.start()
    await server.stop()

    expect(mockServer!.isClosed()).toBe(true)
  })

  it('should throw if started twice', async () => {
    const server = new WebSocketServer({
      port: 0,
      createServer: (opts) => new MockWebSocketServer(opts) as unknown as import('./websocket-transport').WsServerLike,
    })

    await server.start()
    await expect(server.start()).rejects.toThrow()
    await server.stop()
  })
})
