// A mock ChatAdapter for headless tests.
//
// Satisfies the real `ChatAdapter` contract (lib/providers/types.ts) so it can be
// registered into the real registry and driven through the real /api/chat route
// without touching a provider, a key, or the network. If the interface changes,
// this file fails to typecheck — which is the point.

import type {
  ChatAdapter,
  ChatRequest,
  ModelInfo,
  ProviderEnv,
  StreamEvent,
  AdapterErrorShape,
} from '@/lib/providers'

export interface MockAdapterOptions {
  id?: string
  label?: string
  mode?: 'A' | 'B'
  /** Text chunks emitted as `delta` events, in order. */
  deltas?: string[]
  /** Emit this error instead of completing (terminal). */
  error?: AdapterErrorShape
  /** Models reported by `listModels`. */
  models?: ModelInfo[]
  /** Availability predicate; defaults to always-available. */
  available?: (env: ProviderEnv) => boolean
  /** Optional per-delta delay hook so tests can interleave an abort. */
  onDelta?: (index: number) => Promise<void> | void
}

/**
 * Build a mock adapter. Defaults produce a short two-delta stream terminated by
 * `done`, which is the shape most tests want.
 */
export function createMockAdapter(options: MockAdapterOptions = {}): ChatAdapter {
  const {
    id = 'mock',
    label = 'Mock Provider',
    mode = 'A',
    deltas = ['Hello', ' world'],
    error,
    models = [{ id: 'mock-model', label: 'Mock Model', isDefault: true }],
    available = () => true,
    onDelta,
  } = options

  return {
    id,
    label,
    mode,
    available,
    async listModels(): Promise<ModelInfo[]> {
      return models
    },
    async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
      for (let i = 0; i < deltas.length; i++) {
        // Honor barge-in the way a real adapter must.
        if (req.signal?.aborted) return
        await onDelta?.(i)
        if (req.signal?.aborted) return
        yield { type: 'delta', text: deltas[i] }
      }

      if (error) {
        yield { type: 'error', error }
        return
      }
      yield { type: 'done' }
    },
  }
}

/** Concatenate the text of every `delta` event — the assembled assistant reply. */
export function textOf(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'delta' }> => e.type === 'delta')
    .map((e) => e.text)
    .join('')
}
