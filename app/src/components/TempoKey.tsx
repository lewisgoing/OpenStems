import { useState } from 'react'
import { formatBpm, parseBpm, parseKey } from '@/lib/tempokey'
import { CommitInput } from './ui'

export interface TempoKeyChange {
  bpm?: number | null
  key?: string | null
}

interface TempoKeyProps {
  bpm: number | null
  keyName: string | null
  /** What an empty field means, shown in it: "auto" before a song runs, nothing after. */
  empty?: string
  /** Said after the field's name to whoever hovers or uses a screen reader. */
  hint: string
  /** Saves the change. A promise that fails puts back what was there and reports why. */
  onChange: (change: TempoKeyChange) => Promise<unknown> | void
  onError: (message: string) => void
}

/**
 * The tempo and key of a song as two small fields. Detection is sometimes wrong (half or
 * double the tempo, the relative major), so both can be typed over: Enter or leaving the
 * field commits, Escape puts back what was there.
 */
export function TempoKey({ bpm, keyName, empty = '', hint, onChange, onError }: TempoKeyProps) {
  // A field that was refused is made anew, so it shows the song's figure again.
  const [refused, setRefused] = useState(0)
  const refuse = (message: string) => {
    setRefused((n) => n + 1)
    onError(message)
  }
  const save = (change: TempoKeyChange) => {
    void Promise.resolve(onChange(change)).catch((error: unknown) => refuse(error instanceof Error ? error.message : String(error)))
  }
  return (
    <span className="inline-flex flex-none items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
      <label className="chip-field">
        <CommitInput
          key={`bpm-${refused}`}
          className="chip-input tabular"
          inputMode="decimal"
          aria-label="Tempo in BPM"
          title={`Tempo. ${hint}`}
          placeholder={empty}
          value={formatBpm(bpm)}
          onCommit={(text) => {
            const typed = parseBpm(text)
            if (!typed.ok) return refuse(typed.error)
            if (typed.value !== bpm) save({ bpm: typed.value })
          }}
        />
        <span aria-hidden="true">BPM</span>
      </label>
      <label className="chip-field">
        <span aria-hidden="true">Key</span>
        <CommitInput
          key={`key-${refused}`}
          className="chip-input"
          aria-label="Key"
          title={`Key, such as Am or F#. ${hint}`}
          placeholder={empty}
          value={keyName ?? ''}
          onCommit={(text) => {
            const typed = parseKey(text)
            if (!typed.ok) return refuse(typed.error)
            if (typed.value !== keyName) save({ key: typed.value })
          }}
        />
      </label>
    </span>
  )
}
