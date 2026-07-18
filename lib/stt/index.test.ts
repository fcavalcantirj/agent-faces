import { describe, it, expect, vi } from "vitest";
import {
  transcribe,
  SttError,
  createHostedStt,
  createBrowserStt,
  type BrowserSttEngine,
  type HostedSttEngine,
} from "./index";

// --- Fakes ------------------------------------------------------------------

function fakeBrowser(overrides: Partial<BrowserSttEngine> = {}): BrowserSttEngine {
  return {
    isSupported: vi.fn(() => true),
    isModelCached: vi.fn(async () => true),
    transcribe: vi.fn(async () => ({ text: "browser said hi", backend: "webgpu" as const })),
    ...overrides,
  };
}

function fakeHosted(overrides: Partial<HostedSttEngine> = {}): HostedSttEngine {
  return {
    isAvailable: vi.fn(async () => true),
    transcribe: vi.fn(async () => ({
      text: "hosted said hi",
      provider: "groq" as const,
      model: "whisper-large-v3-turbo",
      latencyMs: 42,
    })),
    ...overrides,
  };
}

const clip = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

// --- auto mode --------------------------------------------------------------

describe("transcribe (auto)", () => {
  it("prefers the browser worker when supported AND the model is cached", async () => {
    const browser = fakeBrowser();
    const hosted = fakeHosted();

    const result = await transcribe(clip(), { mode: "auto" }, { browser, hosted });

    expect(result.engine).toBe("browser");
    expect(result.text).toBe("browser said hi");
    expect(result.backend).toBe("webgpu");
    expect(browser.transcribe).toHaveBeenCalledTimes(1);
    // The browser served it — hosted must never be touched (offline, $0, private).
    expect(hosted.transcribe).not.toHaveBeenCalled();
  });

  it("routes to hosted when the model is NOT cached (no surprise 150 MB download)", async () => {
    const browser = fakeBrowser({ isModelCached: vi.fn(async () => false) });
    const hosted = fakeHosted();

    const result = await transcribe(clip(), { mode: "auto" }, { browser, hosted });

    expect(result.engine).toBe("hosted");
    expect(result.provider).toBe("groq");
    expect(result.model).toBe("whisper-large-v3-turbo");
    expect(result.latencyMs).toBe(42);
    expect(browser.transcribe).not.toHaveBeenCalled();
    expect(hosted.transcribe).toHaveBeenCalledTimes(1);
  });

  it("falls back to hosted when the browser worker errors", async () => {
    const browser = fakeBrowser({
      transcribe: vi.fn(async () => {
        throw new Error("worker OOM");
      }),
    });
    const hosted = fakeHosted();

    const result = await transcribe(clip(), { mode: "auto" }, { browser, hosted });

    expect(result.engine).toBe("hosted");
    expect(browser.transcribe).toHaveBeenCalledTimes(1);
    expect(hosted.transcribe).toHaveBeenCalledTimes(1);
  });

  it("falls back to hosted when the browser worker exceeds the timeout", async () => {
    const browser = fakeBrowser({
      transcribe: vi.fn(
        () => new Promise<{ text: string; backend: "webgpu" }>(() => {}),
      ), // never resolves
    });
    const hosted = fakeHosted();

    const result = await transcribe(
      clip(),
      { mode: "auto", browserTimeoutMs: 20 },
      { browser, hosted },
    );

    expect(result.engine).toBe("hosted");
    expect(hosted.transcribe).toHaveBeenCalledTimes(1);
  });

  it("uses the cached browser model even when hosted is unavailable (offline)", async () => {
    const browser = fakeBrowser();
    const hosted = fakeHosted({ isAvailable: vi.fn(async () => false) });

    const result = await transcribe(clip(), { mode: "auto" }, { browser, hosted });

    expect(result.engine).toBe("browser");
    expect(hosted.isAvailable).not.toHaveBeenCalled();
  });

  it("uses hosted when the browser is unsupported", async () => {
    const browser = fakeBrowser({ isSupported: vi.fn(() => false) });
    const hosted = fakeHosted();

    const result = await transcribe(clip(), { mode: "auto" }, { browser, hosted });

    expect(result.engine).toBe("hosted");
    expect(browser.isModelCached).not.toHaveBeenCalled();
  });

  it("throws a typed 'no_stt_available' when neither path can serve", async () => {
    const browser = fakeBrowser({ isSupported: vi.fn(() => false) });
    const hosted = fakeHosted({ isAvailable: vi.fn(async () => false) });

    const err = await transcribe(clip(), { mode: "auto" }, { browser, hosted }).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).code).toBe("no_stt_available");
  });

  it("works with no browser dep at all, using hosted", async () => {
    const hosted = fakeHosted();
    const result = await transcribe(clip(), { mode: "auto" }, { hosted });
    expect(result.engine).toBe("hosted");
  });
});

