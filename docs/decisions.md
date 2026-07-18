# Architecture & Tooling Decisions

An append-only log of load-bearing choices made while building **claude-faces**.
Each entry: what was decided, when, and why — so future work (human or Ralph loop)
doesn't re-litigate settled ground.

---

## 2026-07-17 — npm is the canonical package manager

**Decision:** Use **npm** (with the committed `package-lock.json`) as the single
package manager for this repo. Not pnpm, not yarn, not bun.

**Why:**
- **Maximum cross-harness portability.** claude-faces ships as a portable Agent
  Skill that must scaffold and run under many harnesses (Claude Code, Hermes,
  openclaw, trustclaw, nanoclaw) and on many machines. `npm` ships with Node and
  needs no extra install step, so `npm install` / `npm run dev` work everywhere
  Node 22 is present.
- **Deterministic installs.** The committed lockfile pins the exact dependency
  tree for reproducible Vercel and self-host builds.
- **One toolchain in docs and scripts.** The skill scripts, README quick-start,
  and deploy paths all assume `npm`, avoiding "which package manager?" ambiguity.

**How to apply:** All commands, scripts, and docs use `npm`. Do not introduce a
`pnpm-lock.yaml`, `yarn.lock`, or `bun.lockb`. CLAUDE.md's golden rules reinforce
this ("Match the stack … npm").

---

## 2026-07-17 — Node 22 pinned via `.nvmrc`

**Decision:** Pin Node **22** (`.nvmrc`).

**Why:** Next.js 16 requires Node 22+. Pinning keeps local dev, CI, and deploy on
a consistent runtime and avoids "works on my machine" version drift.

**How to apply:** Run `nvm use` before working in the repo; CI and Vercel target
Node 22.
