import { describe, it, expect, vi } from "vitest";
import {
  initialModelStatus,
  modelStatusReducer,
  statusTextFor,
  estimateModelSizeMb,
  probeModelCached,
  createModelStatusController,
  type ModelStatusState,
  type WhisperWorkerLike,
} from "./model-status";
import { DEFAULT_WHISPER_MODEL } from "./whisper-engine";
import type { WhisperResponse } from "./whisper-worker";

describe("initialModelStatus", () => {
  it("starts unloaded, not cached, 0%", () => {
    const s = initialModelStatus();
    expect(s.phase).toBe("unloaded");
    expect(s.progress).toBe(0);
    expect(s.cached).toBe(false);
    expect(s.backend).toBeNull();
    expect(s.modelId).toBe(DEFAULT_WHISPER_MODEL);
  });

  it("accepts a custom model id", () => {
    expect(initialModelStatus("Xenova/whisper-tiny").modelId).toBe(
      "Xenova/whisper-tiny",
    );
  });
});

describe("modelStatusReducer", () => {
  const start = (): ModelStatusState => ({
    ...initialModelStatus(),
    phase: "downloading",
  });

  it("aggregates per-file download progress into an overall percentage", () => {
    let s = start();
    s = modelStatusReducer(s, {
      type: "progress",
      status: "progress",
      file: "encoder.onnx",
      progress: 40,
    });
    expect(s.progress).toBe(40);
    // Second file at 60 → average 50.
    s = modelStatusReducer(s, {
      type: "progress",
      status: "progress",
      file: "decoder.onnx",
      progress: 60,
    });
    expect(s.progress).toBe(50);
  });

  it("clamps progress to 0..100 and treats a 'done' file as 100", () => {
    let s = start();
    s = modelStatusReducer(s, {
      type: "progress",
      status: "progress",
      file: "a",
      progress: 200,
    });
    s = modelStatusReducer(s, { type: "progress", status: "done", file: "a" });
    expect(s.progress).toBe(100);
    expect(s.phase).toBe("downloading");
  });

  it("marks phase downloading on the first progress event from unloaded", () => {
    let s = initialModelStatus();
    expect(s.phase).toBe("unloaded");
    s = modelStatusReducer(s, {
      type: "progress",
      status: "progress",
      file: "a",
      progress: 10,
    });
    expect(s.phase).toBe("downloading");
  });

  it("goes ready + offline-capable + 100% on a ready message, recording the backend", () => {
    let s = start();
    s = modelStatusReducer(s, {
      type: "ready",
      backend: "webgpu",
      modelId: DEFAULT_WHISPER_MODEL,
    });
    expect(s.phase).toBe("ready");
    expect(s.progress).toBe(100);
    expect(s.backend).toBe("webgpu");
    expect(s.cached).toBe(true);
    expect(statusTextFor(s).toLowerCase()).toContain("offline");
  });

  it("captures a worker error and its fallback flag", () => {
    let s = start();
    s = modelStatusReducer(s, {
      type: "error",
      message: "OOM",
      fallbackToHosted: true,
    });
    expect(s.phase).toBe("error");
    expect(s.error).toBe("OOM");
    expect(s.fallbackToHosted).toBe(true);
  });

  it("ignores transcription 'result' messages (not a load concern)", () => {
    const s = start();
    const next = modelStatusReducer(s, {
      type: "result",
      id: "1",
      text: "hi",
      backend: "wasm",
      durationMs: 5,
    } as WhisperResponse);
    expect(next).toEqual(s);
  });
});

describe("statusTextFor", () => {
  it("says cached/offline-ready when cached but not yet loaded", () => {
    const s = { ...initialModelStatus(), cached: true };
    expect(statusTextFor(s).toLowerCase()).toMatch(/cached|offline/);
  });
  it("shows the backend once ready", () => {
    const s: ModelStatusState = {
      ...initialModelStatus(),
      phase: "ready",
      backend: "wasm",
      progress: 100,
      cached: true,
    };
    expect(statusTextFor(s).toLowerCase()).toContain("wasm");
  });
});

