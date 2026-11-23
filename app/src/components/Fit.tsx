import { Cpu } from 'lucide-react'
import { type HTMLAttributes, forwardRef } from 'react'
import { type Fit, fitLabel } from '@/lib/memory'
import { cn } from '@/lib/format'

interface FitChipProps extends HTMLAttributes<HTMLSpanElement> {
  fit?: Fit
  /** The sentence that says what will happen, as the chip's own title. Leave it out under a Tooltip. */
  note?: string | null
  /** "too large" without the machine's name, for a list with little room. */
  short?: boolean
}

/**
 * The quiet mark on a model or recipe that is tight or too large for this machine. Nothing
 * when it fits. "Tight" keeps the chip's own grey; only "too large" takes the warning tone.
 * It appears and changes at once: it is a state, seen as often as the row it sits on.
 */
export const FitChip = forwardRef<HTMLSpanElement, FitChipProps>(function FitChip({ fit, note, short, className, ...props }, ref) {
  const label = fitLabel(fit, short)
  if (!label) return null
  return (
    <span
      ref={ref}
      title={note ?? undefined}
      data-testid="fit-chip"
      {...props}
      className={cn('chip flex-none', fit === 'no' && '!text-warn', className)}
      data-fit={fit}
    >
      {label}
    </span>
  )
})

/**
 * What did not go as planned in a job, such as a model that ran on the CPU. One calm line
 * each, cut short with the whole of it in the title, or wrapped where the window is narrow.
 */
export function JobNotes({ notes, wrap, className }: { notes?: string[]; wrap?: boolean; className?: string }) {
  if (!notes || notes.length === 0) return null
  return (
    <div className={cn('text-[12px] text-muted', className)} role="note" data-testid="job-notes">
      {notes.map((note) => (
        <div key={note} className={cn('flex gap-1.5', wrap ? 'items-start' : 'items-center')} title={wrap ? undefined : note}>
          <Cpu size={11} className={cn('flex-none text-faint', wrap && 'mt-[3px]')} aria-hidden="true" />
          <span className={wrap ? 'min-w-0' : 'truncate'}>{note}</span>
        </div>
      ))}
    </div>
  )
}
