import { describe, expect, it } from 'vitest'
import type { Recipe } from '@/api/client'
import { StemPlayer } from '@/audio/player'
import { basename, formatBytes, formatPercent, formatTime, previewName, stemColor } from '@/lib/format'
import { type Selection, toJobRequest } from '@/state/selection'

describe('format', () => {
  it('formats sizes, times and percentages', () => {
    expect(formatBytes(699_412_152)).toBe('667 MB')
    expect(formatBytes(1_368_919_887)).toBe('1.3 GB')
    expect(formatBytes(4613)).toBe('5 KB')
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(205.4)).toBe('3:25')
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatPercent(0.456)).toBe('46%')
    expect(formatPercent(7)).toBe('100%')
    expect(basename('C:\\out\\Song - vocals.wav')).toBe('Song - vocals.wav')
  })

  it('previews a naming template the way the engine fills it', () => {
    const tokens = { track: 'My Song', stem: 'vocals', bpm: '128', key: 'Am' }
    expect(previewName('{track} - {stem}', tokens)).toBe('My Song - vocals')
    expect(previewName('{track} - {bpm} - {stem}', { ...tokens, bpm: '' })).toBe('My Song - vocals')
    expect(previewName('{bpm} {key} {track} - {stem}', tokens)).toBe('128 Am My Song - vocals')
    expect(previewName('{track}: {stem}', tokens)).toBe('My Song_ vocals')
  })

  it('gives every stem a stable color', () => {
    expect(stemColor('vocals')).toBe(stemColor('Vocals'))
    expect(stemColor('saxophone')).toBe(stemColor('saxophone'))
    expect(stemColor('saxophone')).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('toJobRequest', () => {
  const base: Selection = { target: 'full-song', quality: 'balanced', sumToMix: true, outputs: ['kick'] }
  const recipe = (patch: Partial<Recipe>): Recipe =>
    ({ id: 'full-song', supports_sum_to_mix: false, selectable_outputs: false, ...patch }) as Recipe

  it('sends sum-to-mix only for recipes that support it', () => {
    expect(toJobRequest(base, recipe({ supports_sum_to_mix: true }), ['a.wav'])).toEqual({
      paths: ['a.wav'],
      recipe: 'full-song',
      quality: 'balanced',
      options: { sum_to_mix: true },
    })
    expect(toJobRequest(base, recipe({}), ['a.wav']).options).toEqual({})
  })

  it('sends the ticked stems for selectable recipes', () => {
    const request = toJobRequest({ ...base, target: 'mega-53' }, recipe({ id: 'mega-53', selectable_outputs: true }), ['a.wav'])
    expect(request.options).toEqual({ outputs: ['kick'] })
  })

  it('turns a model target into a single-model run', () => {
    const request = toJobRequest({ ...base, target: 'model:bs-roformer-sw' }, undefined, ['a.wav'])
    expect(request).toEqual({ paths: ['a.wav'], model: 'bs-roformer-sw', quality: 'balanced', options: {} })
  })
})

describe('StemPlayer solo and mute', () => {
  it('mutes, solos one stem, and adds to the solo set', () => {
    const player = new StemPlayer()
    expect(player.isAudible('vocals')).toBe(true)

    player.toggleMute('vocals')
    expect(player.isAudible('vocals')).toBe(false)
    expect(player.isAudible('drums')).toBe(true)

    // A solo wins over mutes: only soloed stems are heard.
    player.toggleSolo('drums')
    expect(player.isAudible('drums')).toBe(true)
    expect(player.isAudible('bass')).toBe(false)

    player.toggleSolo('bass') // replaces the solo
    expect(player.isAudible('drums')).toBe(false)
    expect(player.isAudible('bass')).toBe(true)

    player.toggleSolo('drums', true) // additive
    expect(player.isAudible('drums')).toBe(true)
    expect(player.isAudible('bass')).toBe(true)

    player.toggleSolo('drums', true)
    player.toggleSolo('bass')
    expect(player.state.soloed.size).toBe(0)
    expect(player.isAudible('vocals')).toBe(false) // still muted
  })

  it('notifies subscribers and reports position 0 before playback', () => {
    const player = new StemPlayer()
    const seen: number[] = []
    const off = player.subscribe((state) => seen.push(state.muted.size))
    player.toggleMute('a')
    off()
    player.toggleMute('b')
    expect(seen).toEqual([1])
    expect(player.position).toBe(0)
  })
})
