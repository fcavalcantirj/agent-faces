import { describe, expect, it, vi } from "vitest";
import {
  VadController,
  createVad,
  DEFAULT_MIN_SPEECH_MS,
  DEFAULT_POSITIVE_SPEECH_THRESHOLD,
  DEFAULT_VAD_ASSET_PATH,
  DEFAULT_VAD_MODEL,
  VAD_SAMPLE_RATE,
  type MicVADConfig,
  type MicVADLike,
  type VadSegment,
} from "@/lib/audio/vad";

// --- Fakes -----------------------------------------------------------------
// jsdom has no MicVAD / onnxruntime, so we inject the whole library seam. The
// fake captures the config passed to MicVAD.new so a test can trigger the
// Silero callbacks (speech-start / speech-end / misfire) by hand.

class FakeMicVAD implements MicVADLike {
  listening = false;
  startCalls = 0;
  pauseCalls = 0;
  destroyCalls = 0;
  constructor(public config: MicVADConfig) {}
  start() {
    this.listening = true;
    this.startCalls++;
  }
  pause() {
    this.listening = false;
    this.pauseCalls++;
  }
  destroy() {
    this.listening = false;
    this.destroyCalls++;
  }
}

function makeController(
  overrides: {
    callbacks?: Parameters<typeof createVad>[0];
    options?: Parameters<typeof createVad>[1];
    createMicVAD?: (c: MicVADConfig) => Promise<MicVADLike>;
    encodeWAV?: (s: Float32Array, sr: number) => ArrayBuffer;
  } = {},
) {
  let last: FakeMicVAD | null = null;
  const createMicVAD =
    overrides.createMicVAD ??
    (async (config: MicVADConfig) => {
      last = new FakeMicVAD(config);
      return last;
    });
  const encodeWAV =
    overrides.encodeWAV ??
    ((samples: Float32Array) => new ArrayBuffer(samples.length * 2));
  const controller = new VadController(overrides.callbacks ?? {}, overrides.options ?? {}, {
    createMicVAD,
    encodeWAV,
    resumeAudio: async () => undefined,
  });
  return {
    controller,
    getVad: () => last as FakeMicVAD,
  };
}

