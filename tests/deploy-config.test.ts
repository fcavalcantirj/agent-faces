// Deploy configuration guard.
//
// The Deploy-with-Vercel flow can only be fully proven by a human clicking the
// button (see the UAT note in progress.txt). But most of the ways it BREAKS are
// static and catchable here: a stale repository-url after a fork or rename, an
// envLink pointing at a moved doc, a vercel.json naming a route that no longer
// exists, or the button prompting for a key the app never reads.
//
// Those are exactly the failures that would waste a user's first five minutes,
// and none of them need a deploy to detect.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** Pull the Deploy-with-Vercel clone URL out of the README badge. */
function deployUrl(): URL {
  const m = readme.match(/https:\/\/vercel\.com\/new\/clone\?[^)\s]+/);
  if (!m) throw new Error("no Deploy with Vercel button found in README.md");
  return new URL(m[0]);
}

describe("Deploy with Vercel button", () => {
  it("is present and points at the real public repository", () => {
    const url = deployUrl();
    const repo = url.searchParams.get("repository-url");
    expect(repo).toBe("https://github.com/fcavalcantirj/claude-faces");
  });

  it("prompts for exactly the keys the app actually reads", () => {
    const url = deployUrl();
    const prompted = (url.searchParams.get("env") ?? "").split(",").filter(Boolean).sort();

    expect(prompted).toEqual([
      "ANTHROPIC_API_KEY",
      "GROQ_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);

    // Every prompted key must be referenced somewhere in server code — a button
    // asking for a key nothing reads is a lie to the user.
    const serverSrc = [
      "app/api/config/route.ts",
      "lib/providers/anthropic.ts",
      "lib/providers/openrouter.ts",
      "lib/providers/groq.ts",
      "app/api/transcribe/route.ts",
      "app/api/tts/route.ts",
    ]
      .filter((p) => existsSync(join(ROOT, p)))
      .map((p) => readFileSync(join(ROOT, p), "utf8"))
      .join("\n");

    for (const key of prompted) {
      expect(serverSrc, `${key} is prompted at deploy but never read`).toContain(key);
    }
  });

  it("says the keys are optional, which is the whole degradation promise", () => {
    const url = deployUrl();
    const description = url.searchParams.get("envDescription") ?? "";
    expect(description.toLowerCase()).toContain("optional");
  });

  it("links to a doc that actually exists in this repo", () => {
    const url = deployUrl();
    const envLink = url.searchParams.get("envLink") ?? "";
    expect(envLink).toContain("github.com/fcavalcantirj/claude-faces");

    // .../blob/main/<path> — the path must resolve to a real file.
    const m = envLink.match(/\/blob\/[^/]+\/(.+)$/);
    expect(m, `envLink is not a blob URL: ${envLink}`).toBeTruthy();
    expect(existsSync(join(ROOT, m![1])), `envLink target missing: ${m![1]}`).toBe(true);
  });
});

describe("vercel.json", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));

  it("declares the Next.js framework", () => {
    expect(vercel.framework).toBe("nextjs");
  });

  it("only configures routes that exist", () => {
    for (const route of Object.keys(vercel.functions ?? {})) {
      expect(existsSync(join(ROOT, route)), `vercel.json names a missing route: ${route}`).toBe(
        true,
      );
    }
  });

  it("gives the streaming and media routes room to finish", () => {
    // A default 10s timeout would cut off a long completion or a TTS render
    // mid-stream, which reads to the user as the face freezing.
    expect(vercel.functions["app/api/chat/route.ts"].maxDuration).toBeGreaterThanOrEqual(60);
    for (const route of ["app/api/transcribe/route.ts", "app/api/tts/route.ts"]) {
      expect(vercel.functions[route].maxDuration).toBeGreaterThanOrEqual(60);
    }
  });
});
