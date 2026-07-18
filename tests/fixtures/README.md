# Test audio fixtures

Real recorded speech — **not** synthetic tones. An STT test scored against a sine
wave proves nothing, and a lip-sync test driven by silence "passes" while the
mouth never moves. These files give both a genuine waveform and a known
ground-truth transcript.

| File | Format | Used by |
|---|---|---|
| `speech-16k.wav` | 16 kHz mono PCM, ~2.5s | STT evals; chromium's fake mic (`--use-file-for-fake-audio-capture` **requires** 16 kHz mono PCM WAV) |
| `speech-16k.webm` | Opus/WebM, ~2.5s | STT evals over the shape `MediaRecorder` actually produces |
| `tts-sample.wav` | 24 kHz mono PCM, ~3.9s | Lip-sync / viseme evals — picked for varied bilabials and open vowels |

Transcripts and the accuracy scorer live in `tests/fixtures/index.ts`. Compare
**normalized** text (`normalizeTranscript`) and score with `transcriptAccuracy` —
never assert a byte-exact string against a probabilistic model.

## Regenerating

Generated on macOS with `say` + `ffmpeg`. Committed as binaries so CI (Linux,
no `say`) does not need to synthesize them.

```bash
cd tests/fixtures

say -v Samantha -o /tmp/stt.aiff "The quick brown fox jumps over the lazy dog."
ffmpeg -y -i /tmp/stt.aiff -ar 16000 -ac 1 -c:a pcm_s16le speech-16k.wav
ffmpeg -y -i /tmp/stt.aiff -ar 16000 -ac 1 -c:a libopus  speech-16k.webm

say -v Samantha -o /tmp/tts.aiff "Hello, I am your agent face. My mouth moves when I speak."
ffmpeg -y -i /tmp/tts.aiff -ar 24000 -ac 1 -c:a pcm_s16le tts-sample.wav
```

If you change the wording, update `SPEECH_TRANSCRIPT` / `TTS_TRANSCRIPT` in
`index.ts` to match, or every STT assertion silently starts scoring against the
wrong target.
