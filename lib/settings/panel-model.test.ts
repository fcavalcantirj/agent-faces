import { describe, it, expect } from 'vitest'
import {
  AGENT_BRIDGE_ID,
  brainOptions,
  faceSkinOptions,
  hasNoBrain,
  resolveActiveProvider,
  selectableBrains,
  serverEnvRows,
  sttModeOptions,
  ttsEngineOptions,
  type AppConfig,
} from './panel-model'
import { ENV_REGISTRY } from './env-registry'
import {
  createConversationStore,
  DEFAULT_FACE_SKIN,
  DEFAULT_STT_MODE,
  DEFAULT_TTS_ENGINE,
  type StorageLike,
} from '@/lib/conversation'

// --- Fixtures ---------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    providers: {
      anthropic: { available: false, label: 'Anthropic', mode: 'A' },
      openrouter: { available: false, label: 'OpenRouter', mode: 'A' },
      groq: { available: false, label: 'Groq', mode: 'A' },
    },
    agentBridge: { available: false },
    stt: { groq: false, openai: false },
    tts: { openai: false },
    defaultProvider: null,
    ...overrides,
  }
}

/** In-memory storage double for the conversation store. */
function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

// --- Brain options ----------------------------------------------------------

describe('brainOptions', () => {
  it('lists every Mode A provider, marking unavailable ones disabled with a hint', () => {
    const opts = brainOptions(makeConfig())
    expect(opts.map((o) => o.id)).toEqual(['anthropic', 'openrouter', 'groq'])
    for (const o of opts) {
      expect(o.available).toBe(false)
      expect(o.disabledReason).toMatch(/_API_KEY/)
      expect(o.isAgentBridge).toBe(false)
    }
  })

  it('hides the agent-bridge entirely when it is not reachable', () => {
    const opts = brainOptions(makeConfig({ agentBridge: { available: false } }))
    expect(opts.some((o) => o.id === AGENT_BRIDGE_ID)).toBe(false)
  })

  it('shows the agent-bridge only when reachable (Verify: hidden when unreachable)', () => {
    const opts = brainOptions(makeConfig({ agentBridge: { available: true } }))
    const bridge = opts.find((o) => o.id === AGENT_BRIDGE_ID)
    expect(bridge).toBeTruthy()
    expect(bridge!.available).toBe(true)
    expect(bridge!.mode).toBe('B')
    expect(bridge!.isAgentBridge).toBe(true)
  })

  it('marks an available provider selectable with no disabled reason', () => {
    const config = makeConfig({
      providers: {
        anthropic: {
          available: true,
          label: 'Anthropic',
          mode: 'A',
          defaultModel: 'claude-opus-4-8',
        },
      },
      defaultProvider: 'anthropic',
    })
    const opts = brainOptions(config)
    expect(opts).toHaveLength(1)
    expect(opts[0]).toMatchObject({ id: 'anthropic', available: true })
    expect(opts[0].disabledReason).toBeUndefined()
    expect(selectableBrains(config).map((b) => b.id)).toEqual(['anthropic'])
  })
})

describe('hasNoBrain', () => {
  it('is true when no brain is available and false once one is', () => {
    expect(hasNoBrain(makeConfig())).toBe(true)
    expect(
      hasNoBrain(
        makeConfig({
          providers: { groq: { available: true, label: 'Groq', mode: 'A' } },
        }),
      ),
    ).toBe(false)
  })
})

// --- Active-provider resolution --------------------------------------------

describe('resolveActiveProvider', () => {
  const config = makeConfig({
    providers: {
      anthropic: { available: false, label: 'Anthropic', mode: 'A' },
      groq: { available: true, label: 'Groq', mode: 'A' },
      openrouter: { available: true, label: 'OpenRouter', mode: 'A' },
    },
    defaultProvider: 'groq',
  })

  it('keeps a still-available selection', () => {
    expect(resolveActiveProvider('openrouter', config)).toBe('openrouter')
  })

  it('falls back to the server default when the selection is unavailable', () => {
    expect(resolveActiveProvider('anthropic', config)).toBe('groq')
  })

  it('falls back to the first available brain when nothing else fits', () => {
    const noDefault = makeConfig({
      providers: { openrouter: { available: true, label: 'OpenRouter', mode: 'A' } },
      defaultProvider: null,
    })
    expect(resolveActiveProvider('gone', noDefault)).toBe('openrouter')
  })

  it('returns null when no brain is available', () => {
    expect(resolveActiveProvider('anything', makeConfig())).toBeNull()
  })
})

// --- STT / TTS / skin availability -----------------------------------------

describe('sttModeOptions', () => {
  it('always offers browser + auto and gates hosted on a key', () => {
    const off = sttModeOptions(makeConfig())
    const hosted = off.find((o) => o.value === 'hosted')!
    expect(off.find((o) => o.value === 'browser')!.available).toBe(true)
    expect(off.find((o) => o.value === 'auto')!.available).toBe(true)
    expect(hosted.available).toBe(false)
    expect(hosted.reason).toMatch(/GROQ_API_KEY|OPENAI_API_KEY/)

    const withGroq = sttModeOptions(makeConfig({ stt: { groq: true, openai: false } }))
    expect(withGroq.find((o) => o.value === 'hosted')!.available).toBe(true)
  })
})

