import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/config/route'

// ---------------------------------------------------------------------------
// The /api/config probe reports capability BOOLEANS derived from the real
// registered adapters + simple key-presence checks. These specs drive it
// against controlled env snapshots and assert (a) the shape, (b) that flipping
// a key flips exactly the corresponding boolean, and (c) that no secret
// material ever appears in the body.
// ---------------------------------------------------------------------------

/** Provider/STT/TTS env keys the probe reads; cleared before each scenario. */
const RELEVANT_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_DEFAULT_MODEL',
  'GROQ_API_KEY',
  'GROQ_DEFAULT_MODEL',
  'OPENAI_API_KEY',
  'AGENT_BRIDGE_KIND',
  'AGENT_BRIDGE_URL',
  'AGENT_BRIDGE_MODEL',
  'HERMES_API_BASE_URL',
  'HERMES_API_KEY',
  'SELF_HOST',
  'ALLOW_AGENT_BRIDGE_IN_PROD',
  'VERCEL',
  'VERCEL_ENV',
]

/** Start every scenario from a known-empty capability surface. */
function clearKeys(): void {
  for (const key of RELEVANT_KEYS) vi.stubEnv(key, '')
}

async function readConfig(): Promise<{ res: Response; body: any; text: string }> {
  const res = await GET()
  const text = await res.clone().text()
  const body = JSON.parse(text)
  return { res, body, text }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/config', () => {
  it('returns the documented shape with everything off when no keys are set', async () => {
    clearKeys()
    const { res, body } = await readConfig()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    // Cheap, secret-free probe — must carry a cache header.
    expect(res.headers.get('cache-control')).toBeTruthy()

    // Mode A providers are all present as booleans, all off.
    expect(body.providers.anthropic.available).toBe(false)
    expect(body.providers.openrouter.available).toBe(false)
    expect(body.providers.groq.available).toBe(false)
    // No default model is advertised for an unavailable provider.
    expect(body.providers.anthropic.defaultModel).toBeUndefined()

    expect(body.agentBridge.available).toBe(false)
    expect(body.stt).toEqual({ groq: false, openai: false })
    expect(body.tts).toEqual({ openai: false })
    expect(body.defaultProvider).toBeNull()
  })

  it('flips anthropic on (with its default model + defaultProvider) when the key is set', async () => {
    clearKeys()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-key-value')
    const { body } = await readConfig()

    expect(body.providers.anthropic.available).toBe(true)
    expect(body.providers.anthropic.defaultModel).toBe('claude-opus-4-8')
    expect(body.providers.openrouter.available).toBe(false)
    // Highest-priority available brain preselects.
    expect(body.defaultProvider).toBe('anthropic')
  })

  it('honors ANTHROPIC_DEFAULT_MODEL for the preselected model', async () => {
    clearKeys()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake')
    vi.stubEnv('ANTHROPIC_DEFAULT_MODEL', 'claude-sonnet-5')
    const { body } = await readConfig()
    expect(body.providers.anthropic.defaultModel).toBe('claude-sonnet-5')
  })

  it('GROQ_API_KEY unlocks BOTH the groq brain and hosted STT (one key, two capabilities)', async () => {
    clearKeys()
    vi.stubEnv('GROQ_API_KEY', 'gsk-fake')
    const { body } = await readConfig()

    expect(body.providers.groq.available).toBe(true)
    expect(body.providers.groq.defaultModel).toBe('llama-3.3-70b-versatile')
    expect(body.stt.groq).toBe(true)
    expect(body.stt.openai).toBe(false)
    expect(body.tts.openai).toBe(false)
    // No higher-priority brain, so groq is the default.
    expect(body.defaultProvider).toBe('groq')
  })

  it('OPENAI_API_KEY unlocks hosted STT + TTS but no chat brain', async () => {
    clearKeys()
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-fake')
    const { body } = await readConfig()

    expect(body.stt.openai).toBe(true)
    expect(body.tts.openai).toBe(true)
    // OpenAI is not a registered chat brain here.
    expect(body.providers.anthropic.available).toBe(false)
    expect(body.defaultProvider).toBeNull()
  })

  it('removing a key flips the corresponding boolean back off', async () => {
    clearKeys()
    vi.stubEnv('GROQ_API_KEY', 'gsk-fake')
    let out = await readConfig()
    expect(out.body.stt.groq).toBe(true)
    expect(out.body.providers.groq.available).toBe(true)

    vi.stubEnv('GROQ_API_KEY', '')
    out = await readConfig()
    expect(out.body.stt.groq).toBe(false)
    expect(out.body.providers.groq.available).toBe(false)
  })

  it('never leaks secret material (no sk-/key-like substrings) in the response', async () => {
    clearKeys()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-super-secret-abc123')
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-super-secret-def456')
    vi.stubEnv('GROQ_API_KEY', 'gsk-super-secret-ghi789')
    const { text } = await readConfig()

    expect(text).not.toContain('sk-')
    expect(text).not.toContain('gsk-')
    expect(text).not.toContain('super-secret')
  })
})
