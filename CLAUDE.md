# CLAUDE.md — agent-faces

Guidelines for any agent (human or Ralph loop) building **agent-faces**. This file is
injected into every Ralph iteration alongside `README.md`, `prd.json`, and `progress.txt`.

## What this project is

**Agent Faces** gives an AI agent a talking, animated, lip-syncing **face**. You speak →
[OpenAI Whisper](https://github.com/openai/whisper) transcribes → a pluggable **brain**
replies → the reply is spoken back and drives a 12-emotion particle face. It ships as a
**portable Agent Skill** (`skill/agent-face/`) + a **Next.js web app**, runnable on localhost
and deployable to **Vercel or self-host**. Full vision + architecture: **`README.md`**.

Two brain modes behind one `/api/chat` seam:
- **Mode A — fresh API:** Anthropic, OpenRouter (→ Hermes + many), Groq (fast).
- **Mode B — bring-your-own running agent:** an agent-bridge to Hermes `api_server`,
  openclaw/nanoclaw, a local Claude Code bridge, or Ollama — reusing that agent's memory/tools.

Face = the reused **EIDOLON** particle renderer (12 emotions) with real audio-driven lip-sync
(`wawa-lipsync`). Voice = browser Whisper (WebGPU) + hosted fallback; Web Speech / OpenAI TTS.

## Golden rules (MUST follow)

- **Build the real thing** — no mocks, no stubs, no placeholders for real logic.
- **TDD where there's a runtime surface** — write a failing test first, then implement
  (RED → GREEN → REFACTOR). Docs/infra tasks may have no test; use judgment.
- **Keep files focused** — ~500 lines max; split if larger. `SKILL.md` **must** stay ≤ 500 lines.
- **Secrets are server-side only** — never `NEXT_PUBLIC_*`; all provider keys live in route handlers.
- **Reuse, don't reinvent** — the EIDOLON particle-face source is vendored at
  **`reference/fugu-face/`**; port from there. The original lives at `../fuguFaces`
  on Felipe's machine — never modify it.
- **Match the stack** — Next.js 16 (App Router), React 19, TypeScript, **npm**. Kill any
  previous dev server before starting a new one.
- **Frontmatter name rule** — the skill's `SKILL.md` `name:` must NOT contain `claude` or
  `anthropic` (reserved). Use `name: agent-face`. The repo/brand is still "Agent Faces".

## The task ledger — `prd.json`

`prd.json` is a **bare JSON array**; each task is `{category, description, steps[], passes}`:
- `category` ∈ `backend | frontend | docs | skill | infra`.
- `description` — one-line title; a `🚨 URGENT:` prefix means do it first.
- `steps` — imperative checklist; the LAST steps are `Verify:` lines (how to prove it works).
  Dependencies appear as prose: `DEPENDS ON:` / `PREREQUISITE:`.
- `passes` — `false` until done; flip to `true` when the task's `Verify:` steps pass.

Work top-to-bottom (order encodes priority and satisfies dependencies), one task per run.

## The Ralph build loop

`prd.json` is built autonomously by the Ralph loop. Each iteration does exactly one task
(TDD-first), runs that task's own `Verify:` steps, flips `passes:true`, journals to
`progress.txt`, commits, and (by default) pushes — then STOPS.

```bash
./progress.sh              # 0/58 (0%) → 58/58 (100%)
./ralph.sh 1               # do one task
./ralph.sh 5               # do up to five
./ralph-continuous.sh      # batches of 3, pauses, backoff, Telegram — until 100% or Ctrl+C
```

Env toggles: `PRD_FILE` (default `prd.json`), `RALPH_PUSH=0` (commit only, no push),
`MODEL=<id>` (pin a model), `BATCH_SIZE`, `BATCH_PAUSE_MINS`, `WAIT_TIME_MINS`,
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`.

**Safety:** Ralph runs Claude Code with `--dangerously-skip-permissions` and, by default,
auto-`git push` on every task to a public repo. Use `RALPH_PUSH=0`, a branch, or a private
mirror if you don't want unattended public pushes. Cost/context is reported, not capped.

## Verifying in a headless / overnight run

You run **unattended, headless, with no human and no browser.** Each task carries a **`headless_verifiable`** boolean: `true` = you can fully verify it headlessly; `false` = confirming it truly works needs a human UAT pass (browser / mic / audible playback / live paid key / running external agent / Docker run / deploy). **Never change this flag** — it's a fixed label. After the run, `./uat.sh` lists every `false` task for the human. Before flipping a task to `passes: true`:

- **Run every headless check the task lists** — `npm run typecheck`, `npm run build`, unit/integration tests, `grep`/file assertions. These GATE the task. If a check you *can* run is failing, the task is NOT done — fix it.
- **Set up the test runner (`vitest`) the first time a task needs it** if it isn't installed yet (add the dep + `vitest.config.ts` + a `test` script). Don't wait for the later harness task.
- **Some `Verify:` steps you physically cannot run headlessly** — they need a browser, microphone, audible playback, WebGPU, a live/paid API key, a running external agent (Ollama/Hermes), a Docker daemon, network toggling ("airplane mode"), or a human click. For each: implement to spec, write a **mock-based** headless test where feasible (mock the SSE transport / audio / AnalyserNode / `/api/config`), make all runnable checks pass, then append a `UAT:` line to `progress.txt` naming what a human must still confirm — **and still mark the task `passes: true`** so the run can reach 100%.
- **If you edit root app files after `skill/agent-face/assets/app-template/` exists**, re-run `node skill/agent-face/scripts/sync-template.mjs` in the same task so the CI parity check stays green.
- **Never fabricate.** "Deferred to UAT" is honest; claiming you verified something in a browser you never opened is not.