describe("VadController", () => {
  it("loads the VAD once and starts listening", async () => {
    const create = vi.fn(async (config: MicVADConfig) => new FakeMicVAD(config));
    const controller = new VadController({}, {}, {
      createMicVAD: create,
      resumeAudio: async () => undefined,
    });
    expect(controller.getState()).toBe("idle");
    await controller.start();
    expect(controller.getState()).toBe("listening");
    expect(controller.active).toBe(true);
    // Calling start again while active neither reloads nor re-starts.
    await controller.start();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("resumes the shared AudioContext on start (gesture unlock)", async () => {
    const resumeAudio = vi.fn(async () => undefined);
    const controller = new VadController({}, {}, {
      createMicVAD: async (c) => new FakeMicVAD(c),
      resumeAudio,
    });
    await controller.start();
    expect(resumeAudio).toHaveBeenCalledTimes(1);
  });

  it("passes tuning defaults (incl. debounce) and self-hosted asset paths", async () => {
    const { controller, getVad } = makeController();
    await controller.start();
    const cfg = getVad().config;
    expect(cfg.minSpeechMs).toBe(DEFAULT_MIN_SPEECH_MS);
    expect(cfg.positiveSpeechThreshold).toBe(DEFAULT_POSITIVE_SPEECH_THRESHOLD);
    expect(cfg.model).toBe(DEFAULT_VAD_MODEL);
    expect(cfg.baseAssetPath).toBe(DEFAULT_VAD_ASSET_PATH);
    expect(cfg.onnxWASMBasePath).toBe(DEFAULT_VAD_ASSET_PATH);
    expect(cfg.startOnLoad).toBe(false);
  });

  it("honors tuning overrides (custom debounce/threshold)", async () => {
    const { controller, getVad } = makeController({
      options: { minSpeechMs: 900, positiveSpeechThreshold: 0.8, model: "v5" },
    });
    await controller.start();
    const cfg = getVad().config;
    expect(cfg.minSpeechMs).toBe(900);
    expect(cfg.positiveSpeechThreshold).toBe(0.8);
    expect(cfg.model).toBe("v5");
  });

  it("wires the shared stream + context into the MicVAD config", async () => {
    const stream = { id: "shared" } as unknown as MediaStream;
    const audioContext = { id: "ctx" } as unknown as AudioContext;
    const { controller, getVad } = makeController({ options: { stream, audioContext } });
    await controller.start();
    const cfg = getVad().config;
    expect(cfg.audioContext).toBe(audioContext);
    const got = await cfg.getStream!();
    expect(got).toBe(stream);
  });

  it("fires onSpeechStart and transitions to 'speech'", async () => {
    const onSpeechStart = vi.fn();
    const { controller, getVad } = makeController({ callbacks: { onSpeechStart } });
    await controller.start();
    getVad().config.onSpeechStart();
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("speech");
  });

  it("hands a WAV-encoded segment to onSpeechEnd then returns to listening", async () => {
    const segments: VadSegment[] = [];
    const { controller, getVad } = makeController({
      callbacks: { onSpeechEnd: (s) => segments.push(s) },
    });
    await controller.start();
    const samples = new Float32Array(VAD_SAMPLE_RATE); // 1 second
    getVad().config.onSpeechStart();
    await getVad().config.onSpeechEnd(samples);
    expect(segments).toHaveLength(1);
    expect(segments[0].sampleRate).toBe(VAD_SAMPLE_RATE);
    expect(segments[0].blob.type).toBe("audio/wav");
    expect(segments[0].blob.size).toBeGreaterThan(0);
    expect(Math.round(segments[0].durationMs)).toBe(1000);
    expect(controller.getState()).toBe("listening");
  });

  it("fires a barge-in only when the face is speaking", async () => {
    const onBargeIn = vi.fn();
    const { controller, getVad } = makeController({ callbacks: { onBargeIn } });
    await controller.start();

    // Not speaking → no barge-in.
    getVad().config.onSpeechStart();
    expect(onBargeIn).not.toHaveBeenCalled();

    // Face speaking → the next speech-start IS a barge-in.
    controller.setFaceSpeaking(true);
    getVad().config.onSpeechStart();
    expect(onBargeIn).toHaveBeenCalledTimes(1);

    // Cleared again → no barge-in.
    controller.setFaceSpeaking(false);
    getVad().config.onSpeechStart();
    expect(onBargeIn).toHaveBeenCalledTimes(1);
  });

  it("routes short noises to onMisfire (debounce) without a segment", async () => {
    const onMisfire = vi.fn();
    const onSpeechEnd = vi.fn();
    const { controller, getVad } = makeController({
      callbacks: { onMisfire, onSpeechEnd },
    });
    await controller.start();
    getVad().config.onSpeechStart();
    getVad().config.onVADMisfire();
    expect(onMisfire).toHaveBeenCalledTimes(1);
    expect(onSpeechEnd).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("listening");
  });

  it("surfaces a WAV-encode failure via onError without throwing", async () => {
    const onError = vi.fn();
    const { controller, getVad } = makeController({
      callbacks: { onError },
      encodeWAV: () => {
        throw new Error("encode boom");
      },
    });
    await controller.start();
    await getVad().config.onSpeechEnd(new Float32Array(160));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("pauses and destroys, and start() is a no-op after destroy()", async () => {
    const { controller, getVad } = makeController();
    await controller.start();
    const vad = getVad();
    await controller.pause();
    expect(vad.pauseCalls).toBe(1);
    expect(controller.getState()).toBe("idle");

    await controller.destroy();
    expect(vad.destroyCalls).toBe(1);
    await controller.start();
    expect(controller.getState()).toBe("idle"); // disposed → stays idle
  });

  it("parks in 'error' and rejects when loading fails", async () => {
    const controller = new VadController({}, {}, {
      createMicVAD: async () => {
        throw new Error("model download failed");
      },
      resumeAudio: async () => undefined,
    });
    await expect(controller.start()).rejects.toThrow("model download failed");
    expect(controller.getState()).toBe("error");
  });

  it("notifies onStateChange across the listen → speech → listen cycle", async () => {
    const states: string[] = [];
    const { controller, getVad } = makeController({
      callbacks: { onStateChange: (s) => states.push(s) },
    });
    await controller.start();
    getVad().config.onSpeechStart();
    await getVad().config.onSpeechEnd(new Float32Array(160));
    expect(states).toEqual(["loading", "listening", "speech", "listening"]);
  });
});
