# The Face

The face is a ~4,700-particle 3D point cloud (the ported **EIDOLON** renderer)
that morphs between **12 emotions** and lip-syncs its mouth to real audio. It is
stateless UI: the orchestrator tells it *what to feel* and *how open the mouth
is*, and the particles smoothly lerp toward that target every frame.

Geometry + colors live in [`lib/face-points.ts`](../../../lib/face-points.ts);
the renderer is [`components/agent-face.tsx`](../../../components/agent-face.tsx);
the on-screen HUD + keyboard shortcuts are
[`components/face-hud.tsx`](../../../components/face-hud.tsx). Emotion selection
logic is [`lib/face/emotion-machine.ts`](../../../lib/face/emotion-machine.ts).

---

## The 12 emotions

Every emotion is a named entry in `EMOTIONS` / `EMOTION_META`. Each carries a
label, a keyboard key, an accent color, a slight head rotation, and a HUD status
line. These are the exact 12 emotions in `lib/face-points.ts`:

| Emotion | Key | Accent | When the state machine picks it |
|---|---|---|---|
| `neutral` | `1` | `#59f2ff` | idle / resting (default) |
| `thinking` | `2` | `#73a6ff` | transcribing or waiting on the brain |
| `speaking` | `3` | `#4dffbf` | streaming / TTS is playing (mouth is audio-driven) |
| `happy` | `4` | `#8cff73` | success; transient, decays back to resting |
| `alert` | `5` | `#ff8c26` | listening (VAD/PTT active) |
| `sad` | `6` | `#4f74d6` | failure |
| `angry` | `7` | `#ff3b30` | model directive only |
| `surprised` | `8` | `#ffd54a` | transient; decays back to resting |
| `confused` | `9` | `#9fc4d8` | clarifying / ambiguous request |
| `sleepy` | `0` | `#5c6fa8` | model directive only (low-power idle) |
| `love` | `Q` | `#ff4f9e` | model directive only |
| `glitch` | `W` | `#ff007a` | error |

> The full lifecycle→emotion mapping lives in `nextEmotion(phase, signals)`:
> `idle→neutral`, `listening→alert`, `transcribing`/`waiting→thinking`,
> `streaming`/`speaking→speaking`, `clarifying→confused`, `error→glitch`,
> `success→happy`, `failure→sad`. Emotions with no lifecycle phase
> (`angry`, `sleepy`, `love`, plus the others) are reachable via a **model
> directive** or the keyboard.

---

## The `[[face:<emotion>]]` directive

The brain can steer expression by emitting a directive token inside its reply.
The orchestrator **strips every directive before the text is spoken** (so it is
never read aloud) and applies the **last valid** directive as the *resting
emotion* the face settles into after speaking.

- Syntax: `[[face:<emotion>]]` — also accepts `[[emotion:<emotion>]]`.
- Case-insensitive and whitespace-tolerant: `[[Face: Happy ]]` works.
- The `<emotion>` word must be one of the 12 above; a hallucinated
  `[[face:banana]]` is stripped but ignored (no emotion change).

```text
Reply from the brain:   Sure, I fixed the build. [[face:happy]]
Spoken aloud:           Sure, I fixed the build.
Resting emotion after:  happy
```

If no directive is present, a keyword-sentiment fallback
(`emotionFromReply`) picks a resting emotion: `error`/`failed → sad`,
`warning → alert`, `clarify`/`unclear → confused`, `success`/`done → happy`,
else `neutral`. Transient reactions (`happy`, `surprised`) auto-decay back to
the resting emotion after `TRANSIENT_HOLD_MS` (2200 ms).

The persona system prompt ([`lib/persona.ts`](../../../lib/persona.ts)) teaches
the model this directive form and lists all 12 emotions so it uses the real
vocabulary.

---

## How the particle geometry works

`COUNTS` splits the point cloud into feature groups, and `TOTAL` is their sum:

| Group | Particles |
|---|---|
| `head` | 3000 |
| `leftEye` / `rightEye` | 420 each |
| `mouth` | 660 |
| `leftBrow` / `rightBrow` | 200 each |
| **`TOTAL`** | **4700** |

`RANGES` maps each group to a `[start, end)` slice of the flat particle buffer,
so the renderer can deform just the mouth (for lip-sync) or just the brows (per
emotion) without touching the rest.

`buildTargets(emotion)` returns the target `positions` (a
`Float32Array(TOTAL * 3)`) and per-particle `colors` for an emotion: the head is
a shared shell, and each emotion places its eyes/mouth/brows and tints every
particle with `EMOTION_META[emotion].rgb`. The renderer lerps the live particles
toward these targets each frame, which is what produces the smooth morph, blink,
and breathing motion. When `speaking`, the mouth range is additionally driven by
the live lip-sync amplitude/viseme (see [`voice.md`](voice.md)).

---

## Customizing colors and emotions

Everything cosmetic is data, edited in `lib/face-points.ts`:

- **Recolor an emotion** — change its `hex` + `rgb` (and optional `rotation` /
  `status`) in `EMOTION_META`. `rgb` is `[r, g, b]` in `0..1` and drives the
  actual particle color; `hex` is the HUD swatch.
- **Retune a face shape** — edit that emotion's branch inside `buildTargets`
  (the per-emotion target builders that position eyes, mouth, and brows around
  the `EYE_X/EYE_Y/MOUTH_Y/BROW_Y` landmark constants).
- **Add an emotion** — add it to the `Emotion` union + `EMOTIONS`, give it an
  `EMOTION_META` entry (with a free keyboard `key`), and add its branch in
  `buildTargets`. To make the brain able to request it, it must also be one of
  the emotions listed in `lib/persona.ts`.

---

## Keyboard shortcuts

The HUD binds the emotion keys globally (via `EMOTION_META[e].key`) so you can
cycle every state by hand — useful for demos and visual QA:

```
1 neutral   2 thinking   3 speaking   4 happy    5 alert     6 sad
7 angry     8 surprised  9 confused   0 sleepy   Q love      W glitch
```

Press `1`–`0`, `Q`, or `W` (or click the on-screen emotion buttons) to switch
state; the face morphs to the selected emotion with the same transition the
orchestrator uses.
