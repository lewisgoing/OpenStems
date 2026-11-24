/**
 * Dragging a song's own file out by its title: the original, or what a link fetched.
 *
 * The drag is native, so if it is let go over this window the window sees an ordinary
 * file drop and would queue the song again. The path on its way out is remembered until
 * the pointer next moves over the window with no button held (the drag is over by then),
 * and a drop of that one file meanwhile is ignored.
 */

let outgoing: string | null = null

function forget(event: PointerEvent): void {
  if (event.buttons !== 0) return
  outgoing = null
  window.removeEventListener('pointermove', forget)
}

/** Starts the native drag of one song's file. */
export function dragSource(event: { preventDefault: () => void }, path: string): void {
  // The browser's own drag carries no real file: cancel it and start a native one.
  event.preventDefault()
  outgoing = path
  window.removeEventListener('pointermove', forget)
  window.addEventListener('pointermove', forget)
  window.openstems.startDrag([path])
}

/** Whether dropped paths are the title drag coming back: nothing to queue. */
export function isOwnSourceDrop(paths: string[]): boolean {
  if (outgoing === null || paths.length !== 1) return false
  const same = samePath(paths[0] ?? '', outgoing)
  if (same) outgoing = null
  return same
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/')
  // Windows paths compare without case; a Mac's usually do too (APFS is case-insensitive).
  return norm(a).toLowerCase() === norm(b).toLowerCase()
}

/** The file name, extension included: "Song.webm". */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
