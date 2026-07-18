import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KokoroEngine,
  KokoroError,
  dtypeForBackend,
  normalizeProgress,
  DEFAULT_KOKORO_MODEL,
  DEFAULT_KOKORO_VOICE,
  type CreateKokoroArgs,
  type KokoroModel,
} from './kokoro-engine'
import {
  createKokoroWorkerBridge,
  type KokoroRequest,
  type KokoroResponse,
} from './kokoro-worker'
import {
  KokoroController,
  kokoroStatusReducer,
  kokoroStatusTextFor,
  initialKokoroStatus,
  estimateKokoroSizeMb,
  probeKokoroCached,
  type KokoroWorkerLike,
} from './kokoro'

// --- helpers ---------------------------------------------------------------

/** A fake kokoro-js model that returns a WAV blob and records the call. */
function fakeModel(bytes = 'RIFFwav') {
  const calls: Array<{ text: string; voice?: string; speed?: number }> = []
  const model: KokoroModel = {
    generate: async (text, opts) => {
      calls.push({ text, voice: opts?.voice, speed: opts?.speed })
      return { toBlob: () => new Blob([bytes], { type: 'audio/wav' }) }
    },
  }
  return { model, calls }
}


// --- KokoroEngine ----------------------------------------------------------

describe('KokoroEngine.load — backend selection', () => {
  it('prefers WebGPU (fp32) when an adapter is present', async () => {
    const seen: CreateKokoroArgs[] = []
    const { model } = fakeModel()
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => true,
        createModel: async (args) => {
          seen.push(args)
          return model
        },
      },
    )
    const backend = await engine.load()
    expect(backend).toBe('webgpu')
    expect(seen[0].device).toBe('webgpu')
    expect(seen[0].dtype).toBe('fp32')
    expect(engine.getBackend()).toBe('webgpu')
    expect(engine.isReady()).toBe(true)
  })

  it('falls back to WASM (q8) when the WebGPU load throws', async () => {
    const attempts: string[] = []
    const { model } = fakeModel()
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => true,
        createModel: async (args) => {
          attempts.push(args.device)
          if (args.device === 'webgpu') throw new Error('no gpu memory')
          return model
        },
      },
    )
    const backend = await engine.load()
    expect(attempts).toEqual(['webgpu', 'wasm'])
    expect(backend).toBe('wasm')
  })

  it('uses WASM only when no WebGPU adapter is present', async () => {
    const attempts: string[] = []
    const { model } = fakeModel()
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => false,
        createModel: async (args) => {
          attempts.push(args.device)
          return model
        },
      },
    )
    expect(await engine.load()).toBe('wasm')
    expect(attempts).toEqual(['wasm'])
  })

  it('throws a fallback-flagged KokoroError when every backend fails', async () => {
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => true,
        createModel: async () => {
          throw new Error('boom')
        },
      },
    )
    await expect(engine.load()).rejects.toBeInstanceOf(KokoroError)
    await expect(engine.load()).rejects.toMatchObject({ fallbackToWebSpeech: true })
  })
})

