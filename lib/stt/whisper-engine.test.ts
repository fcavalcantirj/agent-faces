import { describe, it, expect, vi } from "vitest";
import {
  WhisperEngine,
  WhisperError,
  DEFAULT_WHISPER_MODEL,
  normalizeProgress,
  type CreatePipelineArgs,
  type TransformersPipeline,
} from "./whisper-engine";

// A fake ASR pipeline that just echoes a fixed transcript.
function fakePipeline(text = "hello world"): TransformersPipeline {
  return vi.fn(async () => ({ text })) as unknown as TransformersPipeline;
}

describe("WhisperEngine.load", () => {
  it("defaults to the whisper-base model", () => {
    const engine = new WhisperEngine();
    expect(engine.modelId).toBe(DEFAULT_WHISPER_MODEL);
    expect(engine.isReady()).toBe(false);
  });

  it("prefers WebGPU when an adapter is available and reports progress", async () => {
    const seen: CreatePipelineArgs[] = [];
    const progress: string[] = [];
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => true,
        createPipeline: async (args) => {
          seen.push(args);
          args.onProgress?.({ status: "progress", file: "model.onnx", progress: 42 });
          return fakePipeline();
        },
      },
    );

    const backend = await engine.load((p) => progress.push(p.status));

    expect(backend).toBe("webgpu");
    expect(engine.getBackend()).toBe("webgpu");
    expect(engine.isReady()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].device).toBe("webgpu");
    expect(seen[0].modelId).toBe(DEFAULT_WHISPER_MODEL);
    expect(progress).toContain("progress");
  });

  it("falls back to WASM when the WebGPU pipeline fails to build", async () => {
    const devices: string[] = [];
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => true,
        createPipeline: async (args) => {
          devices.push(args.device);
          if (args.device === "webgpu") throw new Error("no webgpu device");
          return fakePipeline();
        },
      },
    );

    const backend = await engine.load();

    expect(devices).toEqual(["webgpu", "wasm"]);
    expect(backend).toBe("wasm");
    expect(engine.getBackend()).toBe("wasm");
  });

  it("uses WASM directly when no WebGPU adapter is present", async () => {
    const devices: string[] = [];
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => false,
        createPipeline: async (args) => {
          devices.push(args.device);
          return fakePipeline();
        },
      },
    );

    const backend = await engine.load();
    expect(devices).toEqual(["wasm"]);
    expect(backend).toBe("wasm");
  });

  it("throws a fallback-signaling WhisperError when every backend fails", async () => {
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => true,
        createPipeline: async () => {
          throw new Error("boom");
        },
      },
    );

    await expect(engine.load()).rejects.toBeInstanceOf(WhisperError);
    await expect(engine.load()).rejects.toMatchObject({ fallbackToHosted: true });
  });

  it("keeps the pipeline resident across load + transcribe (no re-download)", async () => {
    const createPipeline = vi.fn(async () => fakePipeline("resident"));
    const engine = new WhisperEngine(
      {},
      { detectWebGPU: async () => false, createPipeline },
    );

    await engine.load();
    const a = await engine.transcribe(new Float32Array([0.1, 0.2]));
    const b = await engine.transcribe(new Float32Array([0.3, 0.4]));

    expect(a.text).toBe("resident");
    expect(b.text).toBe("resident");
    // Built the pipeline exactly ONCE despite three ensure-loaded calls.
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("WhisperEngine.transcribe", () => {
  it("transcribes pre-decoded PCM and reports the active backend + duration", async () => {
    let t = 1000;
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => true,
        createPipeline: async () => fakePipeline("a transcript"),
        now: () => (t += 5),
      },
    );

    const result = await engine.transcribe(new Float32Array([0, 0.5, -0.5]));
    expect(result.text).toBe("a transcript");
    expect(result.backend).toBe("webgpu");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("decodes a Blob input to PCM via the injected decoder before inference", async () => {
    const decoded = new Float32Array([0.9, 0.8, 0.7]);
    const decodeAudio = vi.fn(async () => decoded);
    let fed: Float32Array | null = null;
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => false,
        decodeAudio,
        createPipeline: async () =>
          (async (audio: Float32Array) => {
            fed = audio;
            return { text: "from blob" };
          }) as unknown as TransformersPipeline,
      },
    );

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const result = await engine.transcribe({ blob });

    expect(decodeAudio).toHaveBeenCalledTimes(1);
    expect(fed).toBe(decoded);
    expect(result.text).toBe("from blob");
  });

  it("wraps an inference error as a WhisperError that signals hosted fallback", async () => {
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => false,
        createPipeline: async () =>
          (async () => {
            throw new Error("out of memory");
          }) as unknown as TransformersPipeline,
      },
    );

    await expect(engine.transcribe(new Float32Array([0]))).rejects.toMatchObject({
      name: "WhisperError",
      fallbackToHosted: true,
    });
  });
});

describe("normalizeProgress", () => {
  it("extracts status/file/progress and tolerates junk", () => {
    expect(normalizeProgress({ status: "download", file: "w.bin", progress: 12 })).toEqual({
      status: "download",
      file: "w.bin",
      progress: 12,
      loaded: undefined,
      total: undefined,
    });
    expect(normalizeProgress(null).status).toBe("progress");
    expect(normalizeProgress({ progress: "nan" }).progress).toBeUndefined();
  });
});
