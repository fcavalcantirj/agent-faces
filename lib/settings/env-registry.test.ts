import { describe, it, expect } from 'vitest'
import { ENV_REGISTRY, specFor, type EnvVarSpec } from './env-registry'

const names = () => ENV_REGISTRY.map((s) => s.name)

describe('ENV_REGISTRY', () => {
  it('lists the full curated contract in tier order (used-first rendering sorts at view time)', () => {
    expect(names()).toEqual([
      // Tier 1 — the keys/wires that matter
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'OPENAI_API_KEY',
      'AGENT_BRIDGE_KIND',
      'AGENT_BRIDGE_URL',
      'AGENT_BRIDGE_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      // Tier 2 — tuning knobs
      'ANTHROPIC_DEFAULT_MODEL',
      'OPENROUTER_DEFAULT_MODEL',
      'GROQ_DEFAULT_MODEL',
      'AGENT_BRIDGE_MODEL',
      'OPENAI_TRANSCRIBE_MODEL',
      'OPENAI_TRANSCRIBE_LANGUAGE',
      'OPENAI_TRANSCRIBE_PROMPT',
      'OPENAI_TTS_MODEL',
      'OPENAI_TTS_VOICE',
      'OPENAI_TTS_FORMAT',
      // Tier 3 — aliases
      'HERMES_API_BASE_URL',
      'HERMES_API_KEY',
      // Deploy gates — read-only display
      'SELF_HOST',
      'ALLOW_AGENT_BRIDGE_IN_PROD',
      'FACE_SETTINGS_ALLOW_REMOTE',
    ])
  })

  it('names are unique and env-var shaped', () => {
    expect(new Set(names()).size).toBe(names().length)
    for (const n of names()) expect(n).toMatch(/^[A-Z][A-Z0-9_]{1,63}$/)
  })

  it('tiers are monotonic non-decreasing in registry order', () => {
    const tiers = ENV_REGISTRY.map((s) => s.tier)
    for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1])
  })

  it('every key/token is secret (write-only); knobs and URLs are not', () => {
    const secret = ENV_REGISTRY.filter((s) => s.secret).map((s) => s.name)
    expect(secret.sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'OPENROUTER_API_KEY',
        'GROQ_API_KEY',
        'OPENAI_API_KEY',
        'AGENT_BRIDGE_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'HERMES_API_KEY',
      ].sort(),
    )
    expect(specFor('AGENT_BRIDGE_URL')?.secret).toBe(false)
    expect(specFor('OPENAI_TTS_VOICE')?.secret).toBe(false)
  })

  it('deploy gates are read-only; nothing else is', () => {
    const ro = ENV_REGISTRY.filter((s) => s.readOnly).map((s) => s.name)
    expect(ro.sort()).toEqual(
      ['SELF_HOST', 'ALLOW_AGENT_BRIDGE_IN_PROD', 'FACE_SETTINGS_ALLOW_REMOTE'].sort(),
    )
  })

  it('the lock and the bridge-process vars are NOT in the registry', () => {
    for (const absent of [
      'FACE_SETTINGS_PASSWORD_HASH',
      'CLAUDE_BRIDGE_PORT',
      'CLAUDE_BRIDGE_TOKEN',
      'CLAUDE_BRIDGE_PERMISSION_MODE',
      'VERCEL',
      'VERCEL_ENV',
    ]) {
      expect(specFor(absent), `${absent} must be excluded`).toBeUndefined()
    }
    // Categorical NEXT_PUBLIC_ ban documented in code.
    expect(names().some((n) => n.startsWith('NEXT_PUBLIC_'))).toBe(false)
  })

  it('CLAUDE_CODE_OAUTH_TOKEN is the only bridge-restart var and carries the setup-token help', () => {
    const bridgeVars = ENV_REGISTRY.filter((s) => s.restartTarget === 'bridge')
    expect(bridgeVars.map((s) => s.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
    const spec = specFor('CLAUDE_CODE_OAUTH_TOKEN')!
    expect(spec.help?.join(' ')).toMatch(/claude setup-token/)
    expect(spec.help?.join(' ')).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('AGENT_BRIDGE_KIND enum matches the launcher contract', () => {
    expect(specFor('AGENT_BRIDGE_KIND')?.enum).toEqual([
      'hermes',
      'openclaw',
      'claude-code',
      'ollama',
      'openai-compatible',
    ])
  })

  it('OPENAI_TTS_FORMAT enum matches lib/tts/hosted.ts formats', () => {
    expect(specFor('OPENAI_TTS_FORMAT')?.enum).toEqual(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])
  })

  it('URL vars validate and declare their paired secret', () => {
    const url = specFor('AGENT_BRIDGE_URL')!
    expect(url.pairedKey).toBe('AGENT_BRIDGE_KEY')
    expect(url.validate?.('not a url')).toBeTruthy()
    expect(url.validate?.('http://127.0.0.1:8787')).toBeNull()
    const hermes = specFor('HERMES_API_BASE_URL')!
    expect(hermes.pairedKey).toBe('HERMES_API_KEY')
    expect(hermes.validate?.('https://pi.tail.ts.net')).toBeNull()
  })

  it('every editable var has a label; every tier-1 key row has help or a docs link', () => {
    for (const s of ENV_REGISTRY) expect(s.label, s.name).toBeTruthy()
    for (const s of ENV_REGISTRY.filter((x) => x.tier === 1 && x.secret)) {
      expect(Boolean(s.docsUrl || s.help?.length), `${s.name} needs how-to-get-this`).toBe(true)
    }
  })

  it('specFor is a total lookup over the registry', () => {
    for (const s of ENV_REGISTRY) expect(specFor(s.name)).toBe(s as EnvVarSpec)
    expect(specFor('NOPE_NOT_A_VAR')).toBeUndefined()
  })
})
