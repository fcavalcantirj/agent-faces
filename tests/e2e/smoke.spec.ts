// Harness smoke test — proves the E2E rig itself works before any feature test
// relies on it. Three things must hold:
//
//   1. the dev server boots and the app renders
//   2. cross-origin isolation is really achieved (browser Whisper needs
//      SharedArrayBuffer, which needs COOP+COEP — see next.config.mjs)
//   3. the fake microphone is wired AND carries real audio, so voice tests are
//      driving a genuine waveform rather than silence
//
// (3) is the one that matters most: a fake mic that returns silence would let
// every downstream voice test "pass" while proving nothing.

import { test, expect } from "@playwright/test";

test("dev server boots and the app renders", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  await expect(page.getByPlaceholder("…or type a message")).toBeVisible();
  await expect(page.getByRole("button", { name: "SEND" })).toBeVisible();
  await expect(page.getByLabel("Open settings")).toBeVisible();
  await expect(page.getByRole("button", { name: /SPEAK FREELY/ })).toBeVisible();
});

test("the speak-freely toggle flips hands-free listening on and off", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /SPEAK FREELY/ });
  await expect(toggle).toBeVisible();
  // Same gating as the talk button — voice-in is available in this environment
  // (fake mic + browser Whisper), which stt.spec already relies on.
  await expect(toggle).toBeEnabled();

  // One tap: hands-free mode AND listening, in a single gesture.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveText(/TAP TO STOP/);

  // Tap again: back to push-to-talk; the input-mode store subscription resets
  // the listening flag (the un-toggle path exercises that seam end to end).
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveText(/^SPEAK FREELY$/);
});

test("cross-origin isolation headers are served and take effect", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response?.headers() ?? {};

  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("credentialless");
  expect(headers["permissions-policy"]).toContain("microphone");

  // Headers being present is not the same as isolation being achieved — assert
  // the browser actually granted it, which is what unlocks SharedArrayBuffer.
  const isolated = await page.evaluate(() => self.crossOriginIsolated);
  expect(isolated).toBe(true);

  const hasSAB = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined");
  expect(hasSAB).toBe(true);
});

test("fake microphone is granted and carries real (non-silent) audio", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    if (!track) return { ok: false, reason: "no audio track", peak: 0 };

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;

    // Sample for ~2s; the fixture is 2.5s of speech, so a non-trivial peak here
    // means chromium is really replaying our WAV into the capture device.
    const started = performance.now();
    while (performance.now() - started < 2000) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const label = track.label;
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return { ok: true, reason: label, peak };
  });

  expect(result.ok).toBe(true);
  // Silence would sit at ~0. Real speech peaks well above this floor.
  expect(result.peak).toBeGreaterThan(0.01);
});
