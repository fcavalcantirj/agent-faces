// The adapter registry — the single lookup table the `/api/chat` route and the
// `/api/config` probe go through. It maps a stable provider id to a factory and
// resolves ids to (memoized) `ChatAdapter` instances.
//
// THE SEAM, restated: adding a provider or wiring a new running agent is ONE
// file that implements `ChatAdapter` (lib/providers/<id>.ts) plus ONE
// `registerAdapter(...)` line in the "Built-in adapters" block below. Nothing
// else in the app changes — routes, settings, and config all read this table.

import {
  AdapterError,
  type ChatAdapter,
  type ChatAdapterFactory,
  type ProviderEnv,
} from '@/lib/providers/types'

/** id -> factory. Registration order does not matter; priority is explicit below. */
const factories = new Map<string, ChatAdapterFactory>()
/** id -> memoized instance (adapters are cheap, stateless singletons). */
const instances = new Map<string, ChatAdapter>()

/**
 * Register (or override) an adapter factory under its id. Adapter modules call
 * this at import time; tests call it to register a `FakeAdapter`. Overriding an
 * id clears any memoized instance so the new factory takes effect.
 */
export function registerAdapter(id: string, factory: ChatAdapterFactory): void {
  factories.set(id, factory)
  instances.delete(id)
}

/** Remove a registration (used by tests to clean up a `FakeAdapter`). */
export function unregisterAdapter(id: string): void {
  factories.delete(id)
  instances.delete(id)
}

/** Every registered adapter id, in the documented priority order first. */
export function registeredAdapterIds(): string[] {
  const ids = [...factories.keys()]
  return ids.sort((a, b) => priorityIndex(a) - priorityIndex(b))
}

/** Get an adapter instance by id, or `undefined` if none is registered. */
export function getAdapter(id: string): ChatAdapter | undefined {
  const factory = factories.get(id)
  if (!factory) return undefined
  let instance = instances.get(id)
  if (!instance) {
    instance = factory()
    instances.set(id, instance)
  }
  return instance
}

/**
 * Resolve an adapter by id for a request. Throws a typed `AdapterError` the
 * route maps to a 400 — `unknown_provider` if nothing is registered, or
 * `unavailable` if the adapter exists but its key/endpoint is missing.
 */
export function resolveAdapter(id: string, env: ProviderEnv = process.env): ChatAdapter {
  const adapter = getAdapter(id)
  if (!adapter) {
    throw new AdapterError('unknown_provider', `No brain registered under id "${id}".`, {
      provider: id,
    })
  }
  if (!adapter.available(env)) {
    throw new AdapterError(
      'unavailable',
      `The "${adapter.label}" brain is not configured (missing key or unreachable endpoint).`,
      { provider: id },
    )
  }
  return adapter
}

/** Every registered adapter instance (available or not), in priority order. */
export function listAdapters(): ChatAdapter[] {
  return registeredAdapterIds()
    .map((id) => getAdapter(id))
    .filter((a): a is ChatAdapter => a !== undefined)
}

/**
 * The adapters whose required server keys / reachable endpoints are present in
 * `env`, in priority order. This is what `/api/config` exposes (as booleans)
 * and what the settings picker offers.
 */
export function listAvailableAdapters(env: ProviderEnv = process.env): ChatAdapter[] {
  return listAdapters().filter((adapter) => adapter.available(env))
}

/**
 * The default brain when the user has not explicitly picked one.
 *
 * A Mode-B agent-bridge is an EXPLICIT, intentional wiring — the operator stood
 * up their own running agent (with its own identity, memory, and tools) and
 * pointed the face at it. That is a stronger signal of intent than a hosted
 * Mode-A key that may only be present for a side capability (e.g. GROQ_API_KEY
 * is dual-use: it lights up Groq-as-brain AND Whisper STT). So when the bridge
 * is available it wins the default; otherwise fall back to the documented
 * Mode-A priority order (Anthropic > OpenRouter > Groq).
 */
export function selectDefaultAdapter(env: ProviderEnv = process.env): ChatAdapter | undefined {
  const available = listAvailableAdapters(env)
  return available.find((a) => a.id === 'agent-bridge') ?? available[0]
}

/**
 * Documented chat-brain priority (see docs/env-contract.md). Lower index wins.
 * Unknown ids (e.g. a test `FakeAdapter`) sort last but keep a stable order.
 */
const PRIORITY: readonly string[] = ['anthropic', 'openrouter', 'groq', 'agent-bridge']

function priorityIndex(id: string): number {
  const i = PRIORITY.indexOf(id)
  return i === -1 ? PRIORITY.length : i
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------
// Each concrete adapter registers itself here with a single line. Keep this
// block the ONE place built-in providers are wired up — nothing else in the
// app learns a provider's name.

import { createAnthropicAdapter } from '@/lib/providers/anthropic'
import { createOpenRouterAdapter } from '@/lib/providers/openrouter'
import { createGroqAdapter } from '@/lib/providers/groq'
import { createAgentBridgeAdapter } from '@/lib/providers/agent-bridge'

registerAdapter('anthropic', createAnthropicAdapter)
registerAdapter('openrouter', createOpenRouterAdapter)
registerAdapter('groq', createGroqAdapter)
registerAdapter('agent-bridge', createAgentBridgeAdapter)

export {
  AdapterError,
  statusForAdapterError,
} from '@/lib/providers/types'
export type {
  ChatAdapter,
  ChatAdapterFactory,
  ChatRequest,
  ChatMessage,
  ModelInfo,
  StreamEvent,
  AdapterErrorCode,
  AdapterErrorShape,
  ProviderEnv,
} from '@/lib/providers/types'
