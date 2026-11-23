import { useEffect, useRef, useState } from 'react'

/**
 * Files dropped anywhere in the window. While a drag is over it, it says what the drop will
 * do: run the recipe at once, or with `manual`, add to the queue to wait for Start.
 */
export function DropOverlay({ onDrop, label, manual }: { onDrop: (files: File[]) => void; label: string; manual?: boolean }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    // Only real files from outside the window count: internal drags carry other types.
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'))
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current += 1
      setActive(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current = 0
      setActive(false)
      onDrop([...(event.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [onDrop])

  return (
    <div className="drop-overlay" data-active={active} aria-hidden={!active}>
      <div className="drop-card max-w-[calc(100vw-40px)] rounded-[18px] border-2 border-dashed border-accent/60 bg-surface px-12 py-10 text-center">
        <div className="font-display text-[19px] font-semibold">{manual ? 'Drop to add to the queue' : 'Drop to separate'}</div>
        <div className="mt-1.5 text-muted">{manual ? `${label}, when you press Start` : `Runs ${label}`}</div>
      </div>
    </div>
  )
}
