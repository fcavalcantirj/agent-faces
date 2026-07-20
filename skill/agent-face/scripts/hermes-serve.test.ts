// hermes-serve.test.ts — headless coverage for the Hermes api_server bracket.
//
// Research-pinned facts (NousResearch/hermes-agent docs + source): the
// api_server is an IN-PROCESS gateway platform enabled via env
// (API_SERVER_ENABLED / mandatory API_SERVER_KEY / API_SERVER_PORT, default
// 8642); the no-downtime pattern is a DEDICATED PROFILE gateway
// (`hermes -p <profile> gateway run`) — per-profile pid locks keep the
// user's live gateway untouchable. A real Hermes lives only on the rig
// (dasbrow's Pi); headlessly we verify everything the script owns: parsing,
// command resolution (explicit or documented-default only — never the
// user's default profile), env-line output, and the full process bracket
// driven by a FAKE server command.

import { describe, it, expect } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import {
  envLines,
  parseServeArgs,
  pidfilePath,
  resolveLaunchCommand,
} from "./hermes-serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVE = join(HERE, "hermes-serve.mjs");
// PATH with node but (almost certainly) no `hermes` binary — hermetic default-resolution.
const NODE_ONLY_PATH = dirname(process.execPath) + ":/usr/bin:/bin";

function runServe(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("node", [SERVE, ...args], {
    encoding: "utf8",
    timeout: 20000,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function waitUntil(fn: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe("parseServeArgs", () => {
  it("defaults: Hermes' own 8642, profile 'api', no cmd, not stop", () => {
    expect(parseServeArgs([])).toMatchObject({
      port: 8642,
      profile: "api",
      cmd: null,
      key: null,
      stop: false,
      help: false,
    });
  });

  it("parses --port, --profile, --key, --cmd, --stop", () => {
    const a = parseServeArgs([
      "--port", "9100", "--profile", "face", "--key", "k123", "--cmd", "echo hi", "--stop",
    ]);
    expect(a).toMatchObject({
      port: 9100,
      profile: "face",
      key: "k123",
      cmd: "echo hi",
      stop: true,
    });
  });

  it("rejects junk ports and unknown flags", () => {
    expect(() => parseServeArgs(["--port", "banana"])).toThrow(/port/i);
    expect(() => parseServeArgs(["--bogus"])).toThrow(/unknown/i);
  });
});

describe("resolveLaunchCommand", () => {
  const hermesPresent = () => true;
  const hermesAbsent = () => false;

  it("--cmd wins over everything", () => {
    expect(
      resolveLaunchCommand({
        cmdArg: "run-this",
        env: { HERMES_SERVE_CMD: "not-this" },
        profile: "api",
        hermesExists: hermesPresent,
      }),
    ).toEqual({ source: "flag", command: "run-this" });
  });

  it("falls back to HERMES_SERVE_CMD", () => {
    expect(
      resolveLaunchCommand({
        cmdArg: null,
        env: { HERMES_SERVE_CMD: "env-cmd" },
        profile: "api",
        hermesExists: hermesPresent,
      }),
    ).toEqual({ source: "env", command: "env-cmd" });
  });

  it("with a hermes binary: the documented dedicated-profile gateway run — NEVER the default profile", () => {
    const r = resolveLaunchCommand({
      cmdArg: null,
      env: {},
      profile: "api",
      hermesExists: hermesPresent,
    });
    expect(r).toEqual({ source: "hermes-cli", command: "hermes -p api gateway run" });
    expect(r!.command).toContain("-p "); // the live default-profile gateway must be unreachable from here
  });

  it("no hermes binary, no override: null (fail-fast at the CLI layer)", () => {
    expect(
      resolveLaunchCommand({ cmdArg: null, env: {}, profile: "api", hermesExists: hermesAbsent }),
    ).toBeNull();
  });
});

describe("envLines", () => {
  it("prints the three Mode B lines: kind, base URL, key", () => {
    expect(envLines(8642, "sekret")).toEqual([
      "AGENT_BRIDGE_KIND=hermes",
      "HERMES_API_BASE_URL=http://127.0.0.1:8642",
      "HERMES_API_KEY=sekret",
    ]);
  });
});

describe("hermes-serve CLI contract", () => {
  it("--help exits 0 and names kind=hermes, --cmd, --profile, --stop and the gateway promise", () => {
    const r = runServe(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/hermes/i);
    expect(r.stdout).toMatch(/--cmd/);
    expect(r.stdout).toMatch(/--profile/);
    expect(r.stdout).toMatch(/--stop/);
    expect(r.stdout).toMatch(/gateway/i);
  });

  it("fails fast (exit 2) with no hermes binary and no override, naming --cmd and backends.md", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: NODE_ONLY_PATH };
    delete env.HERMES_SERVE_CMD;
    const r = runServe(["--port", "8643"], { env });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/--cmd/);
    expect(r.stderr + r.stdout).toMatch(/backends\.md/);
  });
});

describe("the bracket, end to end with a fake server", () => {
  it("spawns, waits for health, prints env lines + pidfile; --stop tears it down", async () => {
    const port = await getFreePort();
    const dir = mkdtempSync(join(tmpdir(), "hermes-serve-e2e-"));
    const fake = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`;

    let out = "";
    const serve: ChildProcess = spawn(
      "node",
      [SERVE, "--port", String(port), "--cmd", fake, "--key", "test-key"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
    serve.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    serve.stderr!.on("data", (d: Buffer) => (out += d.toString()));

    try {
      expect(await waitUntil(() => out.includes("HERMES_API_BASE_URL"), 15000)).toBe(true);
      expect(out).toContain("AGENT_BRIDGE_KIND=hermes");
      expect(out).toContain(`HERMES_API_BASE_URL=http://127.0.0.1:${port}`);
      expect(out).toContain("HERMES_API_KEY=test-key");
      expect(await canConnect(port)).toBe(true);
      expect(existsSync(pidfilePath(port, dir))).toBe(true);
      const pid = Number(readFileSync(pidfilePath(port, dir), "utf8").trim());
      expect(pid).toBeGreaterThan(0);

      const stop = runServe(["--stop", "--port", String(port)], { cwd: dir });
      expect(stop.status).toBe(0);
      expect(await waitUntil(async () => !(await canConnect(port)), 8000)).toBe(true);
      expect(existsSync(pidfilePath(port, dir))).toBe(false);
    } finally {
      serve.kill("SIGKILL");
    }
  }, 30000);

  it("reuse path: an already-answering port prints env lines and exits 0 WITHOUT spawning or killing", async () => {
    const port = await getFreePort();
    const listener = spawn(
      "node",
      [
        "-e",
        `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>console.log('UP'))`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => {
      listener.stdout!.on("data", (d: Buffer) => d.toString().includes("UP") && resolve());
    });
    try {
      const r = runServe(["--port", String(port)]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`HERMES_API_BASE_URL=http://127.0.0.1:${port}`);
      expect(r.stdout.toLowerCase()).toContain("already answers");
      // never kill a maybe-gateway
      expect(await canConnect(port)).toBe(true);
    } finally {
      listener.kill("SIGKILL");
    }
  }, 20000);
});
