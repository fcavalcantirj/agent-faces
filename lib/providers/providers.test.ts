import { afterEach, describe, expect, it } from 'vitest'
import {
  getAdapter,
  listAdapters,
  listAvailableAdapters,
  registerAdapter,
  registeredAdapterIds,
  resolveAdapter,
  selectDefaultAdapter,
  unregisterAdapter,
} from '@/lib/providers'
import {
  AdapterError,
  statusForAdapterError,
  type ChatAdapter,
  type ChatRequest,
  type ModelInfo,
  type StreamEvent,
} from '@/lib/providers/types'
import { errorForStatus, normalizeError, parseSSEStream, SSE_DONE } from '@/lib/providers/sse'

// A no-op adapter used to exercise the registry without any real provider I/O.
function makeFakeAdapter(
  id: string,
  opts: { requiredKey?: string; mode?: 'A' | 'B' } = {},
): ChatAdapter {
  return {
    id,
    label: `Fake ${id}`,
    mode: opts.mode ?? 'A',
    available(env) {
      return opts.requiredKey ? Boolean(env[opts.requiredKey]) : true
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{ id: `${id}-model`, label: `${id} model`, isDefault: true }]
    },
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      for (const m of req.messages) {
        yield { type: 'delta', text: m.content }
      }
      yield { type: 'done', reason: 'stop' }
    },
  }
}

// Track ids registered per-test so teardown is clean and order-independent.
const registered = new Set<string>()
function register(adapter: ChatAdapter): void {
  registerAdapter(adapter.id, () => adapter)
  registered.add(adapter.id)
}

afterEach(() => {
  for (const id of registered) unregisterAdapter(id)
  registered.clear()
})

describe('adapter registry', () => {
  it('resolves a registered, available adapter to a memoized singleton', () => {
    const fake = makeFakeAdapter('fake-a')
    register(fake)
    const a = resolveAdapter('fake-a', {})
    const b = getAdapter('fake-a')
    expect(a.id).toBe('fake-a')
    expect(b).toBe(a) // memoized: same instance each time
  })

  it('throws unknown_provider for an unregistered id', () => {
    try {
      resolveAdapter('nope', {})
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError)
      expect((err as AdapterError).code).toBe('unknown_provider')
    }
  })

  it('throws unavailable when the adapter exists but its key is missing', () => {
    register(makeFakeAdapter('fake-key', { requiredKey: 'FAKE_KEY' }))
    try {
      resolveAdapter('fake-key', {}) // no FAKE_KEY in env
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as AdapterError).code).toBe('unavailable')
    }
    // With the key present it resolves fine.
    expect(resolveAdapter('fake-key', { FAKE_KEY: 'x' }).id).toBe('fake-key')
  })

  it('listAvailableAdapters returns only adapters whose env keys are present', () => {
    register(makeFakeAdapter('always-on'))
    register(makeFakeAdapter('needs-key', { requiredKey: 'NEEDS_KEY' }))

    const withoutKey = listAvailableAdapters({}).map((a) => a.id)
    expect(withoutKey).toContain('always-on')
    expect(withoutKey).not.toContain('needs-key')

    const withKey = listAvailableAdapters({ NEEDS_KEY: '1' }).map((a) => a.id)
    expect(withKey).toContain('always-on')
    expect(withKey).toContain('needs-key')
  })

  it('lists every registered adapter regardless of availability', () => {
    register(makeFakeAdapter('reg-1'))
    register(makeFakeAdapter('reg-2', { requiredKey: 'ABSENT' }))
    const ids = listAdapters().map((a) => a.id)
    expect(ids).toContain('reg-1')
    expect(ids).toContain('reg-2')
  })

  it('orders known providers by the documented priority', () => {
    // Register out of order; expect priority order back.
    register(makeFakeAdapter('groq'))
    register(makeFakeAdapter('anthropic'))
    register(makeFakeAdapter('openrouter'))
    const ids = registeredAdapterIds()
    expect(ids.indexOf('anthropic')).toBeLessThan(ids.indexOf('openrouter'))
    expect(ids.indexOf('openrouter')).toBeLessThan(ids.indexOf('groq'))
  })

  it('selectDefaultAdapter picks the highest-priority available brain', () => {
    register(makeFakeAdapter('groq', { requiredKey: 'GROQ_API_KEY' }))
    register(makeFakeAdapter('anthropic', { requiredKey: 'ANTHROPIC_API_KEY' }))
    // Only Groq configured -> Groq is the default.
    expect(selectDefaultAdapter({ GROQ_API_KEY: 'g' })?.id).toBe('groq')
    // Both configured -> Anthropic wins on priority.
    const both = { GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }
    expect(selectDefaultAdapter(both)?.id).toBe('anthropic')
    // Nothing configured -> undefined.
    expect(selectDefaultAdapter({})).toBeUndefined()
  })

  it('selectDefaultAdapter prefers an available agent-bridge over any Mode-A brain', () => {
    // The bridge is an explicit bring-your-own-agent wiring; it should win the
    // default even when a hosted Mode-A key is also present (e.g. GROQ_API_KEY
    // that is really there for Whisper STT).
    register(makeFakeAdapter('groq', { requiredKey: 'GROQ_API_KEY' }))
    register(makeFakeAdapter('anthropic', { requiredKey: 'ANTHROPIC_API_KEY' }))
    register(makeFakeAdapter('agent-bridge', { requiredKey: 'AGENT_BRIDGE_URL' }))
    const env = { GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AGENT_BRIDGE_URL: 'http://x' }
    expect(selectDefaultAdapter(env)?.id).toBe('agent-bridge')
    // Bridge absent -> falls back to the documented Mode-A priority.
    expect(selectDefaultAdapter({ GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })?.id).toBe('anthropic')
  })

  it('a registered FakeAdapter streams deltas then done', async () => {
    const fake = makeFakeAdapter('fake-stream')
    register(fake)
    const events: StreamEvent[] = []
    for await (const ev of fake.streamChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev)
    }
    expect(events).toEqual([
      { type: 'delta', text: 'hi' },
      { type: 'done', reason: 'stop' },
    ])
  })
})

