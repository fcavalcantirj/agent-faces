import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FaceSkin } from '@/lib/face/skin'
import { createEidolonSkin } from './eidolon-skin'
import { createTalkingHeadSkin, isTalkingHeadAvailable } from './talkinghead-skin'

function implementsFaceSkin(skin: FaceSkin): void {
  expect(typeof skin.id).toBe('string')
  for (const m of ['setEmotion', 'setSpeaking', 'setMouth', 'setViseme', 'mount', 'dispose'] as const) {
    expect(typeof skin[m], `method ${m}`).toBe('function')
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EIDOLON skin controller', () => {
  it('implements the FaceSkin interface and identifies as eidolon', () => {
    const skin = createEidolonSkin()
    implementsFaceSkin(skin)
    expect(skin.id).toBe('eidolon')
  })

  it('setMouth clamps amplitude 0..1 and stores the viseme (ref-based)', () => {
    const skin = createEidolonSkin() as ReturnType<typeof createEidolonSkin> & {
      mouthRef: { current: { open: number; viseme: string } }
    }
    skin.setMouth(2, 'viseme_aa')
    expect(skin.mouthRef.current.open).toBe(1)
    expect(skin.mouthRef.current.viseme).toBe('viseme_aa')

    skin.setMouth(-5)
    expect(skin.mouthRef.current.open).toBe(0)
    // viseme unchanged when omitted
    expect(skin.mouthRef.current.viseme).toBe('viseme_aa')

    skin.setMouth(Number.NaN)
    expect(skin.mouthRef.current.open).toBe(0)
  })

  it('setViseme resolves the dominant viseme into the mouth ref', () => {
    const skin = createEidolonSkin() as ReturnType<typeof createEidolonSkin> & {
      mouthRef: { current: { open: number; viseme: string } }
    }
    skin.setViseme({ viseme_aa: 0.2, viseme_O: 0.9 })
    expect(skin.mouthRef.current.viseme).toBe('viseme_O')
    skin.setViseme({})
    expect(skin.mouthRef.current.viseme).toBe('viseme_sil')
  })

  it('setEmotion / setSpeaking do not throw before mount (no bound view)', () => {
    const skin = createEidolonSkin()
    expect(() => {
      skin.setEmotion('happy')
      skin.setSpeaking(true)
      skin.dispose()
    }).not.toThrow()
  })
})

describe('TalkingHead skin controller (stretch stub)', () => {
  it('implements the FaceSkin interface and identifies as talkinghead', () => {
    const skin = createTalkingHeadSkin()
    implementsFaceSkin(skin)
    expect(skin.id).toBe('talkinghead')
  })

  it('mount with no model warns and calls onUnavailable, never throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onUnavailable = vi.fn()
    const skin = createTalkingHeadSkin({ onUnavailable })
    const container = document.createElement('div')

    expect(() => skin.mount(container)).not.toThrow()
    expect(onUnavailable).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toMatch(/TalkingHead/i)
    expect(() => skin.dispose()).not.toThrow()
  })

  it('setViseme computes non-empty blendshapes for a spoken viseme', () => {
    const skin = createTalkingHeadSkin({ blendshapeSystem: 'arkit' }) as ReturnType<
      typeof createTalkingHeadSkin
    > & { getBlendshapes(): Record<string, number> }
    skin.setViseme({ viseme_aa: 1 })
    expect(skin.getBlendshapes().jawOpen).toBeGreaterThan(0)
  })

  it('isTalkingHeadAvailable is false without a model URL, true with one', () => {
    expect(isTalkingHeadAvailable({})).toBe(false)
    expect(isTalkingHeadAvailable({ NEXT_PUBLIC_TALKINGHEAD_MODEL_URL: '' })).toBe(false)
    expect(
      isTalkingHeadAvailable({ NEXT_PUBLIC_TALKINGHEAD_MODEL_URL: 'https://x/model.glb' }),
    ).toBe(true)
  })
})