describe('KokoroEngine.synthesize', () => {
  it('returns a WAV blob and keeps the model resident across calls', async () => {
    const { model, calls } = fakeModel()
    let created = 0
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => false,
        createModel: async () => {
          created++
          return model
        },
      },
    )
    const a = await engine.synthesize('Hello there.')
    const b = await engine.synthesize('And again.')
    expect(a.blob).toBeInstanceOf(Blob)
    expect(a.backend).toBe('wasm')
    expect(a.durationMs).toBeGreaterThanOrEqual(0)
    // Model built exactly once (no re-download between syntheses).
    expect(created).toBe(1)
    expect(calls.map((c) => c.text)).toEqual(['Hello there.', 'And again.'])
    // Default voice applied.
    expect(calls[0].voice).toBe(DEFAULT_KOKORO_VOICE)
    expect(b.blob).toBeInstanceOf(Blob)
  })

  it('passes an explicit voice + speed through to the model', async () => {
    const { model, calls } = fakeModel()
    const engine = new KokoroEngine(
      { voice: 'am_michael' },
      { detectWebGPU: async () => false, createModel: async () => model },
    )
    await engine.synthesize('Hi', { voice: 'af_bella', speed: 1.2 })
    expect(calls[0]).toMatchObject({ voice: 'af_bella', speed: 1.2 })
  })

  it('rejects empty text without loading (bad-request, no fallback)', async () => {
    let created = 0
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => false,
        createModel: async () => {
          created++
          return fakeModel().model
        },
      },
    )
    await expect(engine.synthesize('   ')).rejects.toMatchObject({
      name: 'KokoroError',
      fallbackToWebSpeech: false,
    })
    expect(created).toBe(0)
  })

  it('wraps a generate() failure as a fallback KokoroError', async () => {
    const model: KokoroModel = {
      generate: async () => {
        throw new Error('inference OOM')
      },
    }
    const engine = new KokoroEngine(
      {},
      { detectWebGPU: async () => false, createModel: async () => model },
    )
    await expect(engine.synthesize('Hi')).rejects.toMatchObject({
      fallbackToWebSpeech: true,
    })
  })
})

describe('kokoro-engine helpers', () => {
  it('maps backend → dtype', () => {
    expect(dtypeForBackend('webgpu')).toBe('fp32')
    expect(dtypeForBackend('wasm')).toBe('q8')
  })

  it('normalizes a raw progress event', () => {
    expect(normalizeProgress({ status: 'progress', file: 'a.onnx', progress: 42 })).toEqual({
      status: 'progress',
      file: 'a.onnx',
      progress: 42,
      loaded: undefined,
      total: undefined,
    })
    expect(normalizeProgress(null).status).toBe('progress')
  })
})

// --- worker bridge ---------------------------------------------------------

describe('createKokoroWorkerBridge', () => {
  function bridgeWith(engine: KokoroEngine) {
    const posted: KokoroResponse[] = []
    const bridge = createKokoroWorkerBridge(engine, (m) => posted.push(m))
    return { bridge, posted }
  }

  it('load → streams progress then a ready message', async () => {
    const { model } = fakeModel()
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => false,
        createModel: async (args) => {
          args.onProgress?.({ status: 'progress', file: 'model.onnx', progress: 50 })
          return model
        },
      },
    )
    const { bridge, posted } = bridgeWith(engine)
    await bridge.onMessage({ type: 'load' })
    expect(posted.some((m) => m.type === 'progress')).toBe(true)
    const ready = posted.find((m) => m.type === 'ready')
    expect(ready).toMatchObject({ type: 'ready', backend: 'wasm', modelId: DEFAULT_KOKORO_MODEL })
  })

  it('synthesize → posts an audio message carrying the blob + id', async () => {
    const { model } = fakeModel()
    const engine = new KokoroEngine(
      {},
      { detectWebGPU: async () => false, createModel: async () => model },
    )
    const { bridge, posted } = bridgeWith(engine)
    await bridge.onMessage({ type: 'synthesize', id: 'x1', text: 'Speak.' })
    const audio = posted.find((m) => m.type === 'audio')
    expect(audio).toMatchObject({ type: 'audio', id: 'x1', backend: 'wasm' })
    expect((audio as { blob: Blob }).blob).toBeInstanceOf(Blob)
  })

  it('a load failure posts an id-less error with fallbackToWebSpeech', async () => {
    const engine = new KokoroEngine(
      {},
      {
        detectWebGPU: async () => false,
        createModel: async () => {
          throw new Error('offline')
        },
      },
    )
    const { bridge, posted } = bridgeWith(engine)
    await bridge.onMessage({ type: 'load' })
    const err = posted.find((m) => m.type === 'error')
    expect(err).toMatchObject({ type: 'error', fallbackToWebSpeech: true })
    expect((err as { id?: string }).id).toBeUndefined()
  })

  it('a synthesis failure posts an error tagged with the request id', async () => {
    const model: KokoroModel = {
      generate: async () => {
        throw new Error('bad')
      },
    }
    const engine = new KokoroEngine(
      {},
      { detectWebGPU: async () => false, createModel: async () => model },
    )
    const { bridge, posted } = bridgeWith(engine)
    await bridge.onMessage({ type: 'synthesize', id: 'x2', text: 'Hi' })
    expect(posted.find((m) => m.type === 'error')).toMatchObject({ id: 'x2' })
  })

  it('an unknown request posts an error', async () => {
    const engine = new KokoroEngine({}, { detectWebGPU: async () => false })
    const { bridge, posted } = bridgeWith(engine)
    await bridge.onMessage({ type: 'nope' } as unknown as KokoroRequest)
    expect(posted[0]).toMatchObject({ type: 'error', fallbackToWebSpeech: true })
  })
})

