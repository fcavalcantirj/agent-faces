import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Browser-level E2E harness. Vitest (vitest.config.ts) owns unit tests over
// **/*.test.ts; Playwright owns tests/e2e/**/*.spec.ts. The two globs do not
// overlap, so neither runner collects the other's files.

// Port is configurable so a run never collides with (or kills) a dev server
// someone else already has on :3000. Override with PLAYWRIGHT_PORT.
const PORT = process.env.PLAYWRIGHT_PORT ?? "3000";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

// A real recorded utterance, injected as the microphone input. Chromium requires
// 16 kHz mono PCM WAV here — see tests/fixtures/speech-16k.wav.
const FAKE_MIC_WAV = fileURLToPath(
  new URL("./tests/fixtures/speech-16k.wav", import.meta.url),
);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  // The voice loop is genuinely slow (model load, audio playback), so give it room.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // The app sets COOP/COEP (next.config.mjs) so browser Whisper gets
    // crossOriginIsolated + SharedArrayBuffer. Nothing here may relax that —
    // tests/e2e/smoke.spec.ts asserts isolation is actually achieved.
    permissions: ["microphone"],
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // Auto-accept getUserMedia instead of showing a permission prompt.
            "--use-fake-ui-for-media-stream",
            // Synthesize a capture device rather than needing real hardware.
            "--use-fake-device-for-media-stream",
            // Feed our recorded utterance as that device's audio.
            `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
            // TTS playback must start without a user gesture in headless runs.
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // First boot fetches/validates the VAD assets (predev), which is not fast.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
