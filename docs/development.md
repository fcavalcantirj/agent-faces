# Development guide

How the **Agent Faces** repo is laid out and where different kinds of work belong. Read this
before your first change; for setup, scripts, style, and the PR workflow see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## Repo layout

```
claude-faces/
├── app/                      # Next.js 16 App Router
│   ├── layout.tsx, page.tsx  # shell + the orchestrated face UI
│   ├── globals.css
│   └── api/                  # server routes (all secrets live here)
│       ├── chat/             # streaming brain seam (/api/chat)
│       ├── config/           # capability probe (which brains/STT/TTS are on)
│       ├── transcribe/       # hosted STT fallback (Groq / OpenAI)
│       ├── tts/              # streaming gpt-4o-mini-tts voice-out
│       └── models/           # proxied listModels() for the picker
├── components/               # React UI (face renderer, HUD, settings, status)
│   └── skins/                # swappable FaceSkin renderers (eidolon, talkinghead)
├── lib/                      # framework-light app logic (mostly unit-tested)
│   ├── providers/            # ChatAdapter seam + anthropic/openrouter/groq/agent-bridge
│   ├── audio/                # shared AudioContext, recorder, VAD
│   ├── stt/                  # in-browser Whisper worker + auto-selection
│   ├── tts/                  # web-speech / openai / kokoro engines + router
│   ├── face/                 # skin interface, visemes, emotion state machine
│   ├── chat/                 # streaming chat client
│   ├── conversation.ts       # transcript + settings store (localStorage)
│   ├── orchestrator.ts       # the listen→transcribe→chat→speak→lip-sync loop
│   └── *.test.ts             # colocated Vitest specs
├── public/                   # icons, OG image, screenshots, self-hosted model/VAD assets
├── scripts/                  # app build helpers (e.g. setup-vad-assets.mjs)
├── docs/                     # decisions.md, env-contract.md, development.md (this file)
├── reference/fugu-face/      # vendored EIDOLON particle-face source (port FROM here)
├── skill/agent-face/         # the portable Agent Skill (see below)
│   ├── SKILL.md              # thin router (≤ 500 lines)
│   ├── references/*.md       # progressive-disclosure docs (architecture, backends, …)
│   ├── scripts/*.mjs         # harness-agnostic node scripts (scaffold/dev/check-env/deploy/sync)
│   └── assets/app-template/  # SYNCED snapshot of the app (never hand-edit)
├── Dockerfile, docker-compose.yml   # self-host artifacts
├── vercel.json, next.config.mjs     # deploy + build config
└── prd.json                  # the 58-task build plan
```

---

## The boundary: scaffolding vs. app-internals

Two distinct kinds of work live in this repo. Knowing which you're doing tells you what to touch
and what to re-sync.

### App-internals work

Changing how the face **actually behaves** — routes, providers, the renderer, the orchestrator,
STT/TTS, UI. This lives at the **repo root** (`app/`, `components/`, `lib/`, `public/`,
`scripts/`, config files). The root app is the **single source of truth**.

- Write tests first where there's a runtime surface (`lib/**/*.test.ts` via Vitest).
- If your change touches a file the packaged template mirrors, **re-run the template sync in the
  same change** (see below) — otherwise CI's parity check fails.

### Scaffolding work

Changing how the skill **installs, scaffolds, runs, or deploys** the app on an arbitrary
harness — `skill/agent-face/` (`SKILL.md`, `references/*.md`, `scripts/*.mjs`).

- Skill scripts are **harness-agnostic**: plain Node ESM / bash, no Claude-specific tooling, no
  MCP calls, no `allowed-tools`/`tool_use`. The portability CI step greps for exactly these and
  fails on a match.
- `SKILL.md` must stay ≤ 500 lines and its frontmatter `name:` must not contain `claude` or
  `anthropic`.
- `assets/app-template/` is generated, **not authored** — see the next section.

---

## The app template is generated

`skill/agent-face/assets/app-template/` is a self-contained, deployable **snapshot** of the
root app so the skill works when extracted standalone. It is produced by
`skill/agent-face/scripts/sync-template.mjs` from a single manifest that drives both writing and
checking, so the two can never disagree.

```bash
node skill/agent-face/scripts/sync-template.mjs          # regenerate from the root app
node skill/agent-face/scripts/sync-template.mjs --check   # verify parity, exit 1 on drift
```

**Never hand-edit `assets/app-template/`.** Edit the root app, then re-run the sync. CI runs
`--check` and fails on divergence.

---

## Running and testing the skill scripts locally

The four operator scripts run under a plain Node runtime — no harness required:

```bash
node skill/agent-face/scripts/scaffold.mjs --help
node skill/agent-face/scripts/dev.mjs --help
node skill/agent-face/scripts/check-env.mjs --help
node skill/agent-face/scripts/deploy.mjs --help
```

`npm run test:skill` runs the smoke runner that exercises these end-to-end (scaffold into a temp
dir, verify `check-env`'s masking, `deploy` preflight, etc.) and cleans up its temp dirs. Run it
before opening a PR that touches anything under `skill/`.

---

## Before you push

Run the same gate CI does:

```bash
npm run typecheck
npm run lint
npm test
node skill/agent-face/scripts/sync-template.mjs --check
npm run test:skill
```

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the full branch/PR workflow and the CI check
names.
