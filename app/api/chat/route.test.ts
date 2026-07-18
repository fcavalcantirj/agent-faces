import { afterEach, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/chat/route'
import { registerAdapter, unregisterAdapter } from '@/lib/providers'
import {
  AdapterError,
  type ChatAdapter,
  type ChatRequest,
  type ModelInfo,
  type StreamEvent,
} from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a POST Request to /api/chat with a JSON body and optional abort signal. */
function chatRequest(body: unknown, signal?: AbortSignal): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

/** Read a text/event-stream Response body into the sequence of parsed events. */
async function readSSE(res: Response): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (line) events.push(JSON.parse(line.slice('data:'.length).trim()))
    }
  }
  return events
}

const baseBody = {
  provider: 'fake-chat',
  messages: [{ role: 'user', content: 'hello' }],
}

// A scripted adapter that streams two deltas then done, echoing the last user turn.
function makeScriptedAdapter(): ChatAdapter {
  return {
    id: 'fake-chat',
    label: 'Fake Chat',
    mode: 'A',
    available: () => true,
    async listModels(): Promise<ModelInfo[]> {
      return [{ id: 'fake-model', isDefault: true }]
    },
    async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
      yield { type: 'delta', text: 'Hel' }
      yield { type: 'delta', text: 'lo' }
      yield { type: 'done', reason: 'stop' }
    },
  }
}

afterEach(() => {
  unregisterAdapter('fake-chat')
  unregisterAdapter('fake-abort')
  unregisterAdapter('fake-boom')
  unregisterAdapter('fake-keyless')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/chat', () => {
  it('streams SSE deltas then a terminal done event', async () => {
    registerAdapter('fake-chat', makeScriptedAdapter)
    const res = await POST(chatRequest(baseBody))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toContain('no-cache')
    expect(res.headers.get('x-accel-buffering')).toBe('no')

    const events = await readSSE(res)
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'done', reason: 'stop' },
    ])
  })

  it('flushes each delta as its own SSE frame (incremental, not one blob)', async () => {
    registerAdapter('fake-chat', makeScriptedAdapter)
    const res = await POST(chatRequest(baseBody))
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const { value } = await reader.read()
    const firstChunk = decoder.decode(value)
    // The first flush must contain ONLY the first delta, proving per-delta flush.
    expect(firstChunk).toContain('Hel')
    expect(firstChunk).not.toContain('done')
    await reader.cancel()
  })

  it('returns 400 with a machine-readable code for an unknown provider', async () => {
    const res = await POST(chatRequest({ ...baseBody, provider: 'nope' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('unknown_provider')
  })

  it('returns 400 unavailable for a registered brain missing its key', async () => {
    registerAdapter('fake-keyless', () => ({
      id: 'fake-keyless',
      label: 'Keyless',
      mode: 'A',
      available: () => false,
      async listModels() {
        return []
      },
      async *streamChat() {
        /* never reached */
      },
    }))
    const res = await POST(chatRequest({ ...baseBody, provider: 'fake-keyless' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('unavailable')
  })

  it('rejects an oversized body early with 400 bad_request', async () => {
    const huge = 'x'.repeat(5 * 1024 * 1024)
    const res = await POST(chatRequest({ ...baseBody, system: huge }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('bad_request')
  })

  it('rejects invalid JSON with 400 bad_request', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('bad_request')
  })

  it('rejects a body with no messages with 400 bad_request', async () => {
    const res = await POST(chatRequest({ provider: 'fake-chat', messages: [] }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('bad_request')
  })

  it('emits a safe error event when the adapter fails mid-stream', async () => {
    registerAdapter('fake-boom', () => ({
      id: 'fake-boom',
      label: 'Boom',
      mode: 'A',
      available: () => true,
      async listModels() {
        return []
      },
      async *streamChat(): AsyncIterable<StreamEvent> {
        yield { type: 'delta', text: 'partial' }
        throw new AdapterError('upstream_error', 'boom', { provider: 'fake-boom', status: 502 })
      },
    }))
    const res = await POST(chatRequest({ ...baseBody, provider: 'fake-boom' }))
    // The status line is already 200 (stream opened); the failure rides the body.
    expect(res.status).toBe(200)
    const events = await readSSE(res)
    expect(events[0]).toEqual({ type: 'delta', text: 'partial' })
    const errEvent = events.find((e) => e.type === 'error')
    expect(errEvent).toBeDefined()
    expect((errEvent as Extract<StreamEvent, { type: 'error' }>).error.code).toBe('upstream_error')
  })

  it('wires the request signal so a client abort stops upstream generation', async () => {
    let produced = 0
    registerAdapter('fake-abort', () => ({
      id: 'fake-abort',
      label: 'Abort',
      mode: 'A',
      available: () => true,
      async listModels() {
        return []
      },
      async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
        for (let i = 0; i < 30; i++) {
          if (req.signal?.aborted) {
            throw new AdapterError('aborted', 'aborted', { provider: 'fake-abort' })
          }
          produced++
          yield { type: 'delta', text: `t${i}` }
          await new Promise((r) => setTimeout(r, 5))
        }
        yield { type: 'done' }
      },
    }))

    const ac = new AbortController()
    const res = await POST(chatRequest({ ...baseBody, provider: 'fake-abort' }, ac.signal))
    const reader = res.body!.getReader()
    await reader.read() // consume the first flushed delta
    ac.abort()

    // Drain whatever remains; the stream should end promptly, not run all 30.
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      /* aborted */
    }

    const atAbort = produced
    await new Promise((r) => setTimeout(r, 80))
    // Upstream generation halted: no further deltas produced after the abort,
    // and it stopped well before the full 30.
    expect(produced).toBe(atAbort)
    expect(produced).toBeLessThan(30)
  })
})
