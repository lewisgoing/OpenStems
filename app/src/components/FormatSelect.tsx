import type { Settings } from '@/api/client'
import { usePatchSettings, useSettings } from '@/api/queries'
import { useToast } from './toast'
import { Select, type SelectOption } from './ui'

type Format = Settings['output_format']

/** The file formats stems can be written in. `short` is what a narrow control shows. */
export const FORMATS: { value: Format; label: string; short: string; description: string }[] = [
  { value: 'wav32f', label: 'WAV 32-bit float', short: 'WAV 32', description: 'Lossless, never clips. The default.' },
  { value: 'wav24', label: 'WAV 24-bit', short: 'WAV 24', description: 'Lossless, smaller. Clips above 0 dBFS.' },
  { value: 'flac', label: 'FLAC 24-bit', short: 'FLAC', description: 'Lossless and compressed.' },
  { value: 'mp3', label: 'MP3 320 kbps', short: 'MP3', description: 'Lossy. For sharing, not for mixing.' },
]

/**
 * The formats whose files can hold the tempo FL Studio reads: WAV only, since FL reads tempo
 * from WAV files alone. The same set as `TEMPO_FORMATS` in `engine/.../domain/tempo.py`:
 * change both together.
 */
export const TEMPO_FORMATS: ReadonlySet<Format> = new Set<Format>(['wav32f', 'wav24'])

export const carriesTempo = (format: Format) => TEMPO_FORMATS.has(format)

/**
 * The formats to pick from. With "Tempo-sync for FL Studio" on, the ones that cannot carry
 * the tempo say so at the moment of choosing: the stems would reach FL with no tempo.
 */
export function formatOptions(tempoSync: boolean): SelectOption[] {
  return FORMATS.map((format) =>
    tempoSync && !carriesTempo(format.value)
      ? {
          ...format,
          trailing: (
            <span className="chip flex-none" title="FL Studio reads tempo only from WAV files">
              No tempo
            </span>
          ),
        }
      : format,
  )
}

/**
 * The output format, where files are dropped. It is the same setting as Settings > Output >
 * Format, so there is one format everywhere and the next drop uses what is shown.
 */
export function FormatSelect({ className, compact }: { className?: string; compact?: boolean }) {
  const { data: settings } = useSettings()
  const patch = usePatchSettings()
  const toast = useToast()
  if (!settings) return null
  return (
    <Select
      label="Output format"
      value={settings.output_format}
      options={formatOptions(settings.tempo_sync)}
      onChange={(value) => patch.mutate({ output_format: value as Format }, { onError: toast.error })}
      renderValue={compact ? (option) => FORMATS.find((f) => f.value === option?.value)?.short ?? option?.label : undefined}
      className={className}
      minWidth={260}
    />
  )
}
