import { Blend, FolderOpen, GripVertical, Layers, Music2, Pause, Play, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type StemFile, type StemSet, fileUrl } from '@/api/client'
import { useEngine } from '@/api/engine'
import { useSetAnalysis } from '@/api/queries'
import { type PlayerState, StemPlayer } from '@/audio/player'
import { cn, formatTime, stemColor } from '@/lib/format'
import { tempoKeyOf } from '@/lib/tempokey'
import { modClick, modKey, words } from '@/platform'
import { capitalize, groupsOf, mixLabel, partName, stemSections, useMixFile } from '@/state/mix'
import { JobNotes } from './Fit'
import { TempoKey } from './TempoKey'
import { useToast } from './toast'
import { Button, IconButton, Tooltip } from './ui'
import { Waveform, useSharedGain } from './Waveform'
import { useTheme } from '@/lib/theme'

export interface StemsPanelProps {
  title: string
  subtitle: string
  directory: string
  stems: StemFile[]
  analysis?: Record<string, unknown>
  /** What did not go as planned, such as a model that ran on the CPU. */
  notes?: string[]
  /** The user changed the tempo or key: the stems as they are now (some may be renamed). */
  onRetagged?: (set: StemSet) => void
  onClose: () => void
}

function useStemPlayer(stems: StemFile[]) {
  const { connection } = useEngine()
  const player = useMemo(
    () => new StemPlayer({ Authorization: `Bearer ${connection.token}` }, window.openstems.info.e2e),
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

export function StemsPanel({ title, subtitle, directory, stems, analysis, notes, onRetagged, onClose }: StemsPanelProps) {
  const setAnalysis = useSetAnalysis()
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
  // What solo and mute leave audible is a mix, and it can leave as one file. With every
  // stem audible there is nothing to write: that is the song.
  const toast = useToast()
  const names = stems.map((s) => s.name)
  const audibleNames = names.filter((name) => player.isAudible(name))
  const partial = audibleNames.length > 0 && audibleNames.length < stems.length
  const mixFile = useMixFile(directory, stems, partial ? audibleNames : null, toast.error)
  const onlyAudible = audibleNames.length === 1 ? stems.find((s) => s.name === audibleNames[0]) : undefined
  const mixPath = onlyAudible ? onlyAudible.path : mixFile.path
  const mixName = capitalize(mixLabel(audibleNames, names, groupsOf(stems)))
  const sections = useMemo(() => stemSections(stems), [stems])
  const grouped = sections.some((section) => section.group)
  const { bpm, key } = tempoKeyOf(analysis)
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
            <TempoKey
              bpm={bpm}
              keyName={key}
              hint="Type over it if it is wrong. File names that hold it, and the tempo FL Studio reads, follow."
              onChange={async (change) => onRetagged?.(await setAnalysis.stemSet.mutateAsync({ directory, ...change }))}
              onError={toast.error}
            />
          </div>
          <JobNotes notes={notes} className="mt-1.5" />
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
        {partial && (
          <Tooltip label={mixPath ? `Drag what you hear as one file: ${mixName}` : 'Writing the mix you hear'}>
            <div
              draggable={Boolean(mixPath)}
              role="button"
              tabIndex={0}
              aria-disabled={!mixPath}
              aria-label={`Drag the mix: ${mixName}`}
              data-testid="drag-mix"
              data-path={mixPath ?? undefined}
              className={cn('btn btn-sm mix-drag', mixPath ? 'pressable stem-handle' : 'text-muted')}
              onDragStart={(event) => (mixPath ? startDrag(event, [mixPath]) : event.preventDefault())}
            >
              {mixPath ? <Blend size={13} /> : <span className="spinner" aria-hidden="true" />}
              {mixPath ? 'Drag mix' : 'Preparing'}
            </div>
          </Tooltip>
        )}
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
        <IconButton label={`Reveal in ${words().fileManager}`} onClick={() => void window.openstems.revealInExplorer(stems[0]?.path ?? directory)}>
          <FolderOpen size={15} />
        </IconButton>
      </div>

      {state.status === 'error' && (
        <p className="m-0 border-b border-line bg-danger/10 px-4 py-2 text-danger" role="alert">
          {state.error}
        </p>
      )}

      <ul className="m-0 flex-1 list-none overflow-y-auto p-2">
        {sections.map((section, index) => (
          <li
            key={section.stems[0]?.path ?? index}
            // Only a set with groups is divided: six plain stems stay one even list.
            className={cn(grouped && index > 0 && 'mt-1 border-t border-line pt-1')}
          >
            {section.group && (
              <GroupHeader
                group={section.group}
                members={section.stems}
                stems={stems}
                directory={directory}
                player={player}
                state={state}
                onError={toast.error}
              />
            )}
            <ul className="m-0 list-none p-0">
              {section.stems.map((stem) => (
                <StemRow
                  key={stem.path}
                  stem={stem}
                  player={player}
                  state={state}
                  dragging={dragging === stem.path}
                  onDragging={setDragging}
                  getProgress={getProgress}
                  onSeek={seek}
                  gain={gain}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <footer className="truncate border-t border-line px-4 py-2 text-[12px] text-faint" title={directory}>
        {directory}
      </footer>
    </aside>
  )
}

const TOGGLE = 'press h-6 w-6 rounded-[5px] border border-transparent text-[11px] font-bold text-muted'
const SOLO_ON = 'border-accent-fg/50 bg-accent/15 !text-accent-fg'
const MUTE_ON = 'border-danger/50 bg-danger/15 !text-danger'

interface StemRowProps {
  stem: StemFile
  player: StemPlayer
  state: PlayerState
  dragging: boolean
  onDragging: (path: string | null) => void
  getProgress: () => number
  onSeek: (fraction: number) => void
  gain: number
}

function StemRow({ stem, player, state, dragging, onDragging, getProgress, onSeek, gain }: StemRowProps) {
  const theme = useTheme()
  const color = stemColor(stem.name, theme)
  const audible = player.isAudible(stem.name)
  const soloed = state.soloed.has(stem.name)
  const muted = state.muted.has(stem.name)
  return (
    <li data-testid="stem-row" className={cn('group/row flex items-center gap-2 rounded-[8px] py-1.5 pr-2 pl-1', dragging && 'bg-raised')}>
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={`Drag ${stem.name}`}
        data-testid="drag-stem"
        data-path={stem.path}
        className="stem-handle pressable flex w-[112px] flex-none items-center gap-1.5 rounded-[6px] py-1 pr-1"
        onDragStart={(event) => {
          onDragging(stem.path)
          startDrag(event, [stem.path])
        }}
        onDragEnd={() => onDragging(null)}
        onPointerUp={() => onDragging(null)}
      >
        <GripVertical size={13} className="flex-none text-faint" />
        <span className="h-2 w-2 flex-none rounded-full" style={{ background: color }} />
        {/* Under its group's heading a part goes by its short name: "lead", not "lead vocals". */}
        <span className="truncate font-medium" title={stem.name}>
          {partName(stem.name, stem.group)}
        </span>
      </div>
      <Waveform peaksPath={stem.peaks} color={color} getProgress={getProgress} onSeek={onSeek} dimmed={!audible} label={stem.name} gain={gain} />
      <div className="flex flex-none items-center gap-0.5">
        <button
          type="button"
          aria-label={`Solo ${stem.name}`}
          aria-pressed={soloed}
          title={`Solo (${modClick()} to add)`}
          className={cn(TOGGLE, soloed && SOLO_ON)}
          onClick={(event) => player.toggleSolo(stem.name, modKey(event) || event.shiftKey)}
        >
          S
        </button>
        <button
          type="button"
          aria-label={`Mute ${stem.name}`}
          aria-pressed={muted}
          title="Mute"
          className={cn(TOGGLE, muted && MUTE_ON)}
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
}

interface GroupHeaderProps {
  group: string
  members: StemFile[]
  stems: StemFile[]
  directory: string
  player: StemPlayer
  state: PlayerState
  onError: (error: unknown) => void
}

/**
 * The heading over the parts of one larger stem: the kit over kick, snare and the rest.
 * The larger stem is not a file of its own, since its parts add up to it. Solo and mute
 * here act on every part at once, and the handle drags the parts out as one file, which
 * the engine writes when the pointer first comes near: a drag needs the file to exist.
 */
function GroupHeader({ group, members, stems, directory, player, state, onError }: GroupHeaderProps) {
  const names = members.map((stem) => stem.name)
  const [wanted, setWanted] = useState(false)
  const file = useMixFile(directory, stems, wanted ? names : null, onError)
  const path = members.length === 1 ? (members[0]?.path ?? null) : file.path
  const preparing = wanted && !path && file.status === 'preparing'
  const soloed = names.every((name) => state.soloed.has(name))
  const muted = names.every((name) => state.muted.has(name))
  const want = () => setWanted(true)
  return (
    <div className="flex items-center gap-2 py-1 pr-2 pl-1" data-testid="stem-group" data-group={group}>
      <Tooltip label={`Drag the ${group} as one file`}>
        <div
          draggable={Boolean(path)}
          role="button"
          tabIndex={0}
          aria-label={`Drag the ${group} as one file`}
          aria-busy={preparing}
          data-testid="drag-group"
          data-path={path ?? undefined}
          className="stem-handle pressable flex w-[112px] flex-none items-center gap-1.5 rounded-[6px] py-1 pr-1"
          onPointerEnter={want}
          onFocus={want}
          onDragStart={(event) => (path ? startDrag(event, [path]) : event.preventDefault())}
        >
          <span className="grid h-[13px] w-[13px] flex-none place-items-center">
            {preparing ? <span className="spinner" aria-hidden="true" /> : <GripVertical size={13} className="text-faint" />}
          </span>
          <span className="truncate font-semibold">{capitalize(group)}</span>
        </div>
      </Tooltip>
      <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{members.length} parts</span>
      <div className="flex flex-none items-center gap-0.5">
        <button
          type="button"
          aria-label={`Solo ${group}`}
          aria-pressed={soloed}
          title={`Solo every part (${modClick()} to add)`}
          className={cn(TOGGLE, soloed && SOLO_ON)}
          onClick={(event) => player.toggleSoloMany(names, modKey(event) || event.shiftKey)}
        >
          S
        </button>
        <button
          type="button"
          aria-label={`Mute ${group}`}
          aria-pressed={muted}
          title="Mute every part"
          className={cn(TOGGLE, muted && MUTE_ON)}
          onClick={() => player.toggleMuteMany(names)}
        >
          M
        </button>
      </div>
    </div>
  )
}
