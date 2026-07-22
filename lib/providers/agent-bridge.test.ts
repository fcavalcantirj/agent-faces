import { describe, expect, it } from 'vitest'
import { createAgentBridgeAdapter } from '@/lib/providers/agent-bridge'
import { listAvailableAdapters } from '@/lib/providers'
import { AdapterError, type StreamEvent } from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// Fakes — a stand-in `fetch` so the Mode B agent-bridge adapter is fully
// unit-testable headlessly (no live agent, no network). We build real
// ReadableStream bodies for both NDJSON (Ollama) and SSE (openai-compatible /
// Hermes) transports.
// ---------------------------------------------------------------------------

/** Encode NDJSON lines into a ReadableStream<Uint8Array>. */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
      controller.close()
    },
  })
}

/** Encode an SSE transcript into a ReadableStream<Uint8Array>. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

/** Build a fake fetch that records calls and replies per URL. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  }) as unknown as typeof fetch
  return { fn, calls }
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// ---------------------------------------------------------------------------
// Availability — pure env gating (localhost dev vs Vercel prod vs self-host)
// ---------------------------------------------------------------------------

describe('agent-bridge adapter — availability & env gating', () => {
  it('is unavailable with no configuration', () => {
    const adapter = createAgentBridgeAdapter()
    expect(adapter.available({})).toBe(false)
    expect(adapter.id).toBe('agent-bridge')
    expect(adapter.mode).toBe('B')
  })

  it('is available on localhost dev when a kind + URL are set', () => {
    const adapter = createAgentBridgeAdapter()
    expect(
      adapter.available({ AGENT_BRIDGE_KIND: 'ollama', AGENT_BRIDGE_URL: 'http://localhost:11434' }),
    ).toBe(true)
  })

  it('defaults the Ollama URL so kind alone is enough on localhost', () => {
    const adapter = createAgentBridgeAdapter()
    expect(adapter.available({ AGENT_BRIDGE_KIND: 'ollama' })).toBe(true)
  })

  it('treats HERMES_API_BASE_URL as the hermes kind alias', () => {
    const adapter = createAgentBridgeAdapter()
    expect(adapter.available({ HERMES_API_BASE_URL: 'http://localhost:8080' })).toBe(true)
  })

  it('is HIDDEN on Vercel with a private (non-public) URL', () => {
    const adapter = createAgentBridgeAdapter()
    expect(
      adapter.available({
        VERCEL: '1',
        AGENT_BRIDGE_KIND: 'ollama',
        AGENT_BRIDGE_URL: 'http://localhost:11434',
      }),
    ).toBe(false)
  })

  it('is allowed on Vercel with ALLOW_AGENT_BRIDGE_IN_PROD=1', () => {
    const adapter = createAgentBridgeAdapter()
    expect(
      adapter.available({
        VERCEL: '1',
        ALLOW_AGENT_BRIDGE_IN_PROD: '1',
        AGENT_BRIDGE_KIND: 'openai-compatible',
        AGENT_BRIDGE_URL: 'http://localhost:11434',
      }),
    ).toBe(true)
  })

  it('is allowed on Vercel when the URL is a public HTTPS/tunnel', () => {
    const adapter = createAgentBridgeAdapter()
    expect(
      adapter.available({
        VERCEL: '1',
        AGENT_BRIDGE_KIND: 'openai-compatible',
        AGENT_BRIDGE_URL: 'https://my-agent.example.com',
      }),
    ).toBe(true)
  })

  it('is allowed with SELF_HOST=1 even on a private URL', () => {
    const adapter = createAgentBridgeAdapter()
    expect(
      adapter.available({
        VERCEL: '1',
        SELF_HOST: '1',
        AGENT_BRIDGE_KIND: 'ollama',
        AGENT_BRIDGE_URL: 'http://10.0.0.5:11434',
      }),
    ).toBe(true) // self-host relaxes the Vercel gate for a private-network URL
  })

  it('is excluded from listAvailableAdapters() in prod with a private URL', () => {
    const env = {
      VERCEL: '1',
      AGENT_BRIDGE_KIND: 'ollama',
      AGENT_BRIDGE_URL: 'http://localhost:11434',
    }
    expect(listAvailableAdapters(env).some((a) => a.id === 'agent-bridge')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ollama — NDJSON streaming + model listing via /api/tags
// ---------------------------------------------------------------------------

const OLLAMA_ENV = { AGENT_BRIDGE_KIND: 'ollama', AGENT_BRIDGE_URL: 'http://localhost:11434' }

describe('agent-bridge adapter — ollama (NDJSON)', () => {
  it('yields deltas from message.content then a done event', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url).toBe('http://localhost:11434/api/chat')
      return new Response(
        ndjsonStream([
          JSON.stringify({ message: { role: 'assistant', content: 'Hel' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: 'lo' }, done: false }),
          JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }),
        ]),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      )
    })
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    const events = await collect(
      adapter.streamChat(
        { system: 'You are a face.', messages: [{ role: 'user', content: 'hi' }] },
        OLLAMA_ENV,
      ),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'done', reason: 'stop' },
    ])
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a face.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('lists local Ollama models via /api/tags', async () => {
    const { fn } = fakeFetch((url) => {
      expect(url).toBe('http://localhost:11434/api/tags')
      return new Response(
        JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] }),
        { status: 200 },
      )
    })
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    const models = await adapter.listModels({ ...OLLAMA_ENV, AGENT_BRIDGE_MODEL: 'qwen2.5:7b' })
    expect(models.map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5:7b'])
    expect(models.find((m) => m.isDefault)?.id).toBe('qwen2.5:7b')
  })
})

// ---------------------------------------------------------------------------
// openai-compatible (openclaw / claude-code) — SSE streaming
// ---------------------------------------------------------------------------

describe('agent-bridge adapter — openai-compatible (SSE)', () => {
  it('posts to /v1/chat/completions and streams choices deltas', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url).toBe('http://localhost:9000/v1/chat/completions')
      return new Response(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    const events = await collect(
      adapter.streamChat(
        { messages: [{ role: 'user', content: 'go' }] },
        { AGENT_BRIDGE_KIND: 'openclaw', AGENT_BRIDGE_URL: 'http://localhost:9000', AGENT_BRIDGE_KEY: 'tok' },
      ),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'A' },
      { type: 'delta', text: 'B' },
      { type: 'done', reason: 'stop' },
    ])
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
  })
})

// ---------------------------------------------------------------------------
// Hermes — OpenAI-shaped single call with X-Hermes-Session-Id continuity.
// Contract verified LIVE against NousResearch/hermes-agent (2026-07-20):
// there is NO session-create endpoint; the id arrives as a RESPONSE header
// and is sent back on later turns to continue the agent's own session.
// ---------------------------------------------------------------------------

describe('agent-bridge adapter — hermes session-header flow', () => {
  it('posts /v1/chat/completions with only the latest user turn; captures X-Hermes-Session-Id and resends it', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url).toBe('http://localhost:8642/v1/chat/completions')
      return new Response(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi ' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'X-Hermes-Session-Id': 'api-abc123',
          },
        },
      )
    })
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    const env = { HERMES_API_BASE_URL: 'http://localhost:8642', HERMES_API_KEY: 'hk' }

    const events = await collect(
      adapter.streamChat(
        {
          system: 'face persona',
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
          ],
        },
        env,
      ),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'Hi ' },
      { type: 'done', reason: 'stop' },
    ])

    // First turn: Bearer auth, NO session header yet, latest user turn only.
    const h1 = calls[0].init.headers as Record<string, string>
    expect(h1.Authorization).toBe('Bearer hk')
    expect(h1['X-Hermes-Session-Id']).toBeUndefined()
    const b1 = JSON.parse(calls[0].init.body as string)
    expect(b1.stream).toBe(true)
    // Persona is SERVER-AUTHORITATIVE for a Hermes brain: the client-supplied
    // 'face persona' is IGNORED and the adapter injects the current
    // identity-preserving persona, so a stale browser (cached bundle / old
    // localStorage) can never override who the agent is.
    expect(b1.messages).toHaveLength(2)
    expect(b1.messages[0].role).toBe('system')
    expect(b1.messages[0].content).toContain('Keep your own identity')
    expect(b1.messages[0].content).not.toBe('face persona')
    expect(b1.messages[1]).toEqual({ role: 'user', content: 'c' })

    // Second turn: the captured id rides along — the agent keeps the thread.
    await collect(adapter.streamChat({ messages: [{ role: 'user', content: 'd' }] }, env))
    const h2 = calls[1].init.headers as Record<string, string>
    expect(h2['X-Hermes-Session-Id']).toBe('api-abc123')
    const b2 = JSON.parse(calls[1].init.body as string)
    // Every turn re-affirms the delivery persona (server-authoritative), then
    // the latest user turn; the session id carries the thread server-side.
    expect(b2.messages).toHaveLength(2)
    expect(b2.messages[0].role).toBe('system')
    expect(b2.messages[0].content).toContain('Keep your own identity')
    expect(b2.messages[1]).toEqual({ role: 'user', content: 'd' })
  })

  it('tolerates a server that returns no session header (falls back to stateless turns)', async () => {
    const { fn, calls } = fakeFetch(() =>
      new Response(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    const env = { HERMES_API_BASE_URL: 'http://localhost:8642' }
    await collect(adapter.streamChat({ messages: [{ role: 'user', content: 'a' }] }, env))
    await collect(adapter.streamChat({ messages: [{ role: 'user', content: 'b' }] }, env))
    const h2 = calls[1].init.headers as Record<string, string>
    expect(h2['X-Hermes-Session-Id']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// barge-in + offline
// ---------------------------------------------------------------------------

describe('agent-bridge adapter — barge-in & offline', () => {
  it('stops emitting deltas once the signal is aborted', async () => {
    const controller = new AbortController()
    const { fn } = fakeFetch(() =>
      new Response(
        ndjsonStream([
          JSON.stringify({ message: { content: 'one' } }),
          JSON.stringify({ message: { content: 'two' } }),
          JSON.stringify({ message: { content: 'three' }, done: true }),
        ]),
        { status: 200 },
      ),
    )
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    const received: StreamEvent[] = []
    let caught: unknown
    try {
      for await (const ev of adapter.streamChat(
        { messages: [{ role: 'user', content: 'go' }], signal: controller.signal },
        OLLAMA_ENV,
      )) {
        received.push(ev)
        if (ev.type === 'delta' && ev.text === 'one') controller.abort()
      }
    } catch (err) {
      caught = err
    }
    expect(received).toEqual([{ type: 'delta', text: 'one' }])
    expect(caught).toBeInstanceOf(AdapterError)
    expect((caught as AdapterError).code).toBe('aborted')
  })

  it('returns a clear offline error when the endpoint is unreachable', async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    const adapter = createAgentBridgeAdapter({ fetch: fn })
    let caught: unknown
    try {
      await collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, OLLAMA_ENV))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AdapterError)
    expect((caught as AdapterError).code).toBe('network')
    expect((caught as AdapterError).message.toLowerCase()).toContain('offline')
  })

  it('throws unavailable when the bridge is not configured', async () => {
    const adapter = createAgentBridgeAdapter()
    await expect(
      collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, {})),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
})
