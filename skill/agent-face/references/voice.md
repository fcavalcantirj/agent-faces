# Voice

The voice loop has two halves: **STT** (you speak → text) and **TTS** (reply
text → audible speech that drives the mouth). Both are browser-first and free by
default, with optional hosted upgrades behind server-side keys.

STT code: [`lib/stt/`](../../../lib/stt/) +
[`app/api/transcribe/route.ts`](../../../app/api/transcribe/route.ts).
TTS code: [`lib/tts/`](../../../lib/tts/) +
[`app/api/tts/route.ts`](../../../app/api/tts/route.ts).
Lip-sync engine: [`lib/lipsync.ts`](../../../lib/lipsync.ts).

---

## Speech-to-text (STT)

Auto-selection (`lib/stt/index.ts`, `mode: 'browser' | 'hosted' | 'auto'`)
prefers the private in-browser path and falls back to a hosted key only when
needed.

### Browser Whisper (default, $0, offline)

- Runs **Whisper via `@huggingface/transformers`** in a Web Worker
  ([`lib/stt/whisper-worker.ts`](../../../lib/stt/whisper-worker.ts)), on
  **WebGPU** with a **WASM fallback** when WebGPU is absent.
- The `~150 MB` model downloads once, then caches in the browser and works fully
  **offline** — no key, no request leaves the machine.
- **Requires cross-origin isolation** (`self.crossOriginIsolated === true`) for
  the multi-threaded WASM backend. The app ships the required
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers from
  `next.config.mjs`. See [`troubleshooting.md`](troubleshooting.md) if isolation
  is off.

### Hosted Whisper (fallback / by choice)

Used when the browser model isn't cached, WebGPU/WASM is unavailable, or the
worker errors — the clip POSTs to `/api/transcribe`, which selects a provider by
which key is set (both **server-side only**):

| Env var | Unlocks | Model |
|---|---|---|
| `GROQ_API_KEY` | Groq hosted STT (cheapest/fastest, preferred) | `whisper-large-v3-turbo` |
| `OPENAI_API_KEY` | OpenAI hosted STT (fallback) | `OPENAI_TRANSCRIBE_MODEL` (default `whisper-1`) |

Tuning knobs (OpenAI path, all optional, exactly as named in `.env.example`):

- `OPENAI_TRANSCRIBE_MODEL` — transcription model (default `whisper-1`).
- `OPENAI_TRANSCRIBE_LANGUAGE` — force an ISO-639-1 language; blank = auto-detect.
- `OPENAI_TRANSCRIBE_PROMPT` — a vocab/style prompt to bias transcription.

With **no STT key at all**, STT still works via the browser model; if that too is
unavailable, the UI keeps text input working and explains what to configure.

### Capture

`getUserMedia` + `MediaRecorder` record an opus-first clip. Two modes:
**push-to-talk** (hold Space / the Talk button) and **hands-free VAD** (Silero
ONNX via `@ricky0123/vad-web`) which auto-starts/ends a turn and enables
**barge-in** (speaking over the agent cancels its TTS + in-flight chat). The mic
needs a **secure context** — `localhost` or **HTTPS** in production (see
[`deploy.md`](deploy.md)).

---

## Text-to-speech (TTS)

TTS is a router (`lib/tts/index.ts`, `engine: 'web-speech' | 'openai' |
'kokoro'`) with a global `stop()` for barge-in. Each engine also determines how
the mouth is driven (see lip-sync below).

| Engine | Env | Cost | Lip-sync path |
|---|---|---|---|
| **Web Speech** (default) | none | $0 | estimated envelope |
| **OpenAI `gpt-4o-mini-tts`** | `OPENAI_API_KEY` | hosted | real FFT analyser |
| **Kokoro-82M** (stretch, local) | none (WebGPU) | $0 | real FFT analyser |

- **Web Speech API** — zero infra, uses the OS voices. Text is chunked into
  sentence-sized utterances to dodge Chrome's ~15 s truncation bug.
- **OpenAI TTS** — `/api/tts` streams `gpt-4o-mini-tts` audio bytes
  (`OPENAI_API_KEY`, server-side only) so playback starts before the clip
  finishes; higher fidelity and real FFT lip-sync.
- **Kokoro** — all-local WebGPU voice (stretch), same real-FFT path as OpenAI.

---

## The two lip-sync paths

The mouth is driven by `wawa-lipsync` (`lib/lipsync.ts`), which needs to *tap the
audible audio*. Whether it can do that depends on the TTS engine:

1. **Real FFT analyser** (`mouthSource: 'analyser'`) — for **OpenAI** and
   **Kokoro**, audio plays through an `<audio>` element wired into the shared
   `AudioContext` (`source → AnalyserNode → destination`). The AnalyserNode reads
   the true amplitude + viseme spectrum every animation frame, so the mouth
   shape matches the actual sound.

2. **Estimated envelope** (`mouthSource: 'estimated'`) — for **Web Speech**.
   `SpeechSynthesis` exposes **no tappable audio node**, so there is nothing for
   the analyser to read. Instead `getEstimatedFeatures(text, elapsedMs)`
   synthesizes a plausible amplitude envelope from `onboundary` word events and
   estimated duration. It looks right but is an approximation, not the real
   waveform — which is why OpenAI/Kokoro lip-sync is visibly tighter.

Both paths feed the same `{ volume, viseme, visemeScores }` shape into the face's
mouth range, so the renderer treats them identically (see
[`face.md`](face.md)).

---

## Requirements at a glance

- **Mic** needs `localhost` or **HTTPS** (browsers block `getUserMedia` on
  insecure origins).
- **Browser Whisper** needs cross-origin isolation (COOP/COEP headers, already
  configured) and, ideally, **WebGPU** (falls back to WASM).
- **All provider keys** (`GROQ_API_KEY`, `OPENAI_API_KEY`) are **server-side
  only** — never `NEXT_PUBLIC_*`. Missing keys degrade to the free browser path.
