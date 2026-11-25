import { cn } from '@/lib/format'
import { dragSource, fileName } from '@/lib/sourcedrag'
import { Tooltip } from './ui'

interface SourceTitleProps {
  name: string
  /** The song's own file. Without one (moved or deleted) the title is plain text. */
  source?: string | null
  className?: string
  /** A double click on the title: where the song can be renamed, that starts it. */
  onDoubleClick?: () => void
}

/**
 * A song's name that drags its original file out: into a DAW, a folder, anywhere a file
 * goes. With a fetched link that makes the app a song downloader as well.
 */
export function SourceTitle({ name, source, className, onDoubleClick }: SourceTitleProps) {
  if (!source) {
    return (
      <span className={cn('truncate', className)} title={name} data-testid="song-title" onDoubleClick={onDoubleClick}>
        {name}
      </span>
    )
  }
  const drag = `Drag the original song into your DAW or a folder: ${fileName(source)}`
  return (
    <Tooltip label={onDoubleClick ? `${drag}. Double-click to rename.` : drag}>
      <span
        draggable
        role="button"
        tabIndex={0}
        aria-label={`Drag the original file of ${name}`}
        data-testid="drag-source"
        data-path={source}
        className={cn('source-title stem-handle press', className)}
        onDragStart={(event) => dragSource(event, source)}
        onDoubleClick={onDoubleClick}
      >
        {name}
      </span>
    </Tooltip>
  )
}
