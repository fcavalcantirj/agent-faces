// Shared fake-SSE transport for headless streaming tests.
//
// Extracted from lib/chat/client.test.ts so every streaming test (the chat
// client, the /api/chat eval, the orchestrator evals) drives the SAME wire
// shape the real route emits — `data: {json StreamEvent}\n\n` — instead of each
// suite growing its own slightly-different faker.
//
// No network, no browser, no provider keys: a `fetch` built here returns a
// `Response` whose body is a `ReadableStream` of SSE frames you control.

import type { AdapterErrorShape, StreamEvent } from '@/lib/providers'

/** Serialize a StreamEvent as one SSE frame, exactly like app/api/chat/route.ts does. */
export const frame = (event: StreamEvent): string => `data: ${JSON.stringify(event)}\n\n`

/** `data: {"type":"delta","text":...}` */
export const delta = (text: string): string => frame({ type: 'delta', text })

/** `data: {"type":"done"}` — terminal frame of a healthy stream. */
export const doneFrame = (reason?: string): string => frame({ type: 'done', reason })

/** `data: {"type":"error",...}` — terminal frame of a failed stream. */
export const errorFrame = (error: AdapterErrorShape): string => frame({ type: 'error', error })

/**
 * One chunk to enqueue: either a literal string sent as-is, or a thunk resolved
 * at pull time so a test can gate emission (e.g. interleave an `abort()` between
 * two deltas to exercise barge-in).
 */
export type Chunk = string | (() => Promise<string> | string)

export interface MakeFetchOptions {
  status?: number
  contentType?: string
}

/**
 * Build a fake `fetch` returning an SSE (or JSON) response.
 *
 * The stream honors the request `signal`: aborting errors the body exactly like
 * a real fetch does, so barge-in paths are exercised for real rather than mocked
 * away.
 */
export function makeFetch(chunks: Chunk[], options: MakeFetchOptions = {}): typeof fetch {
  const { status = 200, contentType = 'text/event-stream' } = options

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

/**
 * Collect every event an async iterable yields. Handy for asserting on a whole
 * stream without hand-rolling a for-await in each test.
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}
