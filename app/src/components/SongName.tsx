import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/format'
import { MAX_NAME, cleanName, fileStem } from '@/lib/songname'
import { SourceTitle } from './SourceTitle'

interface SongNameProps {
  name: string
  /** The song's own file: the title drags it out, and its name is what an emptied field gives. */
  source?: string | null
  className?: string
  /** The field is open. Its owner holds this, so a menu or a key can open it as well. */
  editing: boolean
  onEditing: (editing: boolean) => void
  /**
   * Saves the name; null gives the song its file's name back. A promise that fails puts the
   * old name back and reports why. Absent while the song cannot be renamed (it is running).
   */
  onRename?: (name: string | null) => Promise<unknown>
  onError: (message: string) => void
  /** What a rename does here, for whoever hovers the field. */
  hint: string
  /**
   * A double click on the title opens the field. Off where the first click of the two moves
   * the title away from the pointer (a row that opens the stems panel beside the list): the
   * second would land on something else, so there the menu, the pencil or F2 rename.
   */
  doubleClick?: boolean
}

/**
 * A song's title that can be typed over, in place: its owner's menu or key, or a double click
 * on it, turns it into a field with the name selected. Enter or leaving the field saves,
 * Escape puts back what was there. The field sits exactly where the title was, in the title's
 * own type, so nothing in the row moves; it appears at once, since typing follows it.
 */
export function SongName({ name, source, className, editing, onEditing, onRename, onError, hint, doubleClick = true }: SongNameProps) {
  // The name just typed, shown until the engine's answer is in the list: no flash of the old one.
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => setPending(null), [name])
  // Saved, the list has the new name a moment later and takes over. Should it never come
  // (the engine settled on another spelling), the list's own name is shown again.
  const settle = useRef(0)
  useEffect(() => () => window.clearTimeout(settle.current), [])
  const shown = pending ?? name

  if (editing && onRename) {
    return (
      <NameField
        name={shown}
        own={source ? fileStem(source) : ''}
        className={className}
        hint={hint}
        onError={onError}
        onClose={() => onEditing(false)}
        onSave={(typed) => {
          setPending(typed ?? (source ? fileStem(source) : shown))
          window.clearTimeout(settle.current)
          onRename(typed).then(
            () => {
              settle.current = window.setTimeout(() => setPending(null), 2000)
            },
            (error: unknown) => {
              setPending(null)
              onError(error instanceof Error ? error.message : String(error))
            },
          )
        }}
      />
    )
  }
  return <SourceTitle name={shown} source={source} className={className} onDoubleClick={onRename && doubleClick ? () => onEditing(true) : undefined} />
}

interface NameFieldProps {
  name: string
  /** The file's own name, shown when the field is emptied: that is what the song is then called. */
  own: string
  className?: string
  hint: string
  onSave: (name: string | null) => void
  onError: (message: string) => void
  onClose: () => void
}

function NameField({ name, own, className, hint, onSave, onError, onClose }: NameFieldProps) {
  const field = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(name)
  // Enter and Escape close the field, which blurs it: only the first of them counts.
  const closed = useRef(false)

  useLayoutEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const close = (save: boolean) => {
    if (closed.current) return
    closed.current = true
    onClose()
    if (!save) return
    const typed = cleanName(draft)
    if (!typed.ok) return onError(typed.error)
    // Emptied, the song goes by its file's name: nothing to do when it already does.
    if (typed.value !== name && !(typed.value === null && own === name)) onSave(typed.value)
  }

  return (
    <input
      ref={field}
      className={cn('name-input', className)}
      aria-label="Song name"
      title={hint}
      // Emptied, the field says what the song is then called, and stays wide enough to type in.
      placeholder={own || 'Name'}
      value={draft}
      // In UTF-16 units, where an emoji counts twice: the rule itself counts characters.
      maxLength={MAX_NAME * 2}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => close(true)}
      // The row under the field opens the stems panel on a click, and a double click on a
      // title starts a rename: neither is meant inside the field.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Keys typed into a name are the name's: Space must not play, Escape must not close a panel.
        event.stopPropagation()
        if (event.key === 'Enter') close(true)
        if (event.key === 'Escape') close(false)
      }}
    />
  )
}
