import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Settings } from '@/api/client'
import { JobNotes } from '@/components/Fit'
import { FORMATS, carriesTempo, formatOptions } from '@/components/FormatSelect'
import { TempoSyncHint } from '@/views/SettingsView'

// FL Studio reads a sample's tempo from WAV files only. Stems written as MP3 with tempo sync
// on reached FL with no tempo and no word of why: these say so where the choice is made.

describe('tempo sync and the output format', () => {
  it('knows which formats can carry the tempo', () => {
    expect(FORMATS.filter((f) => carriesTempo(f.value)).map((f) => f.value)).toEqual(['wav32f', 'wav24'])
  })

  it('marks MP3 and FLAC in the format list while tempo sync is on, and nothing while it is off', () => {
    const marked = formatOptions(true).filter((o) => o.trailing).map((o) => o.value)
    expect(marked).toEqual(['flac', 'mp3'])
    expect(formatOptions(false).some((o) => o.trailing)).toBe(false)
    render(<>{formatOptions(true).find((o) => o.value === 'mp3')?.trailing}</>)
    expect(screen.getByText('No tempo')).toHaveAttribute('title', 'FL Studio reads tempo only from WAV files')
  })

  it('says in Settings that an MP3 gets no tempo, and names the option FL Studio needs', () => {
    const settings = (format: Settings['output_format'], tempo_sync = true) => ({ output_format: format, tempo_sync }) as Settings
    const { rerender } = render(<TempoSyncHint settings={settings('mp3')} />)
    expect(screen.getByRole('note')).toHaveTextContent('Your format is MP3, so no tempo is written. Choose WAV to embed it.')
    expect(document.body).toHaveTextContent('Read sample tempo information')
    // FL stretches only samples up to about a minute by itself; a whole stem needs one step.
    expect(document.body).toHaveTextContent('choose Fit to tempo and pick the tempo marked "(embedded)"')
    rerender(<TempoSyncHint settings={settings('wav24')} />)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    rerender(<TempoSyncHint settings={settings('flac', false)} />)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('shows the note a job carries when its stems hold no tempo', () => {
    const note = 'No tempo for FL Studio in these MP3 stems: it reads tempo only from WAV files. Choose WAV to embed it'
    render(<JobNotes notes={[note]} />)
    expect(screen.getByTestId('job-notes')).toHaveTextContent(note)
  })
})