describe('ttsEngineOptions', () => {
  it('always offers web-speech + kokoro and gates openai on a key', () => {
    const off = ttsEngineOptions(makeConfig())
    expect(off.find((o) => o.value === 'web-speech')!.available).toBe(true)
    expect(off.find((o) => o.value === 'kokoro')!.available).toBe(true)
    expect(off.find((o) => o.value === 'openai')!.available).toBe(false)

    const on = ttsEngineOptions(makeConfig({ tts: { openai: true } }))
    expect(on.find((o) => o.value === 'openai')!.available).toBe(true)
  })
})

describe('faceSkinOptions', () => {
  it('offers both skins as selectable (talkinghead degrades at runtime)', () => {
    const opts = faceSkinOptions()
    expect(opts.map((o) => o.value)).toEqual(['eidolon', 'talkinghead'])
    expect(opts.every((o) => o.available)).toBe(true)
  })
})

// --- Conversation-store settings round-trip ---------------------------------

describe('conversation settings (voice / STT / skin)', () => {
  it('defaults the new settings sensibly', () => {
    const store = createConversationStore({ storage: null })
    expect(store.getState().settings).toMatchObject({
      sttMode: DEFAULT_STT_MODE,
      ttsEngine: DEFAULT_TTS_ENGINE,
      faceSkin: DEFAULT_FACE_SKIN,
    })
    expect(DEFAULT_STT_MODE).toBe('auto')
    expect(DEFAULT_TTS_ENGINE).toBe('web-speech')
    expect(DEFAULT_FACE_SKIN).toBe('eidolon')
  })

  it('persists STT mode / TTS engine / face skin and restores them on reload', () => {
    const storage = memStorage()
    const store = createConversationStore({ storage })
    store.setSttMode('hosted')
    store.setTtsEngine('openai')
    store.setFaceSkin('talkinghead')

    // A fresh store over the SAME storage = a page reload.
    const restored = createConversationStore({ storage })
    expect(restored.getState().settings).toMatchObject({
      sttMode: 'hosted',
      ttsEngine: 'openai',
      faceSkin: 'talkinghead',
    })
  })

  it('keeps settings through reset (only the transcript is cleared)', () => {
    const store = createConversationStore({ storage: memStorage() })
    store.setTtsEngine('kokoro')
    store.addUserTurn('hello')
    store.reset()
    expect(store.getState().turns).toHaveLength(0)
    expect(store.getState().settings.ttsEngine).toBe('kokoro')
  })

  it('coerces garbage persisted values back to defaults', () => {
    const storage = memStorage()
    storage.setItem(
      'agent-face:conversation:v1',
      JSON.stringify({
        version: 1,
        turns: [],
        system: 'x',
        settings: {
          provider: null,
          model: null,
          inputMode: 'nonsense',
          sttMode: 'nonsense',
          ttsEngine: 'nonsense',
          faceSkin: 'nonsense',
        },
      }),
    )
    const store = createConversationStore({ storage })
    expect(store.getState().settings).toMatchObject({
      sttMode: 'auto',
      ttsEngine: 'web-speech',
      faceSkin: 'eidolon',
    })
  })
})

describe('serverEnvRows (used-first ordering for the SERVER ENV view)', () => {
  const state = (set: string[]) =>
    Object.fromEntries(ENV_REGISTRY.map((s) => [s.name, { set: set.includes(s.name) }]))

  it('leads with the SET vars in registry order, then the unset tier-1 rows', () => {
    const rows = serverEnvRows(state(['OPENAI_API_KEY', 'AGENT_BRIDGE_KIND', 'OPENAI_TTS_VOICE']))
    const primary = rows.primary.map((s) => s.name)
    // Set vars first (registry order preserved) — including a tier-2 knob in use.
    expect(primary.slice(0, 3)).toEqual(['OPENAI_API_KEY', 'AGENT_BRIDGE_KIND', 'OPENAI_TTS_VOICE'])
    // Then every unset tier-1 row, still in registry order.
    expect(primary.slice(3)).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'AGENT_BRIDGE_URL',
      'AGENT_BRIDGE_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ])
    // The SHOW ALL bucket holds the remaining unset editables only.
    expect(rows.more.every((s) => s.tier > 1 && !s.readOnly)).toBe(true)
    expect(rows.more.map((s) => s.name)).not.toContain('OPENAI_TTS_VOICE')
    // Deploy gates ride separately, read-only.
    expect(rows.deploy.map((s) => s.name)).toEqual([
      'SELF_HOST',
      'ALLOW_AGENT_BRIDGE_IN_PROD',
      'FACE_SETTINGS_ALLOW_REMOTE',
    ])
  })

  it('a fresh install (nothing set) shows exactly the tier-1 rows first', () => {
    const rows = serverEnvRows(state([]))
    expect(rows.primary.map((s) => s.name)).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'OPENAI_API_KEY',
      'AGENT_BRIDGE_KIND',
      'AGENT_BRIDGE_URL',
      'AGENT_BRIDGE_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ])
  })

  it('tolerates a missing vars map (pre-fetch render)', () => {
    const rows = serverEnvRows(undefined)
    expect(rows.primary.length).toBeGreaterThan(0)
    expect(rows.deploy.length).toBe(3)
  })
})
