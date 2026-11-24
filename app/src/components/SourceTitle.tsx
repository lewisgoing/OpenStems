import { cn } from '@/lib/format'
import { dragSource, fileName } from '@/lib/sourcedrag'
import { Tooltip } from './ui'

interface SourceTitleProps {
  name: string
  /** The song's own file. Without one (moved or deleted) the title is plain text. */
  source?: string | null
  className?: string
}

/**
 * A song's name that drags its original file out: into a DAW, a folder, anywhere a file
 * goes. With a fetched link that makes the app a song downloader as well.
 */
export function SourceTitle({ name, source, className }: SourceTitleProps) {
  if (!source) {
    return (
      <span className={cn('truncate', className)} title={name}>
        {name}
      </span>
    )
  }
  return (
    <Tooltip label={`Drag the original song into your DAW or a folder: ${fileName(source)}`}>
      <span
        draggable
        role="button"
        tabIndex={0}
        aria-label={`Drag the original file of ${name}`}
        data-testid="drag-source"
        data-path={source}
        className={cn('source-title stem-handle press', className)}
        onDragStart={(event) => dragSource(event, source)}
      >
        {name}
      </span>
    </Tooltip>
  )
}
