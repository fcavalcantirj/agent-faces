import { describe, expect, it } from 'vitest'
import {
  SILENCE_VISEME,
  VISEMES,
  dominantViseme,
  emptyVisemeScores,
  isViseme,
  visemeScoresToBlendshapes,
} from './visemes'

describe('viseme vocabulary', () => {
  it('enumerates the 15 Oculus visemes wawa-lipsync emits', () => {
    expect(VISEMES).toHaveLength(15)
    expect(VISEMES).toContain('viseme_sil')
    expect(VISEMES).toContain('viseme_aa')
    expect(VISEMES).toContain('viseme_U')
    // all unique
    expect(new Set(VISEMES).size).toBe(15)
  })

  it('isViseme recognizes canonical labels and rejects junk', () => {
    expect(isViseme('viseme_aa')).toBe(true)
    expect(isViseme('viseme_sil')).toBe(true)
    expect(isViseme('viseme_xx')).toBe(false)
    expect(isViseme('aa')).toBe(false)
    expect(isViseme('')).toBe(false)
  })

  it('emptyVisemeScores zeroes every canonical viseme', () => {
    const z = emptyVisemeScores()
    expect(Object.keys(z)).toHaveLength(15)
    for (const v of VISEMES) expect(z[v]).toBe(0)
  })
})

describe('dominantViseme', () => {
  it('returns the highest-scoring label', () => {
    expect(dominantViseme({ viseme_aa: 0.2, viseme_O: 0.7, viseme_E: 0.1 })).toBe('viseme_O')
  })

  it('returns silence when empty, null, or all-zero', () => {
    expect(dominantViseme({})).toBe(SILENCE_VISEME)
    expect(dominantViseme(null)).toBe(SILENCE_VISEME)
    expect(dominantViseme(undefined)).toBe(SILENCE_VISEME)
    expect(dominantViseme({ viseme_aa: 0, viseme_O: 0 })).toBe(SILENCE_VISEME)
  })

  it('ignores non-finite and negative scores', () => {
    expect(dominantViseme({ viseme_aa: NaN, viseme_O: 0.3 })).toBe('viseme_O')
    expect(dominantViseme({ viseme_aa: -1, viseme_E: 0.2 })).toBe('viseme_E')
  })

  it('falls back to silence when the top label is not a real viseme', () => {
    expect(dominantViseme({ bogus: 0.9 })).toBe(SILENCE_VISEME)
  })
})

describe('visemeScoresToBlendshapes', () => {
  it('oculus mapping is identity over non-zero visemes, clamped to 1', () => {
    const bs = visemeScoresToBlendshapes({ viseme_aa: 0.8, viseme_O: 1.5, viseme_sil: 0 }, 'oculus')
    expect(bs.viseme_aa).toBeCloseTo(0.8)
    expect(bs.viseme_O).toBe(1)
    expect(bs).not.toHaveProperty('viseme_sil') // zero shapes omitted
  })

  it('arkit mapping opens the jaw wide for aa and rounds/puckers for U', () => {
    const aa = visemeScoresToBlendshapes({ viseme_aa: 1 }, 'arkit')
    expect(aa.jawOpen).toBeGreaterThan(0.5)

    const u = visemeScoresToBlendshapes({ viseme_U: 1 }, 'arkit')
    expect(u.mouthPucker).toBeGreaterThan(0)
    expect(u.jawOpen ?? 0).toBeLessThan(aa.jawOpen)
  })

  it('arkit weights are clamped to 1 and silence yields no shapes', () => {
    const bs = visemeScoresToBlendshapes({ viseme_aa: 5 }, 'arkit')
    for (const k in bs) expect(bs[k]).toBeLessThanOrEqual(1)
    expect(visemeScoresToBlendshapes({ viseme_sil: 1 }, 'arkit')).toEqual({})
  })

  it('returns an empty map for null/undefined scores', () => {
    expect(visemeScoresToBlendshapes(null)).toEqual({})
    expect(visemeScoresToBlendshapes(undefined, 'arkit')).toEqual({})
  })
})
