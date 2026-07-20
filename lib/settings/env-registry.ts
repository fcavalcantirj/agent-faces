// The curated server-env registry — the single source of truth for which
// variables the SERVER ENV editor may show and write, in what order, with what
// semantics. Pure data + tiny lookups: importable from BOTH the client (labels,
// ordering, help) and the server (allowlist, validation). Never holds values.
//
// Deliberate exclusions (security review, 2026-07-20):
//   • FACE_SETTINGS_PASSWORD_HASH — the lock is never editable through the door
//     it locks; rotation is launcher/CLI-only.
//   • CLAUDE_BRIDGE_* — the bridge process reads its env at ITS start from the
//     launcher's environment, never from .env.local; offering them here would
//     be a write that can't take effect.
//   • VERCEL* — platform-injected.
//   • NEXT_PUBLIC_* — categorically banned: anything with that prefix ships to
//     the browser (docs/env-contract.md security rule).

export interface EnvVarSpec {
  /** Exact environment variable name. */
  name: string
  /** 1 = the keys/wires that matter, 2 = tuning knobs, 3 = aliases, 4 = gates. */
  tier: 1 | 2 | 3 | 4
  group: 'keys' | 'tuning' | 'aliases' | 'deploy'
  label: string
  /** Write-only: the API never returns this var's value, only set/not-set. */
  secret: boolean
  /** Displayed but never writable via the GUI (deploy posture is launch-time). */
  readOnly?: boolean
  /** 'app' = live on the next request; 'bridge' = needs a launcher restart. */
  restartTarget: 'app' | 'bridge'
  /** Expandable how-to-get-this lines rendered under the row. */
  help?: string[]
  /** Provider console link (top-level pages only). */
  docsUrl?: string
  /** Allowed values (renders as a select; enforced server-side). */
  enum?: string[]
  /** Returns an error message for a bad value, or null when acceptable. */
  validate?: (value: string) => string | null
  /** Changing THIS var clears the named secret unless a new one rides along. */
  pairedKey?: string
}

const urlValidator = (value: string): string | null => {
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'Must be an http:// or https:// URL.'
    }
    return null
  } catch {
    return 'Must be a valid URL (e.g. http://127.0.0.1:8787).'
  }
}

