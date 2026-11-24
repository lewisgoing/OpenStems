import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TempoKey } from '@/components/TempoKey'
import { formatBpm, parseBpm, parseKey, tempoKeyOf } from '@/lib/tempokey'

afterEach(cleanup)

describe('a typed tempo and key', () => {
  it('reads a tempo, and refuses what is not one', () => {
    expect(parseBpm('140')).toEqual({ ok: true, value: 140 })
    expect(parseBpm(' 87,5 ')).toEqual({ ok: true, value: 87.5 })
    expect(parseBpm('139.989')).toEqual({ ok: true, value: 139.99 })
    // Empty is "none": detect it before a run, no tempo after.
    expect(parseBpm('  ')).toEqual({ ok: true, value: null })
    for (const bad of ['fast', '19', '1000', '0', '-120']) expect(parseBpm(bad).ok).toBe(false)
  })

  it('writes a key the way detection does', () => {
    expect(parseKey('Am')).toEqual({ ok: true, value: 'Am' })
    expect(parseKey(' f# ')).toEqual({ ok: true, value: 'F#' })
    // A flat becomes the sharp that sounds the same.
    expect(parseKey('Bb')).toEqual({ ok: true, value: 'A#' })
    expect(parseKey('ebm')).toEqual({ ok: true, value: 'D#m' })
    expect(parseKey('')).toEqual({ ok: true, value: null })
    for (const bad of ['H', 'A minor', 'Amaj', '12']) expect(parseKey(bad).ok).toBe(false)
  })

  it('shows a tempo without a needless decimal', () => {
    expect(formatBpm(120)).toBe('120')
    expect(formatBpm(87.5)).toBe('87.5')
    expect(formatBpm(null)).toBe('')
    expect(tempoKeyOf({ bpm: 105, key: 'C' })).toEqual({ bpm: 105, key: 'C' })
    expect(tempoKeyOf({ bpm: null, key: '' })).toEqual({ bpm: null, key: null })
    expect(tempoKeyOf(undefined)).toEqual({ bpm: null, key: null })
  })
})

describe('the tempo and key fields', () => {
  const show = (props: Partial<Parameters<typeof TempoKey>[0]> = {}) => {
    const onChange = vi.fn()
    const onError = vi.fn()
    render(<TempoKey bpm={105} keyName="C" hint="Type over it." onChange={onChange} onError={onError} {...props} />)
    const tempo = screen.getByLabelText<HTMLInputElement>('Tempo in BPM')
    const key = screen.getByLabelText<HTMLInputElement>('Key')
    return { onChange, onError, tempo, key }
  }

  it('show the song and save what is typed over them on Enter', async () => {
    const { onChange, onError, tempo, key } = show()
    expect(tempo.value).toBe('105')
    expect(key.value).toBe('C')

    await userEvent.clear(tempo)
    await userEvent.type(tempo, '210{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ bpm: 210 })
    await userEvent.clear(key)
    await userEvent.type(key, 'bbm{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ key: 'A#m' })
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('save nothing when the figure is the same, and none when the field is emptied', async () => {
    const { onChange, tempo, key } = show()
    await userEvent.clear(tempo)
    await userEvent.type(tempo, '105.0{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.clear(key)
    await userEvent.tab()
    expect(onChange).toHaveBeenLastCalledWith({ key: null })
  })

  it('refuse a bad figure, say why and show the song again', async () => {
    const { onChange, onError, tempo } = show()
    await userEvent.clear(tempo)
    await userEvent.type(tempo, 'fast{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('The tempo must be a number.')
    expect(screen.getByLabelText<HTMLInputElement>('Tempo in BPM').value).toBe('105')
  })

  it('show the song again when saving fails', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('a file with the new name is already in the stem folder'))
    const { onError, tempo } = show({ onChange })
    await userEvent.clear(tempo)
    await userEvent.type(tempo, '99{Enter}')
    await waitFor(() => expect(onError).toHaveBeenCalledWith('a file with the new name is already in the stem folder'))
    expect(screen.getByLabelText<HTMLInputElement>('Tempo in BPM').value).toBe('105')
  })

  it('say that an empty field is detected, before a song runs', () => {
    const { tempo, key } = show({ bpm: null, keyName: null, empty: 'auto' })
    expect(tempo.placeholder).toBe('auto')
    expect(key.placeholder).toBe('auto')
    expect(tempo.value).toBe('')
  })
})