describe("estimateModelSizeMb", () => {
  it("returns a plausible ~150MB estimate for whisper-base", () => {
    const mb = estimateModelSizeMb(DEFAULT_WHISPER_MODEL);
    expect(mb).toBeGreaterThan(50);
    expect(mb).toBeLessThan(400);
  });
  it("falls back to a default for an unknown model", () => {
    expect(estimateModelSizeMb("Xenova/some-unknown-model")).toBeGreaterThan(0);
  });
});

describe("probeModelCached", () => {
  it("returns true when Cache Storage holds an entry for the model", async () => {
    const cache = {
      keys: async () => [
        { url: "https://hf.co/Xenova/whisper-base/resolve/main/encoder.onnx" },
      ],
    };
    const caches = { open: vi.fn(async () => cache) } as unknown as CacheStorage;
    const ok = await probeModelCached(DEFAULT_WHISPER_MODEL, { caches });
    expect(ok).toBe(true);
  });

  it("returns false when no entry matches the model", async () => {
    const cache = { keys: async () => [{ url: "https://hf.co/other/x.onnx" }] };
    const caches = { open: vi.fn(async () => cache) } as unknown as CacheStorage;
    expect(await probeModelCached(DEFAULT_WHISPER_MODEL, { caches })).toBe(false);
  });

  it("returns false (never throws) when Cache Storage is unavailable", async () => {
    expect(await probeModelCached(DEFAULT_WHISPER_MODEL, { caches: undefined })).toBe(
      false,
    );
  });
});

// A fake worker that records posts and lets the test drive inbound messages.
function fakeWorker() {
  const posts: unknown[] = [];
  let terminated = false;
  let listener: ((ev: MessageEvent) => void) | null = null;
  const worker: WhisperWorkerLike = {
    postMessage: (m) => posts.push(m),
    terminate: () => {
      terminated = true;
    },
    addEventListener: (_t, fn) => {
      listener = fn as (ev: MessageEvent) => void;
    },
  };
  return {
    worker,
    posts,
    isTerminated: () => terminated,
    emit: (data: WhisperResponse) => listener?.({ data } as MessageEvent),
  };
}

describe("createModelStatusController", () => {
  it("download() spawns the worker, posts a load, and streams progress → ready", async () => {
    const fw = fakeWorker();
    const seen: string[] = [];
    const ctl = createModelStatusController({
      createWorker: () => fw.worker,
      probeCached: async () => false,
    });
    ctl.subscribe((s) => seen.push(s.phase));

    ctl.download();
    expect(fw.posts).toContainEqual({ type: "load", modelId: DEFAULT_WHISPER_MODEL });
    expect(ctl.getState().phase).toBe("downloading");

    fw.emit({ type: "progress", status: "progress", file: "a", progress: 50 });
    expect(ctl.getState().progress).toBe(50);

    fw.emit({ type: "ready", backend: "webgpu", modelId: DEFAULT_WHISPER_MODEL });
    expect(ctl.getState().phase).toBe("ready");
    expect(ctl.getState().backend).toBe("webgpu");
    expect(seen).toContain("downloading");
    expect(seen).toContain("ready");
  });

  it("cancel() terminates the worker and routes to hosted fallback", () => {
    const fw = fakeWorker();
    const ctl = createModelStatusController({
      createWorker: () => fw.worker,
      probeCached: async () => false,
    });
    ctl.download();
    ctl.cancel();
    expect(fw.isTerminated()).toBe(true);
    expect(ctl.getState().phase).toBe("canceled");
    expect(ctl.getState().fallbackToHosted).toBe(true);
  });

  it("init() reflects a previously cached model without downloading", async () => {
    const fw = fakeWorker();
    const ctl = createModelStatusController({
      createWorker: () => fw.worker,
      probeCached: async () => true,
    });
    await ctl.init();
    expect(ctl.getState().cached).toBe(true);
    // No worker spawned just to probe the cache.
    expect(fw.posts.length).toBe(0);
  });

  it("worker error surfaces on state and keeps fallbackToHosted", () => {
    const fw = fakeWorker();
    const ctl = createModelStatusController({
      createWorker: () => fw.worker,
      probeCached: async () => false,
    });
    ctl.download();
    fw.emit({ type: "error", message: "load failed", fallbackToHosted: true });
    expect(ctl.getState().phase).toBe("error");
    expect(ctl.getState().error).toBe("load failed");
    expect(ctl.getState().fallbackToHosted).toBe(true);
  });
});