// --- status reducer / helpers ----------------------------------------------

describe('kokoroStatusReducer', () => {
  it('progress moves unloaded → downloading and aggregates files', () => {
    let s = initialKokoroStatus()
    s = kokoroStatusReducer(s, { type: 'progress', status: 'progress', file: 'a', progress: 40 })
    expect(s.phase).toBe('downloading')
    s = kokoroStatusReducer(s, { type: 'progress', status: 'progress', file: 'b', progress: 60 })
    expect(s.progress).toBe(50)
  })

  it('ready sets backend + cached; a per-synthesis error does not unset ready', () => {
    let s = kokoroStatusReducer(initialKokoroStatus(), {
      type: 'ready',
      backend: 'webgpu',
      modelId: DEFAULT_KOKORO_MODEL,
    })
    expect(s).toMatchObject({ phase: 'ready', backend: 'webgpu', cached: true, progress: 100 })
    // An error carrying an id is a synthesis failure — must not knock out 'ready'.
    s = kokoroStatusReducer(s, { type: 'error', id: 'k1', message: 'x', fallbackToWebSpeech: true })
    expect(s.phase).toBe('ready')
    // A load error (no id) does move to 'error'.
    s = kokoroStatusReducer(s, { type: 'error', message: 'load failed', fallbackToWebSpeech: true })
    expect(s.phase).toBe('error')
  })

  it('renders readable status text + a size estimate', () => {
    expect(kokoroStatusTextFor(initialKokoroStatus())).toContain('Not downloaded')
    expect(
      kokoroStatusTextFor({ ...initialKokoroStatus(), phase: 'ready', backend: 'webgpu' }),
    ).toContain('WEBGPU')
    expect(estimateKokoroSizeMb(DEFAULT_KOKORO_MODEL)).toBeGreaterThan(0)
  })
})

describe('probeKokoroCached', () => {
  it('is true when a shard URL for the model is in Cache Storage', async () => {
    const caches = {
      open: async () => ({
        keys: async () => [{ url: `https://hf.co/${DEFAULT_KOKORO_MODEL}/model.onnx` }],
      }),
    } as unknown as CacheStorage
    expect(await probeKokoroCached(DEFAULT_KOKORO_MODEL, { caches })).toBe(true)
  })

  it('never throws — returns false with no Cache Storage', async () => {
    expect(await probeKokoroCached(DEFAULT_KOKORO_MODEL, { caches: undefined })).toBe(false)
  })
})

// --- KokoroController (fake worker) ----------------------------------------

/** A fake worker the controller drives; `emit` pushes a response back. */
class FakeWorker implements KokoroWorkerLike {
  sent: KokoroRequest[] = []
  terminated = 0
  private listener: ((ev: MessageEvent) => void) | null = null
  postMessage(msg: unknown) {
    this.sent.push(msg as KokoroRequest)
  }
  terminate() {
    this.terminated++
  }
  addEventListener(_type: 'message', listener: (ev: MessageEvent) => void) {
    this.listener = listener
  }
  emit(res: KokoroResponse) {
    this.listener?.({ data: res } as MessageEvent)
  }
  lastSynthId(): string | undefined {
    const s = [...this.sent].reverse().find((m) => m.type === 'synthesize')
    return s && s.type === 'synthesize' ? s.id : undefined
  }
}

