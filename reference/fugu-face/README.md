# reference/fugu-face — vendored EIDOLON face source

These are the **read-only source files** for the animated particle face that
claude-faces reuses. They come from an earlier spike ("fuguFaces"). They are
bundled here so the build is **self-contained** — you do **not** need any sibling
`../fuguFaces` folder to port the face.

**Do not edit these files in place.** Copy them into the app (per `prd.json` task
"Port the EIDOLON particle face…"), then neutralize branding and wire real
audio-driven lip-sync there.

| File here | Copy to | What it is |
|---|---|---|
| `face-points.ts` | `lib/face-points.ts` | The particle-geometry engine: `Emotion` union, `EMOTIONS`, `COUNTS`, `RANGES`, `EMOTION_META`, `buildTargets`, `TOTAL` (~4,700 particles), 12 emotions. Self-contained. |
| `agent-face.tsx` | `components/agent-face.tsx` | React Three Fiber renderer (`Canvas` + `ParticleFace` + `Dust` + `OrbitControls`). Its mouth is a **fake sine wave** — replace with real `wawa-lipsync` in the app. |
| `face-hud.tsx` | `components/face-hud.tsx` | Cyberpunk HUD overlay + 1-0/Q/W emotion shortcuts. Rename the hardcoded "EIDOLON-01" label to a neutral title. |
| `utils.ts` | `lib/utils.ts` | The `cn()` classname helper (clsx + tailwind-merge). |

## Dependencies these files expect (added by the scaffold task)
`three`, `@react-three/fiber`, `@react-three/drei`, `clsx`, `tailwind-merge`, `react`.
Imports use the `@/` alias (`@/lib/face-points`, `@/lib/utils`), which resolves once
the files land in `lib/` and `components/`.

## Porting notes
- Scrub branding: replace "EIDOLON" / "Hermes" strings with neutral copy ("AGENT FACE").
- Keep all 12 emotions: `neutral, thinking, speaking, happy, alert, sad, angry, surprised, confused, sleepy, love, glitch`.
- The fake `mouthPulse = sin(...)` (~line 85 of `agent-face.tsx`) is what the lip-sync task replaces with a real audio-driven `mouthRef`.
