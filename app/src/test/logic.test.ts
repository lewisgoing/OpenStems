import { describe, expect, it } from 'vitest'
import type { Recipe } from '@/api/client'
import { StemPlayer } from '@/audio/player'
import { basename, formatBytes, formatPercent, formatTime, previewName, stemColor } from '@/lib/format'
import { linkFrom, linkHost } from '@/lib/link'
import { outputChips } from '@/components/RecipeBar'
import { capitalize, groupsOf, mixLabel, partName, stemSections } from '@/state/mix'
import { type Selection, toJobRequest } from '@/state/selection'

describe('links', () => {
  it('finds the web address in pasted text and nothing else', () => {
    expect(linkFrom('https://youtu.be/abc123')).toBe('https://youtu.be/abc123')
    expect(linkFrom('  https://soundcloud.com/artist/song?si=1\n')).toBe('https://soundcloud.com/artist/song?si=1')
    expect(linkFrom('http://example.com/a.mp3 and more')).toBe('http://example.com/a.mp3')
    for (const text of ['', null, undefined, 'a song title', 'C:\\Music\\song.mp3', 'file:///C:/song.mp3', 'https://', 'https://nodot']) {
      expect(linkFrom(text)).toBeNull()
    }
  })

  it('names the site a link points at', () => {
    expect(linkHost('https://www.youtube.com/watch?v=1')).toBe('youtube.com')
    expect(linkHost('https://artist.bandcamp.com/track/x')).toBe('artist.bandcamp.com')
    expect(linkHost('not a link')).toBe('not a link')
  })
})

describe('mixes', () => {
  it('names a mix for what is in it, the way the engine names the file', () => {
    const six = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
    expect(mixLabel(six, six)).toBe('mix')
    expect(mixLabel(six.slice(1), six)).toBe('no vocals')
    expect(mixLabel(['drums', 'bass'], six)).toBe('drums + bass')
    expect(mixLabel(['drums', 'bass', 'other'], six)).toBe('drums + bass + other')
    expect(mixLabel(['drums', 'bass', 'guitar', 'piano'], six)).toBe('no vocals, other')
    const many = Array.from({ length: 12 }, (_, i) => `s${i}`)
    expect(mixLabel(many.slice(0, 6), many)).toBe('6 stems')
    expect(capitalize('no vocals')).toBe('No vocals')
  })

  // The same cases as the engine's test (`test_a_mix_is_named_for_what_is_in_it`).
  it('calls a group that is all in, or all out, by its own name', () => {
    const kit = ['kick', 'snare', 'hh']
    const every = ['lead vocals', 'backing vocals', ...kit, 'bass', 'guitar', 'piano', 'other']
    const groups = groupsOf([
      ...['lead vocals', 'backing vocals'].map((name) => ({ name, group: 'vocals' })),
      ...kit.map((name) => ({ name, group: 'drums' })),
      { name: 'bass', group: null },
      ...['guitar', 'piano', 'other'].map((name) => ({ name, group: 'melody' })),
    ])
    expect(groups.bass).toBeUndefined()
    expect(mixLabel(kit, every, groups)).toBe('drums')
    expect(mixLabel([...kit, 'bass'], every, groups)).toBe('drums + bass')
    expect(mixLabel(every.filter((name) => !kit.includes(name)), every, groups)).toBe('no drums')
    expect(mixLabel(every.slice(2), every, groups)).toBe('no vocals')
    expect(mixLabel(['kick', 'snare'], every, groups)).toBe('kick + snare')
    expect(mixLabel(['lead vocals', ...kit, 'bass', 'guitar'], every, groups)).toBe('no backing vocals, piano, other')
    expect(mixLabel(every, every, groups)).toBe('mix')
    // Parts of one group with a few of its parts left out go by the group (every-stem's kit).
    const drums = ['kick', 'snare', 'toms', 'hh', 'ride', 'crash', 'other drums']
    const deep = ['lead vocals', 'backing vocals', ...drums, 'bass', 'guitar', 'piano', 'other']
    const deepGroups = { ...Object.fromEntries(Object.entries(groups).filter(([, group]) => group !== 'drums')), ...Object.fromEntries(drums.map((name) => [name, 'drums'])) }
    expect(mixLabel(drums.slice(1), deep, deepGroups)).toBe('drums no kick')
    expect(mixLabel(drums.slice(2), deep, deepGroups)).toBe('drums no kick, snare')
    expect(mixLabel(drums.slice(3), deep, deepGroups)).toBe('drums no kick, snare, toms')
    expect(mixLabel(drums.slice(4), deep, deepGroups)).toBe('ride + crash + other drums')
    expect(mixLabel([...drums.slice(1), 'lead vocals'], deep, deepGroups)).toBe('7 stems')
  })

  it('keeps the parts of a group together and shortens their names under it', () => {
    const stems = [
      { name: 'lead vocals', group: 'vocals' },
      { name: 'backing vocals', group: 'vocals' },
      { name: 'kick', group: 'drums' },
      { name: 'other drums', group: 'drums' },
      { name: 'bass' },
      { name: 'other', group: 'melody' },
    ]
    expect(stemSections(stems).map((s) => [s.group, s.stems.length])).toEqual([['vocals', 2], ['drums', 2], [null, 1], ['melody', 1]])
    expect(stemSections<{ name: string; group?: string }>([{ name: 'a' }, { name: 'b' }]).map((s) => s.group)).toEqual([null, null])
    expect(partName('lead vocals', 'vocals')).toBe('lead')
    expect(partName('other drums', 'drums')).toBe('other')
    expect(partName('kick', 'drums')).toBe('kick')
    expect(partName('vocals', null)).toBe('vocals')
  })

  it('shows a grouped recipe as its groups, each with its number of parts', () => {
    const outputs = ['lead vocals', 'backing vocals', 'kick', 'snare', 'bass', 'guitar']
    const groups = { 'lead vocals': 'vocals', 'backing vocals': 'vocals', kick: 'drums', snare: 'drums', guitar: 'melody' }
    expect(outputChips(outputs, groups)).toEqual([
      { name: 'vocals', parts: 2 },
      { name: 'drums', parts: 2 },
      { name: 'bass', parts: 1 },
      { name: 'melody', parts: 1 },
    ])
    expect(outputChips(['vocals', 'drums'])).toEqual([{ name: 'vocals', parts: 1 }, { name: 'drums', parts: 1 }])
  })
})

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

  it('solos and mutes a group of stems as one', () => {
    const player = new StemPlayer()
    const kit = ['kick', 'snare']
    player.toggleSoloMany(kit)
    expect(kit.every((name) => player.isAudible(name))).toBe(true)
    expect(player.isAudible('bass')).toBe(false)
    player.toggleSoloMany(['bass'], true) // additive
    expect(player.isAudible('bass') && player.isAudible('kick')).toBe(true)
    player.toggleSoloMany(kit) // all of them soloed already: out again
    expect([...player.state.soloed]).toEqual(['bass'])
    player.toggleSoloMany(kit) // replaces the solo
    expect([...player.state.soloed]).toEqual(kit)
    player.toggleSoloMany(kit)

    player.toggleMute('kick')
    player.toggleMuteMany(kit) // one was muted: now both are
    expect(kit.some((name) => player.isAudible(name))).toBe(false)
    player.toggleMuteMany(kit)
    expect(kit.every((name) => player.isAudible(name))).toBe(true)
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