export const ENV_REGISTRY: readonly EnvVarSpec[] = [
  // --- Tier 1: keys & wires --------------------------------------------------
  {
    name: 'ANTHROPIC_API_KEY',
    tier: 1,
    group: 'keys',
    label: 'Anthropic API key (Claude chat brain)',
    secret: true,
    restartTarget: 'app',
    docsUrl: 'https://console.anthropic.com/',
    help: ['Create a key in the Anthropic Console (Settings → API keys).'],
  },
  {
    name: 'OPENROUTER_API_KEY',
    tier: 1,
    group: 'keys',
    label: 'OpenRouter API key (Hermes + hundreds of models)',
    secret: true,
    restartTarget: 'app',
    docsUrl: 'https://openrouter.ai/keys',
    help: ['Create a key at openrouter.ai/keys.'],
  },
  {
    name: 'GROQ_API_KEY',
    tier: 1,
    group: 'keys',
    label: 'Groq API key (chat + fast hosted Whisper STT)',
    secret: true,
    restartTarget: 'app',
    docsUrl: 'https://console.groq.com/keys',
    help: ['Create a key at console.groq.com/keys. One key unlocks BOTH the Groq chat brain and fast hosted speech-to-text.'],
  },
  {
    name: 'OPENAI_API_KEY',
    tier: 1,
    group: 'keys',
    label: 'OpenAI API key (hosted Whisper STT + TTS voice-out)',
    secret: true,
    restartTarget: 'app',
    docsUrl: 'https://platform.openai.com/api-keys',
    help: ['Create a key at platform.openai.com/api-keys. Used for speech-to-text fallback and the gpt-4o-mini-tts voice.'],
  },
  {
    name: 'AGENT_BRIDGE_KIND',
    tier: 1,
    group: 'keys',
    label: 'Agent bridge kind (Mode B: your running agent)',
    secret: false,
    restartTarget: 'app',
    enum: ['hermes', 'openclaw', 'claude-code', 'ollama', 'openai-compatible'],
  },
  {
    name: 'AGENT_BRIDGE_URL',
    tier: 1,
    group: 'keys',
    label: 'Agent bridge URL',
    secret: false,
    restartTarget: 'app',
    validate: urlValidator,
    pairedKey: 'AGENT_BRIDGE_KEY',
  },
  {
    name: 'AGENT_BRIDGE_KEY',
    tier: 1,
    group: 'keys',
    label: 'Agent bridge auth key',
    secret: true,
    restartTarget: 'app',
    help: ['The bearer token your running agent expects (e.g. CLAUDE_BRIDGE_TOKEN on the local bridge, or your Hermes api_server key).'],
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    tier: 1,
    group: 'keys',
    label: 'Claude Code subscription token (bridge auth)',
    secret: true,
    restartTarget: 'bridge',
    help: [
      'On the machine that runs the bridge, run: claude setup-token',
      'Complete the browser login with your Claude subscription account.',
      'Paste the printed token here — the launcher forwards it to the bridge.',
      'Applies after a launcher restart (the bridge reads its env at start).',
      'Never also set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN for the bridge: it refuses to start rather than silently bill your conversations as metered API usage.',
    ],
  },
  // --- Tier 2: tuning knobs --------------------------------------------------
  {
    name: 'ANTHROPIC_DEFAULT_MODEL',
    tier: 2,
    group: 'tuning',
    label: 'Anthropic default model',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENROUTER_DEFAULT_MODEL',
    tier: 2,
    group: 'tuning',
    label: 'OpenRouter default model',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'GROQ_DEFAULT_MODEL',
    tier: 2,
    group: 'tuning',
    label: 'Groq default model',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'AGENT_BRIDGE_MODEL',
    tier: 2,
    group: 'tuning',
    label: 'Agent bridge model/thread',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENAI_TRANSCRIBE_MODEL',
    tier: 2,
    group: 'tuning',
    label: 'OpenAI transcription model (default whisper-1)',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENAI_TRANSCRIBE_LANGUAGE',
    tier: 2,
    group: 'tuning',
    label: 'Force STT language (ISO-639-1; blank = auto)',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENAI_TRANSCRIBE_PROMPT',
    tier: 2,
    group: 'tuning',
    label: 'STT vocabulary/style bias prompt',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENAI_TTS_MODEL',
    tier: 2,
    group: 'tuning',
    label: 'OpenAI TTS model (default gpt-4o-mini-tts)',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENAI_TTS_VOICE',
    tier: 2,
    group: 'tuning',
    label: 'OpenAI TTS voice (default alloy)',
    secret: false,
    restartTarget: 'app',
  },
  {
    name: 'OPENAI_TTS_FORMAT',
    tier: 2,
    group: 'tuning',
    label: 'OpenAI TTS audio format (default mp3)',
    secret: false,
    restartTarget: 'app',
    enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
  },
  // --- Tier 3: aliases -------------------------------------------------------
  {
    name: 'HERMES_API_BASE_URL',
    tier: 3,
    group: 'aliases',
    label: 'Hermes api_server URL (alias — implies kind hermes)',
    secret: false,
    restartTarget: 'app',
    validate: urlValidator,
    pairedKey: 'HERMES_API_KEY',
  },
  {
    name: 'HERMES_API_KEY',
    tier: 3,
    group: 'aliases',
    label: 'Hermes api_server key (alias)',
    secret: true,
    restartTarget: 'app',
  },
  // --- Deploy gates: read-only display --------------------------------------
  {
    name: 'SELF_HOST',
    tier: 4,
    group: 'deploy',
    label: 'Self-host mode (deploy-time)',
    secret: false,
    readOnly: true,
    restartTarget: 'app',
  },
  {
    name: 'ALLOW_AGENT_BRIDGE_IN_PROD',
    tier: 4,
    group: 'deploy',
    label: 'Allow non-public bridge URL in production (deploy-time)',
    secret: false,
    readOnly: true,
    restartTarget: 'app',
  },
  {
    name: 'FACE_SETTINGS_ALLOW_REMOTE',
    tier: 4,
    group: 'deploy',
    label: 'Allow settings writes from remote HTTPS origins (deploy-time)',
    secret: false,
    readOnly: true,
    restartTarget: 'app',
  },
]

const BY_NAME = new Map(ENV_REGISTRY.map((s) => [s.name, s]))

export function specFor(name: string): EnvVarSpec | undefined {
  return BY_NAME.get(name)
}