describe('AdapterError', () => {
  it('is a real Error with instanceof intact and a wire-safe shape', () => {
    const err = new AdapterError('unauthorized', 'bad key', { provider: 'groq', status: 401 })
    expect(err).toBeInstanceOf(AdapterError)
    expect(err).toBeInstanceOf(Error)
    expect(err.toShape()).toEqual({
      code: 'unauthorized',
      message: 'bad key',
      provider: 'groq',
      status: 401,
    })
  })

  it('maps codes to HTTP statuses', () => {
    expect(statusForAdapterError('unknown_provider')).toBe(400)
    expect(statusForAdapterError('unavailable')).toBe(400)
    expect(statusForAdapterError('unauthorized')).toBe(401)
    expect(statusForAdapterError('rate_limited')).toBe(429)
    expect(statusForAdapterError('upstream_error')).toBe(502)
    expect(statusForAdapterError('network')).toBe(502)
    expect(statusForAdapterError('unknown')).toBe(500)
  })
})

describe('SSE helper', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let i = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]))
        } else {
          controller.close()
        }
      },
    })
  }

  it('parses OpenAI-style data: chunks and drops the [DONE] sentinel', async () => {
    const body = streamOf([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      `data: ${SSE_DONE}\n\n`,
    ])
    const payloads: string[] = []
    for await (const data of parseSSEStream(body, { provider: 'openrouter' })) {
      payloads.push(data)
    }
    const texts = payloads.map((p) => JSON.parse(p).choices[0].delta.content)
    expect(texts).toEqual(['Hel', 'lo'])
  })

  it('handles an event split across two byte chunks', async () => {
    const body = streamOf(['data: {"choices":[{"delta":{"con', 'tent":"Split"}}]}\n\n'])
    const payloads: string[] = []
    for await (const data of parseSSEStream(body)) {
      payloads.push(data)
    }
    expect(JSON.parse(payloads[0]).choices[0].delta.content).toBe('Split')
  })

  it('errorForStatus normalizes upstream statuses to typed codes', () => {
    expect(errorForStatus(401, 'groq').code).toBe('unauthorized')
    expect(errorForStatus(429, 'groq').code).toBe('rate_limited')
    expect(errorForStatus(500, 'groq').code).toBe('upstream_error')
    expect(errorForStatus(400, 'groq').code).toBe('bad_request')
  })

  it('normalizeError preserves an existing AdapterError and types raw throws', () => {
    const existing = new AdapterError('rate_limited', 'slow down', { provider: 'groq' })
    expect(normalizeError(existing, 'groq')).toBe(existing)

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(normalizeError(abort, 'groq').code).toBe('aborted')

    // fetch() throws a TypeError when the endpoint is unreachable.
    expect(normalizeError(new TypeError('failed to fetch'), 'groq').code).toBe('network')

    expect(normalizeError(new Error('boom'), 'groq').code).toBe('unknown')
  })
})
