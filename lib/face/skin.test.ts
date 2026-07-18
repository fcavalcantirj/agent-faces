import { describe, expect, it, vi } from 'vitest'
import { EMOTIONS } from '@/lib/face-points'
import {
  DEFAULT_SKIN_ID,
  EMOTION_TO_TALKINGHEAD_MOOD,
  FACE_SKIN_IDS,
  createInitialState,
  resolveSkinId,
} from './skin'

describe('face-skin registry', () => {
  it('defaults to eidolon and lists both known skins', () => {
    expect(DEFAULT_SKIN_ID).toBe('eidolon')
    expect(FACE_SKIN_IDS).toEqual(['eidolon', 'talkinghead'])
  })

  it('createInitialState is neutral, not speaking, mouth closed', () => {
    expect(createInitialState()).toEqual({
      emotion: 'neutral',
      speaking: false,
      mouth: { open: 0, viseme: 'viseme_sil' },
    })
  })

  it('maps every one of the 12 emotions to a TalkingHead mood', () => {
    const moods = new Set(['neutral', 'happy', 'angry', 'sad', 'fear', 'disgust', 'love', 'sleep'])
    for (const e of EMOTIONS) {
      expect(EMOTION_TO_TALKINGHEAD_MOOD[e], `mood for ${e}`).toBeDefined()
      expect(moods.has(EMOTION_TO_TALKINGHEAD_MOOD[e])).toBe(true)
    }
  })
})

describe('resolveSkinId', () => {
  it('returns eidolon for eidolon / undefined / null with no warning', () => {
    const warn = vi.fn()
    expect(resolveSkinId('eidolon', { warn })).toBe('eidolon')
    expect(resolveSkinId(undefined, { warn })).toBe('eidolon')
    expect(resolveSkinId(null, { warn })).toBe('eidolon')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps talkinghead only when it is available', () => {
    const warn = vi.fn()
    expect(resolveSkinId('talkinghead', { talkingHeadAvailable: true, warn })).toBe('talkinghead')
    expect(warn).not.toHaveBeenCalled()
  })

  it('degrades talkinghead -> eidolon with a warning when unavailable', () => {
    const warn = vi.fn()
    expect(resolveSkinId('talkinghead', { talkingHeadAvailable: false, warn })).toBe('eidolon')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/TalkingHead/i)
  })

  it('degrades an unknown skin id -> eidolon with a warning', () => {
    const warn = vi.fn()
    expect(resolveSkinId('hologram', { warn })).toBe('eidolon')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/Unknown/i)
  })
})
