// start.test.ts — headless coverage for the one-command stack launcher.
//
// The full behavior (bridge subprocess + next dev + a browser opening + a
// spoken conversation) needs a human and is UAT. What we verify headlessly is
// the decision logic: argument parsing, the metered-key scrub for the bridge
// child env, and the .env.local wiring transform (append ONLY what is missing,
// never touch existing values) — plus the CLI contract (--help, bad args).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildBridgeEnv, ensureEnvLocalLines, parseStartArgs } from "./start.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const START = join(HERE, "start.mjs");

function runStart(args: string[]) {
  return spawnSync("node", [START, ...args], { encoding: "utf8" });
}

describe("parseStartArgs", () => {
  it("defaults: port 3000, bridge port 8787, bridge auto, open browser", () => {
    const a = parseStartArgs([]);
    expect(a).toMatchObject({
      port: 3000,
      bridgePort: 8787,
      bridge: true,
      yolo: false,
      open: true,
      stop: false,
      help: false,
    });
  });

  it("parses the full flag set", () => {
    const a = parseStartArgs([
      "--port", "3100", "--bridge-port", "9000", "--yolo", "--no-bridge", "--no-open", "--stop",
    ]);
    expect(a).toMatchObject({
      port: 3100,
      bridgePort: 9000,
      bridge: false,
      yolo: true,
      open: false,
      stop: true,
    });
  });

  it("rejects unknown flags and junk ports", () => {
    expect(() => parseStartArgs(["--bogus"])).toThrow(/unknown/i);
    expect(() => parseStartArgs(["--port", "banana"])).toThrow(/port/i);
  });
});

describe("buildBridgeEnv", () => {
  it("SCRUBS metered credentials so the bridge guard never trips", () => {
    const env = buildBridgeEnv(
      { PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "t", HOME: "/h" },
      { yolo: false },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.CLAUDE_BRIDGE_PERMISSION_MODE).toBeUndefined();
  });

  it("--yolo sets bypassPermissions on the child only", () => {
    const env = buildBridgeEnv({ PATH: "/bin" }, { yolo: true });
    expect(env.CLAUDE_BRIDGE_PERMISSION_MODE).toBe("bypassPermissions");
  });
});

describe("ensureEnvLocalLines", () => {
  it("appends BOTH bridge lines to an empty file and reports them", () => {
    const r = ensureEnvLocalLines("", 8787);
    expect(r.added).toEqual(["AGENT_BRIDGE_KIND=claude-code", "AGENT_BRIDGE_URL=http://127.0.0.1:8787"]);
    expect(r.content).toContain("AGENT_BRIDGE_KIND=claude-code");
    expect(r.content).toContain("AGENT_BRIDGE_URL=http://127.0.0.1:8787");
  });

  it("NEVER touches an existing value (a hermes user stays a hermes user)", () => {
    const existing = "AGENT_BRIDGE_KIND=hermes\nAGENT_BRIDGE_URL=http://10.0.0.5:9099\n";
    const r = ensureEnvLocalLines(existing, 8787);
    expect(r.added).toEqual([]);
    expect(r.content).toBe(existing);
  });

  it("appends only what is missing", () => {
    const r = ensureEnvLocalLines("AGENT_BRIDGE_KIND=claude-code\n", 8787);
    expect(r.added).toEqual(["AGENT_BRIDGE_URL=http://127.0.0.1:8787"]);
    expect(r.content).toContain("AGENT_BRIDGE_KIND=claude-code");
  });

  it("a commented-out line does not count as configured", () => {
    const r = ensureEnvLocalLines("# AGENT_BRIDGE_KIND=hermes\n", 8787);
    expect(r.added).toContain("AGENT_BRIDGE_KIND=claude-code");
  });
});

describe("start.mjs CLI contract", () => {
  it("--help exits 0 and documents the one-command behavior", () => {
    const r = runStart(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/bridge/i);
    expect(r.stdout).toMatch(/--stop/);
    expect(r.stdout).toMatch(/--yolo/);
  });

  it("an unknown flag exits non-zero with the usage", () => {
    const r = runStart(["--nonsense"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unknown/i);
  });
});
