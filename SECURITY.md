# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/fcavalcantirj/agent-faces/security/advisories/new)
— do not open a public issue for security problems.

You should hear back within a week. Please include reproduction steps and the
commit/version you tested.

## Scope notes

- **Provider keys are server-side only.** No `NEXT_PUBLIC_*` secrets exist by design;
  `/api/*` route handlers hold all keys. A key reaching the browser is a vulnerability —
  report it.
- **The agent bridge (`bridge/`) is a localhost-only, personal-use component.** It binds
  `127.0.0.1`, ships outside the app template on purpose, and refuses to start with
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` set. Reports that assume it is exposed to the
  public internet are out of scope; reports that show it can be *made* to expose itself are
  very much in scope.
