import { describe, it, expect } from "vitest";
import { WhisperEngine, type TransformersPipeline } from "./whisper-engine";
import {
  createWhisperWorkerBridge,
  type WhisperResponse,
} from "./whisper-worker";

function collectingBridge(engine: WhisperEngine) {
  const messages: WhisperResponse[] = [];
  const bridge = createWhisperWorkerBridge(engine, (m) => messages.push(m));
  return { bridge, messages };
}

describe("createWhisperWorkerBridge", () => {
  it("posts progress then a ready message on load", async () => {
    const engine = new WhisperEngine(
      { modelId: "Xenova/whisper-tiny" },
      {
        detectWebGPU: async () => false,
        createPipeline: async (args) => {
          args.onProgress?.({ status: "progress", progress: 50 });
          return (async () => ({ text: "" })) as unknown as TransformersPipeline;
        },
      },
    );
    const { bridge, messages } = collectingBridge(engine);

    await bridge.onMessage({ type: "load" });

    expect(messages.map((m) => m.type)).toEqual(["progress", "ready"]);
    const ready = messages[1];
    expect(ready).toMatchObject({
      type: "ready",
      backend: "wasm",
      modelId: "Xenova/whisper-tiny",
    });
  });

  it("posts a result message for a transcribe request", async () => {
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => false,
        createPipeline: async () =>
          (async () => ({ text: "hello there" })) as unknown as TransformersPipeline,
      },
    );
    const { bridge, messages } = collectingBridge(engine);

    await bridge.onMessage({
      type: "transcribe",
      id: "req-1",
      audio: new Float32Array([0.1, 0.2, 0.3]),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "result",
      id: "req-1",
      text: "hello there",
      backend: "wasm",
    });
  });

  it("posts an error with fallbackToHosted when inference fails", async () => {
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => false,
        createPipeline: async () =>
          (async () => {
            throw new Error("OOM");
          }) as unknown as TransformersPipeline,
      },
    );
    const { bridge, messages } = collectingBridge(engine);

    await bridge.onMessage({
      type: "transcribe",
      id: "req-2",
      audio: new Float32Array([0]),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "error",
      id: "req-2",
      fallbackToHosted: true,
    });
  });

  it("errors when a transcribe request carries neither audio nor blob", async () => {
    const engine = new WhisperEngine(
      {},
      {
        detectWebGPU: async () => false,
        createPipeline: async () =>
          (async () => ({ text: "" })) as unknown as TransformersPipeline,
      },
    );
    const { bridge, messages } = collectingBridge(engine);

    await bridge.onMessage({ type: "transcribe", id: "req-3" });

    expect(messages[0]).toMatchObject({ type: "error", id: "req-3" });
  });

  it("errors on an unknown request type", async () => {
    const engine = new WhisperEngine();
    const { bridge, messages } = collectingBridge(engine);

    // @ts-expect-error — deliberately malformed request.
    await bridge.onMessage({ type: "bogus" });

    expect(messages[0]).toMatchObject({ type: "error", fallbackToHosted: true });
  });
});