describe('KokoroController', () => {
  afterEach(() => vi.restoreAllMocks())

  function setup() {
    let worker: FakeWorker | null = null
    const controller = new KokoroController({
      createWorker: () => {
        worker = new FakeWorker()
        return worker
      },
      probeCached: async () => false,
    })
    return { controller, getWorker: () => worker! }
  }

  it('synthesize correlates the response blob by id and kicks off a load', async () => {
    const { controller, getWorker } = setup()
    const ac = new AbortController()
    const p = controller.synthesize('Hello.', ac.signal)
    const w = getWorker()
    // It began the model download (streams progress) alongside the synth request.
    expect(w.sent.some((m) => m.type === 'load')).toBe(true)
    const id = w.lastSynthId()!
    expect(id).toBeTruthy()
    const blob = new Blob(['wav'], { type: 'audio/wav' })
    w.emit({ type: 'audio', id, blob, backend: 'wasm', durationMs: 5 })
    await expect(p).resolves.toBe(blob)
  })

  it('rejects when the worker reports a synthesis error (router falls back)', async () => {
    const { controller, getWorker } = setup()
    const ac = new AbortController()
    const p = controller.synthesize('Hi.', ac.signal)
    const id = getWorker().lastSynthId()!
    getWorker().emit({ type: 'error', id, message: 'inference OOM', fallbackToWebSpeech: true })
    await expect(p).rejects.toThrow('inference OOM')
  })

  it('aborting the signal rejects and drops the pending request', async () => {
    const { controller, getWorker } = setup()
    const ac = new AbortController()
    const p = controller.synthesize('Barge.', ac.signal)
    const id = getWorker().lastSynthId()!
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/i)
    // A late audio message for the dropped id must not throw (no pending entry).
    expect(() =>
      getWorker().emit({ type: 'audio', id, blob: new Blob(['x']), backend: 'wasm', durationMs: 1 }),
    ).not.toThrow()
  })

  it('folds load progress/ready into the observable status', async () => {
    const { controller, getWorker } = setup()
    const states: string[] = []
    controller.subscribe((s) => states.push(s.phase))
    controller.load()
    const w = getWorker()
    w.emit({ type: 'progress', status: 'progress', file: 'model.onnx', progress: 30 })
    w.emit({ type: 'ready', backend: 'webgpu', modelId: DEFAULT_KOKORO_MODEL })
    expect(controller.getState().phase).toBe('ready')
    expect(controller.getState().backend).toBe('webgpu')
    expect(states).toContain('downloading')
  })

  it('init reflects a cached model as offline-ready', async () => {
    const controller = new KokoroController({
      createWorker: () => new FakeWorker(),
      probeCached: async () => true,
    })
    await controller.init()
    expect(controller.getState().cached).toBe(true)
  })

  it('cancel terminates the worker, marks canceled, and rejects pending', async () => {
    const { controller, getWorker } = setup()
    const ac = new AbortController()
    const p = controller.synthesize('X.', ac.signal)
    controller.cancel()
    expect(getWorker().terminated).toBe(1)
    expect(controller.getState().phase).toBe('canceled')
    await expect(p).rejects.toThrow(/canceled/i)
  })

  it('load is idempotent while downloading', async () => {
    const { controller, getWorker } = setup()
    controller.load()
    controller.load()
    const loads = getWorker().sent.filter((m) => m.type === 'load')
    expect(loads.length).toBe(1)
  })

  it('getSynthesizer returns a bound ClipSynthesizer and toRouterDeps wraps it', () => {
    const { controller } = setup()
    expect(typeof controller.getSynthesizer()).toBe('function')
    expect(typeof controller.toRouterDeps().kokoroSynthesize).toBe('function')
  })
})
