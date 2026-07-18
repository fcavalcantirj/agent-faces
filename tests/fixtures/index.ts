// Audio fixtures for STT / lip-sync tests.
//
// These are REAL recorded speech (macOS `say` → ffmpeg), not synthetic tones, so
// an STT smoke test has a genuine waveform and a known ground-truth transcript to
// score against. Regenerate with tests/fixtures/README.md if a voice changes.

import { fileURLToPath } from 'node:url'

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url))

/**
 * 2.5s of clear speech, 16 kHz mono PCM — Whisper's native sample rate, and the
 * format chromium's `--use-file-for-fake-audio-capture` requires.
 */
export const SPEECH_WAV = here('speech-16k.wav')

/** Same utterance as `SPEECH_WAV`, Opus/WebM — the shape MediaRecorder produces. */
export const SPEECH_WEBM = here('speech-16k.webm')

/**
 * What `SPEECH_WAV` / `SPEECH_WEBM` actually say. STT output is scored against
 * this rather than compared verbatim — see `normalizeTranscript`.
 */
export const SPEECH_TRANSCRIPT = 'the quick brown fox jumps over the lazy dog'

/** ~3.9s of speech with varied visemes (bilabials + open vowels) for lip-sync. */
export const TTS_WAV = here('tts-sample.wav')

/** What `TTS_WAV` says. */
export const TTS_TRANSCRIPT = 'hello i am your agent face my mouth moves when i speak'

/**
 * Lowercase, strip punctuation, collapse whitespace. STT engines differ on
 * casing/punctuation, so compare normalized forms — never raw strings.
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Word-level accuracy of `actual` against `expected`, 0..1. Counts how many of
 * the expected words appear in order, so a smoke test can assert "mostly right"
 * without demanding a byte-exact transcript from a probabilistic model.
 */
export function transcriptAccuracy(expected: string, actual: string): number {
  const want = normalizeTranscript(expected).split(' ').filter(Boolean)
  const got = normalizeTranscript(actual).split(' ').filter(Boolean)
  if (want.length === 0) return 0

  let matched = 0
  let cursor = 0
  for (const word of want) {
    const at = got.indexOf(word, cursor)
    if (at !== -1) {
      matched++
      cursor = at + 1
    }
  }
  return matched / want.length
}
