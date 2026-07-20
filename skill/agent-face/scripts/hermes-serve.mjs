#!/usr/bin/env node
// hermes-serve.mjs — bracket a Hermes api_server for Mode B (kind=hermes)
// WITHOUT touching the user's live gateway.
//
//   node hermes-serve.mjs                     # dedicated-profile gateway on :8642
//   node hermes-serve.mjs --port 9100 --profile face
//   node hermes-serve.mjs --cmd "<launch command>"   # full override
//   node hermes-serve.mjs --stop [--port N]   # tear down what we started
//
// Facts this design rests on (NousResearch/hermes-agent docs + source):
// - The api_server is an IN-PROCESS gateway platform — there is no separate
//   daemon. It is enabled via env: API_SERVER_ENABLED=true, a MANDATORY
//   API_SERVER_KEY, API_SERVER_PORT (default 8642), API_SERVER_HOST.
// - The no-downtime pattern is a DEDICATED PROFILE gateway
//   (`hermes -p <profile> gateway run`); per-profile pid locks mean the
//   user's default-profile (live) gateway cannot be disturbed from here.
//   This script NEVER launches the default profile.
// - Caveat (documented in backends.md): a dedicated-profile gateway is a
//   fresh agent instance — same persona/config, its OWN memory. For a face
//   that shares the live agent's memory, enable the api_server in the
//   RUNNING gateway's env and restart that gateway yourself.
//
// Harness-agnostic plain Node ESM, zero deps: Hermes is an external tool
// this script brackets (same pattern as deploy.mjs and the Vercel CLI) and
// it degrades to a clear fail-fast + --cmd escape hatch when absent.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = join(HERE, "dev.mjs");
export const DEFAULT_PORT = 8642; // Hermes' own api_server default
export const DEFAULT_PROFILE = "api";

function help() {
  console.log(`hermes-serve.mjs — run a Hermes api_server for Mode B (kind=hermes)
without touching your live gateway.

Usage:
  node hermes-serve.mjs [options]

Options:
  --port <n>       api_server port (default: ${DEFAULT_PORT}, Hermes' own default).
  --profile <p>    Hermes profile for the dedicated gateway (default: ${DEFAULT_PROFILE}).
                   NEVER the default profile — your live gateway stays untouched.
  --key <k>        API_SERVER_KEY value (default: generated; Hermes requires one).
  --cmd "<cmd>"    Full launch-command override (or env HERMES_SERVE_CMD).
                   API_SERVER_* vars are injected into the child either way.
  --stop           Stop the server this script started (pidfile), then exit.
  --help, -h       This help.

Behavior:
  1. Port already answers? Prints the .env.local lines and exits 0 — never
     kills what may be your gateway.
  2. Launches (--cmd | HERMES_SERVE_CMD | \`hermes -p <profile> gateway run\`)
     with API_SERVER_ENABLED/KEY/PORT/HOST injected, waits for the port,
     prints the AGENT_BRIDGE_KIND=hermes env lines, stays foreground.
  3. Ctrl-C or --stop tears down the whole process group via the pidfile.
  Caveat: a dedicated-profile gateway has its OWN memory. For the face to
  share your live agent's memory, enable api_server in THAT gateway's env
  and restart it — see references/backends.md.`);
}

export function parseServeArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    profile: DEFAULT_PROFILE,
    key: null,
    cmd: null,
    stop: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--stop") args.stop = true;
    else if (a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`--port needs a port number, got "${argv[i]}"`);
      }
      args.port = n;
    } else if (a === "--profile") args.profile = String(argv[++i] ?? "");
    else if (a === "--key") args.key = String(argv[++i] ?? "");
    else if (a === "--cmd") args.cmd = String(argv[++i] ?? "");
    else throw new Error(`unknown option: ${a}`);
  }
  if (args.profile === "") throw new Error("--profile needs a name");
  return args;
}

/**
 * Explicit or documented-default only. The default is the dedicated-profile
 * gateway run — never the user's default profile (that is the live agent).
 * Field-verified: standard venv installs keep the console script OFF PATH at
 * ~/.hermes/hermes-agent/venv/bin/hermes, so that path is a real candidate.
 */
export function resolveLaunchCommand({ cmdArg, env, profile, hermesExists, venvHermes }) {
  if (cmdArg) return { source: "flag", command: cmdArg };
  if (env.HERMES_SERVE_CMD) return { source: "env", command: env.HERMES_SERVE_CMD };
  if (hermesExists()) {
    return { source: "hermes-cli", command: `hermes -p ${profile} gateway run` };
  }
  const venv = venvHermes();
  if (venv) {
    return { source: "hermes-venv", command: `"${venv}" -p ${profile} gateway run` };
  }
  return null;
}

/** The lines the user adds to the app's .env.local. */
export function envLines(port, key) {
  return [
    "AGENT_BRIDGE_KIND=hermes",
    `HERMES_API_BASE_URL=http://127.0.0.1:${port}`,
    `HERMES_API_KEY=${key}`,
  ];
}

