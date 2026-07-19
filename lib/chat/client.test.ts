// Tests for the browser streaming chat client (lib/chat/client.ts).
//
// These run headlessly: a fake `fetch` returns a `Response` whose body is a
// `ReadableStream` of SSE frames shaped EXACTLY like app/api/chat/route.ts emits
// (`data: {json StreamEvent}\n\n`). No network, no browser — the SSE parse,
// sentence chunking, directive stripping, lifecycle callbacks, and barge-in are
// all exercised against controllable streams.

import { describe, it, expect, vi } from 'vitest'
import {
  streamChat,
  runChat,
  splitSentences,
  type ChatResult,
} from '@/lib/chat/client'
import { AdapterError, type StreamEvent } from '@/lib/providers'

// --- test helpers -----------------------------------------------------------

/** Serialize a StreamEvent as one SSE frame, exactly like the route does. */
const frame = (event: StreamEvent): string => `data: ${JSON.stringify(event)}\n\n`

const delta = (text: string): string => frame({ type: 'delta', text })
const doneFrame = (reason?: string): string => frame({ type: 'done', reason })

type Chunk = string | (() => Promise<string> | string)

/**
 * Build a fake `fetch` returning an SSE (or JSON) response. Each chunk is either
 * a literal string enqueued as-is, or a thunk (sync/async) resolved at pull time
 * so a test can gate emission and interleave `abort()`. The stream honors the
 * request `signal` (aborting errors the body, like a real fetch).
 */
function makeFetch(
  chunks: Chunk[],
  { status = 200, contentType = 'text/event-stream' }: { status?: number; contentType?: string } = {},
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const onAbort = () => {
          try {
            controller.error(new DOMException('Aborted', 'AbortError'))
          } catch {
            /* already closed/errored */
          }
        }
        if (signal) {
          if (signal.aborted) return onAbort()
          signal.addEventListener('abort', onAbort)
        }
        try {
          for (const c of chunks) {
            if (signal?.aborted) break
            const s = typeof c === 'function' ? await c() : c
            if (signal?.aborted) break
            controller.enqueue(enc.encode(s))
          }
          controller.close()
        } catch (err) {
          try {
            controller.error(err)
          } catch {
            /* noop */
          }
        } finally {
          signal?.removeEventListener('abort', onAbort)
        }
      },
    })
    return new Response(stream, {
      status,
      headers: { 'content-type': contentType },
    })
  }) as unknown as typeof fetch
}

/** A JSON error `fetch` (the shape the route returns before a stream opens). */
function makeErrorFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const REQ = {
  provider: 'anthropic',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

// --- splitSentences ---------------------------------------------------------

describe('splitSentences', () => {
  it('splits on . ! ? when followed by whitespace, keeping the tail as rest', () => {
    const { sentences, rest } = splitSentences('One. Two! Three? Four')
    expect(sentences).toEqual(['One.', 'Two!', 'Three?'])
    expect(rest).toBe('Four')
  })

  it('does NOT split a terminator at the very end of the buffer (may continue)', () => {
    const { sentences, rest } = splitSentences('Hello world.')
    expect(sentences).toEqual([])
    expect(rest).toBe('Hello world.')
  })

  it('splits on newlines too', () => {
    const { sentences, rest } = splitSentences('line one\nline two\npartial')
    expect(sentences).toEqual(['line one', 'line two'])
    expect(rest).toBe('partial')
  })
})

// --- streamChat (low-level generator) ---------------------------------------

describe('streamChat', () => {
  it('yields delta text progressively then returns the done reason', async () => {
    const fetchImpl = makeFetch([
      delta('Hello '),
      delta('there '),
      delta('friend'),
      doneFrame('end_turn'),
    ])
    const it = streamChat({ ...REQ, fetchImpl })
    const seen: string[] = []
    for (;;) {
      const n = await it.next()
      if (n.done) {
        expect(n.value?.reason).toBe('end_turn')
        break
      }
      seen.push(n.value)
    }
    expect(seen).toEqual(['Hello ', 'there ', 'friend'])
  })

  it('throws a typed AdapterError when the stream carries an error event', async () => {
    const fetchImpl = makeFetch([
      delta('partial'),
      frame({ type: 'error', error: { code: 'rate_limited', message: 'slow down', provider: 'anthropic', status: 429 } }),
    ])
    const it = streamChat({ ...REQ, fetchImpl })
    await expect(async () => {
      for (;;) {
        const n = await it.next()
        if (n.done) break
      }
    }).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
  })

  it('throws an AdapterError parsed from a non-ok JSON response', async () => {
    const fetchImpl = makeErrorFetch(400, {
      error: { code: 'unknown_provider', message: 'no such brain', provider: 'nope' },
    })
    const it = streamChat({ ...REQ, provider: 'nope', fetchImpl })
    await expect(it.next()).rejects.toMatchObject({
      code: 'unknown_provider',
    })
  })
})

// --- runChat (driver: callbacks, chunking, directives, barge-in) ------------

/** A gate the test opens to release the next SSE chunk (thunk-chunk helper). */
function gate(): { open: () => void; p: Promise<void> } {
  let open!: () => void
  const p = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, p }
}

