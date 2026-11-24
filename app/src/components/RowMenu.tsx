import { ContextMenu } from '@base-ui/react/context-menu'
import { ArrowDownToLine, ArrowUpToLine, FileAudio, FolderOpen, Layers, Play, RotateCcw, Scissors, Trash2, X } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import type { Job, Link } from '@/api/client'
import { words } from '@/platform'

/**
 * The menu a right-click opens on a row of the queue, in the full window and the quick-drop
 * window. What it offers is decided in `jobMenuItems`, from the job's state and the actions
 * the window has: each item is one of the row's own buttons, or a thing the row cannot show
 * for lack of room. Nothing here deletes a file: "Remove from the list" leaves the stems.
 */

export interface MenuItem {
  id: string
  label: string
  icon: ReactNode
  run: () => void
  /** A line above it: the item that changes the list sits apart from the ones that look. */
  separated?: boolean
}

/** What a window can do to a job. An action it leaves out is not offered. */
export interface JobHandlers {
  start?: () => void
  cancel?: () => void
  retry?: () => void
  /** Open this song's stems: the panel in the full window, the row in the quick-drop window. */
  showStems?: () => void
  /** Open the song in the trimmer (the full window only), when it waits to start or is separated. */
  trim?: () => void
  /** Show the stems in Explorer or Finder. */
  reveal?: () => void
  /** Show the song's own file in Explorer or Finder. */
  revealSource?: () => void
  /** Queued songs only, where the queue can be reordered: run it next, or last. */
  moveTop?: () => void
  moveBottom?: () => void
  remove?: () => void
}

const ACTIVE = new Set<Job['state']>(['preparing', 'running', 'writing'])

export function jobMenuItems(job: Pick<Job, 'state' | 'held' | 'stems' | 'track_path'>, on: JobHandlers): MenuItem[] {
  const active = ACTIVE.has(job.state)
  const queued = job.state === 'queued'
  const hasStems = job.state === 'done' && job.stems.length > 0
  const { fileManager } = words()
  const items: (MenuItem | false | undefined)[] = [
    job.held && on.start && { id: 'start', label: 'Start now', icon: <Play size={13} />, run: on.start },
    hasStems && on.showStems && { id: 'stems', label: 'Show stems', icon: <Layers size={13} />, run: on.showStems },
    (queued || hasStems) && on.trim && { id: 'trim', label: 'Trim', icon: <Scissors size={13} />, run: on.trim },
    hasStems && on.reveal && { id: 'reveal', label: `Show in ${fileManager}`, icon: <FolderOpen size={13} />, run: on.reveal },
    Boolean(job.track_path) &&
      on.revealSource && { id: 'source', label: `Show the original in ${fileManager}`, icon: <FileAudio size={13} />, run: on.revealSource },
    queued && on.moveTop && { id: 'top', label: 'Move to the top', icon: <ArrowUpToLine size={13} />, run: on.moveTop, separated: true },
    queued && on.moveBottom && { id: 'bottom', label: 'Move to the bottom', icon: <ArrowDownToLine size={13} />, run: on.moveBottom },
    (job.state === 'failed' || job.state === 'cancelled') && on.retry && { id: 'retry', label: 'Retry', icon: <RotateCcw size={13} />, run: on.retry, separated: true },
    (active || queued) && on.cancel && { id: 'cancel', label: 'Cancel', icon: <X size={13} />, run: on.cancel, separated: true },
    !active && !queued && on.remove && { id: 'remove', label: 'Remove from the list', icon: <Trash2 size={13} />, run: on.remove, separated: true },
  ]
  const kept = items.filter((item): item is MenuItem => Boolean(item))
  // No line above the first item.
  return kept.map((item, index) => (index === 0 && item.separated ? { ...item, separated: false } : item))
}

/** A song being fetched from a link: what its two buttons do, no more. */
export function linkMenuItems(link: Pick<Link, 'state'>, on: { retry: () => void; remove: () => void }): MenuItem[] {
  const failed = link.state === 'failed'
  return [
    ...(failed ? [{ id: 'retry', label: 'Try again', icon: <RotateCcw size={13} />, run: on.retry }] : []),
    { id: 'remove', label: failed ? 'Dismiss' : 'Cancel', icon: <X size={13} />, run: on.remove },
  ]
}

/**
 * The two "Show in" items: the stems (the first one, selected in its folder) and the song's
 * own file. The original may have been moved or deleted since; then `missing` is told.
 */
export function revealHandlers(job: Pick<Job, 'stems' | 'track_path'>, missing: (message: string) => void): Pick<JobHandlers, 'reveal' | 'revealSource'> {
  const show = (path: string, what: string) => () =>
    void window.openstems.revealInExplorer(path).then((shown) => {
      if (!shown) missing(`The ${what} is no longer where it was`)
    })
  return {
    reveal: job.stems[0] ? show(job.stems[0].path, 'stem folder') : undefined,
    revealSource: job.track_path ? show(job.track_path, 'original file') : undefined,
  }
}

/**
 * A row that opens `items` on a right-click (a Control-click on a Mac; on Windows also the
 * menu key or Shift+F10). `render` is the
 * row itself, so the list keeps its own elements and the row keeps its handlers. A
 * right-click in a text field keeps the field's own menu.
 */
export function RowMenu({ items, render, children, label }: { items: MenuItem[]; render: ReactElement<Record<string, unknown>>; children: ReactNode; label: string }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={render}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement
          if (items.length === 0 || target.closest('input, textarea, [contenteditable="true"]')) {
            event.preventBaseUIHandler()
          }
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none" collisionPadding={8}>
          <ContextMenu.Popup className="popup min-w-[200px] p-1" aria-label={label} data-testid="row-menu">
            {items.map((item) => (
              <div key={item.id}>
                {item.separated && <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />}
                <ContextMenu.Item className="menu-item" onClick={item.run}>
                  <span className="grid w-3.5 flex-none place-items-center text-muted">{item.icon}</span>
                  {item.label}
                </ContextMenu.Item>
              </div>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