export function pidfilePath(port, dir = process.cwd()) {
  return join(dir, `.hermes-serve-${port}.pid`);
}

/** Standard venv install location for the hermes console script (off PATH). */
function venvHermesPath(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  if (!home) return null;
  const p = join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes");
  return existsSync(p) ? p : null;
}

function hermesOnPath(env = process.env) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, `hermes${ext}`))) return true;
    }
  }
  return false;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal); // negative pid = whole process group
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function stop(port) {
  const pf = pidfilePath(port);
  if (existsSync(pf)) {
    const pid = Number(readFileSync(pf, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      console.log(`Stopping hermes-serve pid ${pid} (:${port})…`);
      killGroup(pid, "SIGTERM");
      const deadline = Date.now() + 2500;
      while (pidAlive(pid) && Date.now() < deadline) await sleep(150);
      if (pidAlive(pid)) killGroup(pid, "SIGKILL");
    }
    try {
      unlinkSync(pf); // the foreground parent's exit handler may have raced us here
    } catch {
      /* already removed */
    }
    console.log(`✓ Stopped; removed ${pf}`);
    return 0;
  }
  // No pidfile — fall back to the guarded port free (identity-scoped).
  console.log(`No pidfile for :${port} — falling back to the guarded port free.`);
  const r = spawnSync("node", [DEV, "--kill-only", "--port", String(port)], {
    stdio: "inherit",
  });
  return r.error ? 1 : (r.status ?? 1);
}

async function main() {
  let args;
  try {
    args = parseServeArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err?.message ?? err));
    help();
    process.exit(2);
  }
  if (args.help) {
    help();
    return;
  }
  if (args.stop) {
    process.exit(await stop(args.port));
  }

  // Reuse path: something already answers — maybe the user's gateway with
  // api_server already enabled. Print the wiring and get out of the way.
  if (await canConnect(args.port)) {
    console.log(`✓ :${args.port} already answers — not spawning (and never killing a maybe-gateway).`);
    console.log(`If that is your api_server, add to the app's .env.local:`);
    for (const line of envLines(args.port, args.key ?? "<your API_SERVER_KEY>")) {
      console.log(`  ${line}`);
    }
    return;
  }

  const resolved = resolveLaunchCommand({
    cmdArg: args.cmd,
    env: process.env,
    profile: args.profile,
    hermesExists: () => hermesOnPath(),
    venvHermes: () => venvHermesPath(),
  });
  if (!resolved) {
    console.error(
      `✗ No \`hermes\` on PATH, none at ~/.hermes/hermes-agent/venv/bin/hermes, ` +
        `and no launch command given.\n` +
        `  Pass --cmd "<your launch command>" (or set HERMES_SERVE_CMD).\n` +
        `  Recipe + the memory-sharing alternative: references/backends.md.`,
    );
    process.exit(2);
  }
  console.log(
    `Note: the dedicated profile must exist first — \`hermes profile create ${args.profile}\` ` +
      `(one-time; the gateway will say so and exit if it doesn't).`,
  );

  const key = args.key ?? randomBytes(16).toString("hex");
  console.log(`Launching (${resolved.source}): ${resolved.command}`);
  console.log(`This does NOT touch a running Hermes gateway (dedicated profile / your command).`);
  const child = spawn(resolved.command, {
    shell: true,
    detached: true, // own process group, so --stop can reap the whole tree
    stdio: "inherit",
    env: {
      ...process.env,
      API_SERVER_ENABLED: "true",
      API_SERVER_KEY: key,
      API_SERVER_PORT: String(args.port),
      API_SERVER_HOST: "127.0.0.1",
    },
  });
  writeFileSync(pidfilePath(args.port), `${child.pid}\n`);

  const teardown = () => {
    if (child.pid) killGroup(child.pid, "SIGTERM");
    try {
      unlinkSync(pidfilePath(args.port));
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", () => {
    teardown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    teardown();
    process.exit(0);
  });
  child.on("exit", (code) => {
    try {
      unlinkSync(pidfilePath(args.port));
    } catch {
      /* already gone */
    }
    process.exit(code ?? 1);
  });

  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    if (await canConnect(args.port)) {
      up = true;
      break;
    }
    await sleep(400);
  }
  if (!up) {
    console.error(`✗ Nothing answered on :${args.port} within 60s — stopping the child.`);
    teardown();
    process.exit(1);
  }

  console.log(`\n✓ api_server answering on http://127.0.0.1:${args.port}`);
  console.log(`Add to the app's .env.local (start.mjs appends only MISSING lines — edit an existing KIND yourself):`);
  for (const line of envLines(args.port, key)) console.log(`  ${line}`);
  console.log(`\nCtrl-C here (or \`hermes-serve.mjs --stop --port ${args.port}\`) tears it down.`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
