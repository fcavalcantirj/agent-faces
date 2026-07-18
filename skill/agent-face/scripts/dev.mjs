#!/usr/bin/env node
// dev.mjs — start the Agent Face dev server, killing any previous one first.
//
// HARD REQUIREMENT (owner's standing rule): before starting a new dev server
// this script ALWAYS frees the dev port first — SIGTERM, then SIGKILL any
// survivor — so a stale `next dev` from a prior run can never collide with the
// new one. Only after the port is confirmed free does it spawn `npm run dev`.
//
//   node skill/agent-face/scripts/dev.mjs              # kill :3000, start dev, open browser
//   node skill/agent-face/scripts/dev.mjs --port 4000  # use a different port
//   node skill/agent-face/scripts/dev.mjs --no-open    # don't open a browser
//   node skill/agent-face/scripts/dev.mjs --kill-only  # just free the port, don't start
//   node skill/agent-face/scripts/dev.mjs --help
//
// The app dir is the current directory when it holds a package.json (the usual
// scaffolded-app case), else the packaged assets/app-template resolved RELATIVE
// TO THIS SCRIPT, so it also works when the skill is extracted standalone.
//
// Port freeing is deliberately PORT-SCOPED (lsof -ti tcp:PORT) rather than a
// broad `pkill next dev`: killing by process name would also nuke unrelated
// projects' dev servers on the same machine. We only stop whatever holds THIS
// port.
//
// No external deps, no harness-specific tooling — plain Node ESM +
// node:child_process/node:net/node:fs so any harness on macOS/Linux/Windows
// can run it (lsof-based kill targets macOS/Linux per the task; Windows still
// gets the browser-open path).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3000;

function help() {
  console.log(
    `dev.mjs — free the dev port, then start the Agent Face dev server.

Usage:
  node dev.mjs [options]

Options:
  --port <n>        Dev port to free + serve on (default: ${DEFAULT_PORT}).
  --no-open         Don't open a browser once the server is listening.
  --kill-only       Free the port and exit (don't start the dev server).
  --help, -h        Show this help.

Behavior:
  1. ALWAYS kills any process already listening on the port (SIGTERM, then
     SIGKILL if it survives) so a stale dev server can't collide.
  2. Spawns \`npm run dev\` in the app dir (the current dir if it has a
     package.json, else the packaged app-template).
  3. When the server is listening, opens http://localhost:<port> (skipped in
     CI / headless environments or with --no-open). Ctrl-C stops it cleanly.`,
  );
}

export function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    open: true,
    killOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--kill-only") opts.killOnly = true;
    else if (arg === "--port" || arg === "-p") {
      const val = argv[++i];
      opts.port = normalizePort(val);
    } else if (arg.startsWith("--port=")) {
      opts.port = normalizePort(arg.slice("--port=".length));
    } else {
      console.error(`✗ Unknown option: ${arg}\n`);
      help();
      process.exit(2);
    }
  }
  return opts;
}

function normalizePort(val) {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`✗ Invalid --port value: ${val}`);
    process.exit(2);
  }
  return n;
}

// The app dir is the current dir when it looks like a Next app, else the
// packaged template shipped next to this script.
export function resolveAppDir(cwd = process.cwd()) {
  if (existsSync(join(cwd, "package.json"))) return cwd;
  const template = join(HERE, "..", "assets", "app-template");
  if (existsSync(join(template, "package.json"))) return template;
  return cwd; // let `npm run dev` surface a clear error
}

// PIDs holding a socket on the port, excluding our own process. lsof exits 1
// (empty stdout) when nothing matches — that's the "port is free" case, not an
// error.
export function findPidsOnPort(port) {
  const res = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  if (res.error) {
    // lsof missing (e.g. Windows) — we can't port-scan; treat as free.
    return [];
  }
  if (!res.stdout) return [];
  const self = process.pid;
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== self);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // already gone / not permitted
  }
}

// Poll until the port has no owners or the deadline passes; returns whoever is
// still holding it.
async function waitForPortClear(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pids = findPidsOnPort(port);
  while (pids.length && Date.now() < deadline) {
    await sleep(150);
    pids = findPidsOnPort(port);
  }
  return pids;
}

// The load-bearing step: guarantee the port is free before we start.
export async function freePort(port, log = console.error) {
  const initial = findPidsOnPort(port);
  if (initial.length === 0) {
    log(`✓ Port ${port} is already free.`);
    return;
  }
  log(
    `Port ${port} is held by PID(s) ${initial.join(", ")} — stopping them first…`,
  );
  for (const pid of initial) killPid(pid, "SIGTERM");

  let remaining = await waitForPortClear(port, 2500);
  if (remaining.length) {
    log(`Still alive after SIGTERM — sending SIGKILL to ${remaining.join(", ")}…`);
    for (const pid of remaining) killPid(pid, "SIGKILL");
    remaining = await waitForPortClear(port, 2500);
  }

  if (remaining.length) {
    log(
      `✗ Could not free port ${port}; PID(s) still listening: ${remaining.join(", ")}. ` +
        `Stop them manually or pick another --port.`,
    );
    process.exit(1);
  }
  log(`✓ Freed port ${port}.`);
}

// Skip opening a browser where there's nothing to open into.
export function isHeadless(env = process.env, platform = process.platform) {
  if (env.CI) return true;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

export function browserOpenArgv(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  const [cmd, args] = browserOpenArgv(url);
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  if (res.error) {
    console.error(
      `(Could not open a browser automatically — open ${url} yourself.)`,
    );
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const finish = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(1000, () => finish(false));
  });
}

// Wait until the dev server accepts a TCP connection (up to timeoutMs).
async function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  // 1) HARD REQUIREMENT — always free the port before doing anything else.
  await freePort(opts.port);

  if (opts.killOnly) return;

  // 2) Start the dev server in the resolved app dir.
  const appDir = resolveAppDir();
  console.error(`Starting dev server in ${appDir} on port ${opts.port}…\n`);

  const child = spawn("npm", ["run", "dev", "--", "-p", String(opts.port)], {
    cwd: appDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PORT: String(opts.port) },
  });

  child.on("error", (err) => {
    console.error(`✗ Failed to start \`npm run dev\`: ${err.message}`);
    process.exit(1);
  });

  // Forward Ctrl-C / termination to the child so it stops cleanly.
  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      shuttingDown = true;
      if (child.pid) child.kill(sig);
    });
  }
  child.on("exit", (code, signal) => {
    if (shuttingDown) process.exit(0);
    process.exit(code ?? (signal ? 1 : 0));
  });

  // 3) Once it's listening, open the browser (unless headless / --no-open).
  if (opts.open && !isHeadless()) {
    const url = `http://localhost:${opts.port}`;
    waitForServer(opts.port).then((ready) => {
      if (ready && !shuttingDown) {
        console.error(`✓ Server listening — opening ${url}`);
        openBrowser(url);
      }
    });
  }
}

// Run only when executed directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
