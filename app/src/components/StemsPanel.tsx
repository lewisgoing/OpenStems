import { FolderOpen, GripVertical, Layers, Music2, Pause, Play, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type StemFile, fileUrl } from '@/api/client'
import { useEngine } from '@/api/engine'
import { StemPlayer } from '@/audio/player'
import { cn, formatTime, stemColor } from '@/lib/format'
import { Button, IconButton, Tooltip } from './ui'
import { Waveform, useSharedGain } from './Waveform'

export interface StemsPanelProps {
  title: string
  subtitle: string
  directory: string
  stems: StemFile[]
  analysis?: Record<string, unknown>
  onClose: () => void
}

function useStemPlayer(stems: StemFile[]) {
  const { connection } = useEngine()
  const player = useMemo(
    () => new StemPlayer({ Authorization: `Bearer ${connection.token}` }),
    [connection.token],
  )
  const state = useSyncExternalStore(
    (listener) => player.subscribe(listener),
    () => player.state,
  )
  const key = stems.map((s) => s.path).join('|')
  useEffect(() => () => player.dispose(), [player, key])

  const playPause = useCallback(async () => {
    if (player.state.status === 'idle' || player.state.status === 'error') {
      await player.load(stems.map((s) => ({ name: s.name, url: fileUrl(connection, s.path) })))
      await player.play()
    } else {
      player.toggle()
    }
  }, [player, stems, connection])

  return { player, state, playPause }
}

function startDrag(event: React.DragEvent, paths: string[]): void {
  // The browser's own drag carries no real file: cancel it and start a native one.
  event.preventDefault()
  window.openstems.startDrag(paths)
}