describe('runChat gap flush (deterministic speech — 2026-07-19 live finding)', () => {
  // A short phrase before tool work ("On it.") used to strand in the buffer
  // until `done` — i.e. until 30-60s of silent agent work finished — because a
  // terminator only splits when FOLLOWED by whitespace. After a real stream
  // gap, whatever is buffered must be spoken NOW.
  it('speaks a terminal-punctuated buffer after a short gap, BEFORE done', async () => {
    vi.useFakeTimers()
    try {
      const g = gate()
      const fetchImpl = makeFetch([delta('On it.'), async () => (await g.p, doneFrame('stop'))])
      const log: string[] = []
      const session = runChat(
        { ...REQ, fetchImpl },
        { onSentence: (s) => log.push(`sentence:${s}`), onDone: () => log.push('done') },
      )
      await vi.advanceTimersByTimeAsync(400) // > SENTENCE_GAP_FLUSH_MS
      expect(log).toContain('sentence:On it.')
      expect(log).not.toContain('done')
      g.open()
      await session.done
      expect(log.indexOf('sentence:On it.')).toBeLessThan(log.indexOf('done'))
      expect(log.filter((l) => l.startsWith('sentence:'))).toHaveLength(1) // no re-speak at done
    } finally {
      vi.useRealTimers()
    }
  })

  it('speaks a NON-terminated clause after a long stall, BEFORE done', async () => {
    vi.useFakeTimers()
    try {
      const g = gate()
      const fetchImpl = makeFetch([
        delta('Creating the file now'),
        async () => (await g.p, doneFrame('stop')),
      ])
      const log: string[] = []
      const session = runChat(
        { ...REQ, fetchImpl },
        { onSentence: (s) => log.push(`sentence:${s}`), onDone: () => log.push('done') },
      )
      await vi.advanceTimersByTimeAsync(400) // below the stall threshold: still quiet
      expect(log).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1200) // past STALL_FLUSH_MS
      expect(log).toContain('sentence:Creating the file now')
      g.open()
      await session.done
      expect(log.indexOf('sentence:Creating the file now')).toBeLessThan(log.indexOf('done'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('a quick next delta re-arms the timer — decimals never split', async () => {
    vi.useFakeTimers()
    try {
      const g2 = gate()
      const g3 = gate()
      const fetchImpl = makeFetch([
        delta('pi is 3.'),
        async () => (await g2.p, delta('14 exactly. ')),
        async () => (await g3.p, doneFrame('stop')),
      ])
      const sentences: string[] = []
      const session = runChat({ ...REQ, fetchImpl }, { onSentence: (s) => sentences.push(s) })
      await vi.advanceTimersByTimeAsync(50) // well inside the gap window
      g2.open()
      await vi.advanceTimersByTimeAsync(1)
      g3.open()
      await session.done
      expect(sentences).toEqual(['pi is 3.14 exactly.'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never speaks a half-open face directive; done still strips it', async () => {
    vi.useFakeTimers()
    try {
      const g = gate()
      const fetchImpl = makeFetch([
        delta('Done![[face:ha'),
        async () => (await g.p, delta('ppy]]') + doneFrame('stop')),
      ])
      const log: string[] = []
      const session = runChat(
        { ...REQ, fetchImpl },
        { onSentence: (s) => log.push(`sentence:${s}`), onDone: () => log.push('done') },
      )
      await vi.advanceTimersByTimeAsync(2000) // past every flush tier
      expect(log).toHaveLength(0) // holding: a partial [[face: must never be spoken
      g.open()
      const result = await session.done
      expect(log).toEqual(['sentence:Done!', 'done'])
      expect(result.emotion).toBe('happy')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runChat', () => {
  it('fires lifecycle callbacks and dispatches complete sentences to TTS incrementally', async () => {
    const fetchImpl = makeFetch([
      delta('Hello there. '),
      delta('How are you today? '),
      delta('I am fine.[[face:happy]]'),
      doneFrame('stop'),
    ])

    const log: string[] = []
    const tokens: string[] = []
    const sentences: string[] = []
    let result: ChatResult | undefined

    const session = runChat(
      { ...REQ, fetchImpl },
      {
        onStart: () => log.push('start'),
        onFirstToken: () => log.push('first'),
        onToken: (d) => {
          tokens.push(d)
          log.push('token')
        },
        onSentence: (s) => {
          sentences.push(s)
          log.push(`sentence:${s}`)
        },
        onDone: (r) => {
          result = r
          log.push('done')
        },
        onError: () => log.push('error'),
      },
    )

    const awaited = await session.done
    expect(result).toBeDefined()

    // Progressive tokens == the deltas, in order.
    expect(tokens).toEqual(['Hello there. ', 'How are you today? ', 'I am fine.[[face:happy]]'])

    // Sentences handed to TTS — directive stripped, one per complete sentence.
    expect(sentences).toEqual(['Hello there.', 'How are you today?', 'I am fine.'])

    // The first sentence reached TTS BEFORE the stream completed (before done).
    expect(log.indexOf('sentence:Hello there.')).toBeLessThan(log.indexOf('done'))

    // Lifecycle order: start -> first -> ... -> done, error never fired.
    expect(log[0]).toBe('start')
    expect(log.indexOf('first')).toBeGreaterThan(0)
    expect(log).not.toContain('error')

    // Directive resolved to the resting emotion; spoken text has no directive.
    expect(awaited.emotion).toBe('happy')
    expect(awaited.text).toBe('Hello there. How are you today? I am fine.')
    expect(awaited.text).not.toContain('[[')
    expect(awaited.reason).toBe('stop')
    expect(awaited.aborted).toBe(false)
  })

  it('barge-in: aborting mid-stream stops token accumulation and queued TTS', async () => {
    const gate = deferred()
    const fetchImpl = makeFetch([
      delta('One. Two'),
      async () => {
        await gate.promise
        return delta(' more. Three.')
      },
      doneFrame('stop'),
    ])

    const tokens: string[] = []
    const sentences: string[] = []
    let errored = false

    const session = runChat(
      { ...REQ, fetchImpl },
      {
        onToken: (_d, acc) => tokens.push(acc),
        onSentence: (s) => {
          sentences.push(s)
          // As soon as the first sentence is dispatched, barge in.
          session.abort()
          gate.resolve()
        },
        onError: () => {
          errored = true
        },
      },
    )

    const result = await session.done

    // Only the first, already-complete sentence was dispatched; the rest was
    // never accumulated or flushed to TTS.
    expect(sentences).toEqual(['One.'])
    expect(tokens).toEqual(['One. Two'])
    expect(result.aborted).toBe(true)
    expect(errored).toBe(false)
    // The aborted turn never accumulated the gated "more."/"Three." deltas.
    expect(result.raw).toBe('One. Two')
  })

  it('onError -> glitch: a mid-stream error surfaces a typed AdapterError, not aborted', async () => {
    const fetchImpl = makeFetch([
      delta('working'),
      frame({ type: 'error', error: { code: 'upstream_error', message: 'boom', provider: 'anthropic', status: 502 } }),
    ])

    let captured: AdapterError | undefined
    const session = runChat(
      { ...REQ, fetchImpl },
      { onError: (e) => (captured = e) },
    )

    const result = await session.done
    expect(captured).toBeInstanceOf(AdapterError)
    expect(captured?.code).toBe('upstream_error')
    expect(result.error?.code).toBe('upstream_error')
    expect(result.aborted).toBe(false)
  })

  it('honors an external abort signal passed by the UI', async () => {
    const controller = new AbortController()
    const gate = deferred()
    const fetchImpl = makeFetch([
      delta('start'),
      async () => {
        await gate.promise
        return delta('never')
      },
      doneFrame(),
    ])

    const session = runChat(
      { ...REQ, fetchImpl, signal: controller.signal },
      {
        onToken: () => {
          controller.abort()
          gate.resolve()
        },
      },
    )

    const result = await session.done
    expect(result.aborted).toBe(true)
    expect(result.raw).toBe('start')
  })
})
