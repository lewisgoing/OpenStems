import { useEffect, useRef, useState } from 'react'
import { linkFrom } from '@/lib/link'

interface DropOverlayProps {
  onDrop: (files: File[]) => void
  /** A link dragged in from a browser: its address bar, a tab, or a link on a page. */
  onLink?: (url: string) => void
  label: string
  manual?: boolean
}

const LINK_TYPES = ['text/uri-list', 'text/x-moz-url']

/**
 * Files and links dropped anywhere in the window. While a drag is over it, it says what the
 * drop will do: run the recipe at once, or with `manual`, add to the queue to wait for Start.
 */
export function DropOverlay({ onDrop, onLink, label, manual }: DropOverlayProps) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const takesLinks = Boolean(onLink)

  useEffect(() => {
    // A link dragged from inside the window is not a drop: only what comes from outside is.
    // (A stem on its way out is a native drag: its own dragstart is cancelled and no dragend
    // follows, so it must not count.)
    let internal = false
    const started = (event: DragEvent) => {
      if (!event.defaultPrevented) internal = true
    }
    const ended = () => {
      internal = false
    }
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'))
    const hasLink = (event: DragEvent) =>
      takesLinks && !internal && !hasFiles(event) && LINK_TYPES.some((type) => event.dataTransfer?.types.includes(type))
    const ours = (event: DragEvent) => hasFiles(event) || hasLink(event)
    const enter = (event: DragEvent) => {
      if (!ours(event)) return
      depth.current += 1
      setActive(true)
    }
    const over = (event: DragEvent) => {
      if (!ours(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!ours(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const drop = (event: DragEvent) => {
      if (!ours(event)) return
      event.preventDefault()
      depth.current = 0
      setActive(false)
      if (hasFiles(event)) {
        onDrop([...(event.dataTransfer?.files ?? [])])
        return
      }
      // A uri-list may carry comment lines; the first address is the link.
      const list = event.dataTransfer?.getData('text/uri-list') ?? ''
      const first = list.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))
      const link = linkFrom(first) ?? linkFrom(event.dataTransfer?.getData('text/plain'))
      if (link) onLink?.(link)
    }
    window.addEventListener('dragstart', started)
    window.addEventListener('dragend', ended)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragstart', started)
      window.removeEventListener('dragend', ended)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [onDrop, onLink, takesLinks])

  return (
    <div className="drop-overlay" data-active={active} aria-hidden={!active}>
      <div className="drop-card max-w-[calc(100vw-40px)] rounded-[18px] border-2 border-dashed border-accent/60 bg-surface px-12 py-10 text-center">
        <div className="font-display text-[19px] font-semibold">{manual ? 'Drop to add to the queue' : 'Drop to separate'}</div>
        <div className="mt-1.5 text-muted">{manual ? `${label}, when you press Start` : `Runs ${label}`}</div>
      </div>
    </div>
  )
}