function Clock({ player }: { player: StemPlayer }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let frame = 0
    let last = ''
    const tick = () => {
      const text = formatTime(player.position)
      if (text !== last && ref.current) {
        last = text
        ref.current.textContent = text
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [player])
  return <span ref={ref}>0:00</span>
}

export function StemsPanel({ title, subtitle, directory, stems, analysis, onClose }: StemsPanelProps) {
  const { player, state, playPause } = useStemPlayer(stems)
  const [dragging, setDragging] = useState<string | null>(null)
  const gain = useSharedGain(stems.map((s) => s.peaks))
  const totalSeconds =
    state.duration || (stems[0]?.samples && stems[0]?.sample_rate ? stems[0].samples / stems[0].sample_rate : 0)

  const getProgress = useCallback(
    () => (totalSeconds > 0 ? player.position / totalSeconds : 0),
    [player, totalSeconds],
  )
  const seek = useCallback(
    (fraction: number) => {
      if (state.status === 'ready') player.seek(fraction * totalSeconds)
    },
    [player, state.status, totalSeconds],
  )

  // Space toggles playback. Keyboard-initiated, so nothing animates.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.code !== 'Space' || target?.closest('input, textarea, [role="combobox"]')) return
      event.preventDefault()
      void playPause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playPause])

  const allPaths = stems.map((s) => s.path)
  const bpm = typeof analysis?.bpm === 'number' ? Math.round(analysis.bpm) : null
  const key = typeof analysis?.key === 'string' ? analysis.key : null
  const loading = state.status === 'loading'

  return (
    <aside className="flex h-full w-[460px] flex-none flex-col border-l border-line bg-surface" aria-label="Stems">
      <header className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate font-display text-[15px] font-semibold" title={title}>
            {title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted">
            <span>{subtitle}</span>
            {bpm !== null && <span className="chip tabular">{bpm} BPM</span>}
            {key && <span className="chip">{key}</span>}
          </div>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="flex items-center gap-2 border-y border-line px-4 py-2.5">
        <Button
          variant="primary"
          size="icon"
          className="!h-8 !w-8 rounded-full"
          aria-label={state.playing ? 'Pause' : 'Play'}
          disabled={loading}
          onClick={() => void playPause()}
        >
          {loading ? <span className="spinner" /> : state.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
        </Button>
        <span className="tabular font-mono text-[12px] text-muted">
          {loading ? `Loading ${state.loaded}/${state.total}` : <><Clock player={player} /> / {formatTime(totalSeconds)}</>}
        </span>
        <span className="flex-1" />
        <Tooltip label="Drag every stem into your DAW or a folder">
          <div
            draggable
            role="button"
            tabIndex={0}
            aria-label="Drag all stems"
            data-testid="drag-all"
            data-paths={JSON.stringify(allPaths)}
            className="btn btn-sm pressable stem-handle"
            onDragStart={(event) => startDrag(event, allPaths)}
          >
            <Layers size={13} />
            Drag all
          </div>
        </Tooltip>
        <IconButton label="Reveal in Explorer" onClick={() => void window.openstems.revealInExplorer(stems[0]?.path ?? directory)}>
          <FolderOpen size={15} />
        </IconButton>
      </div>

      {state.status === 'error' && (
        <p className="m-0 border-b border-line bg-danger/10 px-4 py-2 text-danger" role="alert">
          {state.error}
        </p>
      )}

      <ul className="m-0 flex-1 list-none overflow-y-auto p-2">
        {stems.map((stem) => {
          const color = stemColor(stem.name)
          const audible = player.isAudible(stem.name)
          const soloed = state.soloed.has(stem.name)
          const muted = state.muted.has(stem.name)
          return (
            <li
              key={stem.path}
              data-testid="stem-row"
              className={cn('group/row flex items-center gap-2 rounded-[8px] py-1.5 pr-2 pl-1', dragging === stem.path && 'bg-raised')}
            >
              <div
                draggable
                role="button"
                tabIndex={0}
                aria-label={`Drag ${stem.name}`}
                data-testid="drag-stem"
                data-path={stem.path}
                className="stem-handle pressable flex w-[112px] flex-none items-center gap-1.5 rounded-[6px] py-1 pr-1"
                onDragStart={(event) => {
                  setDragging(stem.path)
                  startDrag(event, [stem.path])
                }}
                onDragEnd={() => setDragging(null)}
                onPointerUp={() => setDragging(null)}
              >
                <GripVertical size={13} className="flex-none text-faint" />
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: color }} />
                <span className="truncate font-medium" title={stem.name}>
                  {stem.name}
                </span>
              </div>
              <Waveform
                peaksPath={stem.peaks}
                color={color}
                getProgress={getProgress}
                onSeek={seek}
                dimmed={!audible}
                label={stem.name}
                gain={gain}
              />
              <div className="flex flex-none items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Solo ${stem.name}`}
                  aria-pressed={soloed}
                  title="Solo (Ctrl+click to add)"
                  className={cn(
                    'press h-6 w-6 rounded-[5px] border border-transparent text-[11px] font-bold text-muted',
                    soloed && 'border-accent/50 bg-accent/15 !text-accent',
                  )}
                  onClick={(event) => player.toggleSolo(stem.name, event.ctrlKey || event.shiftKey)}
                >
                  S
                </button>
                <button
                  type="button"
                  aria-label={`Mute ${stem.name}`}
                  aria-pressed={muted}
                  title="Mute"
                  className={cn(
                    'press h-6 w-6 rounded-[5px] border border-transparent text-[11px] font-bold text-muted',
                    muted && 'border-danger/50 bg-danger/15 !text-danger',
                  )}
                  onClick={() => player.toggleMute(stem.name)}
                >
                  M
                </button>
                {stem.midi && (
                  <Tooltip label="Drag the MIDI file">
                    <div
                      draggable
                      role="button"
                      tabIndex={0}
                      aria-label={`Drag ${stem.name} MIDI`}
                      className="stem-handle pressable grid h-6 w-6 place-items-center rounded-[5px] text-muted"
                      onDragStart={(event) => startDrag(event, [stem.midi ?? ''])}
                    >
                      <Music2 size={13} />
                    </div>
                  </Tooltip>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <footer className="truncate border-t border-line px-4 py-2 text-[12px] text-faint" title={directory}>
        {directory}
      </footer>
    </aside>
  )
}