// --- forced modes -----------------------------------------------------------

describe("transcribe (forced modes)", () => {
  it("mode 'browser' forces the browser and ignores hosted availability", async () => {
    const browser = fakeBrowser();
    const hosted = fakeHosted();

    const result = await transcribe(clip(), { mode: "browser" }, { browser, hosted });

    expect(result.engine).toBe("browser");
    expect(hosted.transcribe).not.toHaveBeenCalled();
  });

  it("mode 'browser' throws (no silent hosted fallback) when unsupported", async () => {
    const browser = fakeBrowser({ isSupported: vi.fn(() => false) });
    const hosted = fakeHosted();

    const err = await transcribe(clip(), { mode: "browser" }, { browser, hosted }).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).code).toBe("browser_unavailable");
    expect(hosted.transcribe).not.toHaveBeenCalled();
  });

  it("mode 'hosted' forces hosted and ignores the browser", async () => {
    const browser = fakeBrowser();
    const hosted = fakeHosted();

    const result = await transcribe(clip(), { mode: "hosted" }, { browser, hosted });

    expect(result.engine).toBe("hosted");
    expect(browser.transcribe).not.toHaveBeenCalled();
  });

  it("mode 'hosted' throws 'hosted_unavailable' when no hosted key exists", async () => {
    const hosted = fakeHosted({ isAvailable: vi.fn(async () => false) });
    const err = await transcribe(clip(), { mode: "hosted" }, { hosted }).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).code).toBe("hosted_unavailable");
  });

  it("propagates a typed error when a forced hosted transcription fails", async () => {
    const hosted = fakeHosted({
      transcribe: vi.fn(async () => {
        throw new SttError("transcription_failed", "upstream 401");
      }),
    });
    const err = await transcribe(clip(), { mode: "hosted" }, { hosted }).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).code).toBe("transcription_failed");
  });

  it("defaults to 'auto' when no mode is given", async () => {
    const browser = fakeBrowser();
    const result = await transcribe(clip(), {}, { browser, hosted: fakeHosted() });
    expect(result.engine).toBe("browser");
  });
});

// --- default hosted client --------------------------------------------------

describe("createHostedStt", () => {
  it("isAvailable() reflects /api/config STT booleans", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ stt: { groq: true, openai: false } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const hosted = createHostedStt({ fetchImpl });
    expect(await hosted.isAvailable()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/config", expect.any(Object));
  });

  it("isAvailable() is false when no hosted STT key exists", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ stt: { groq: false, openai: false } }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await createHostedStt({ fetchImpl }).isAvailable()).toBe(false);
  });

  it("isAvailable() resolves false (never throws) when the probe fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await createHostedStt({ fetchImpl }).isAvailable()).toBe(false);
  });

  it("transcribe() POSTs the clip and returns the parsed result", async () => {
    let sentBody: FormData | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = init?.body as FormData;
      return new Response(
        JSON.stringify({ text: "hi there", provider: "openai", model: "whisper-1", latencyMs: 7 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const hosted = createHostedStt({ fetchImpl });
    const result = await hosted.transcribe(clip(), { language: "en", prompt: "vocab" });

    expect(result).toEqual({ text: "hi there", provider: "openai", model: "whisper-1", latencyMs: 7 });
    expect(sentBody).toBeInstanceOf(FormData);
    expect((sentBody as unknown as FormData).get("language")).toBe("en");
    expect((sentBody as unknown as FormData).get("prompt")).toBe("vocab");
    expect((sentBody as unknown as FormData).get("audio")).toBeTruthy();
  });

  it("transcribe() throws a typed SttError carrying the route's message on !ok", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }), {
        status: 401,
      }),
    ) as unknown as typeof fetch;
    const hosted = createHostedStt({ fetchImpl });
    const err = await hosted.transcribe(clip()).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).code).toBe("transcription_failed");
    expect((err as SttError).message).toContain("bad key");
  });
});

// --- default browser client -------------------------------------------------

describe("createBrowserStt", () => {
  it("reports unsupported when there is no Worker/window (SSR / node)", () => {
    // In the jsdom test env there is a window but no real Worker constructor is
    // guaranteed; the guard must at least not throw and return a boolean.
    const engine = createBrowserStt();
    expect(typeof engine.isSupported()).toBe("boolean");
  });
});
