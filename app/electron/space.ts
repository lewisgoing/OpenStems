/**
 * Free space on the drive a folder is on, for the welcome's folder step. Pure: the file
 * system is passed in, so the walk is tested on any machine (`src/test/welcome.test.tsx`).
 */

export interface FolderSpace {
  /** Bytes free to this user on the drive or volume that holds the folder. */
  free: number
  /** The size of that drive or volume. */
  total: number
}

/**
 * The folder itself, or the nearest folder above it that exists: a folder picked in the
 * welcome may not exist yet (the engine makes it on the first run), but its drive does.
 * Null when nothing up to the root exists (an unplugged drive).
 */
export function existingAncestor(path: string, exists: (path: string) => boolean, parent: (path: string) => string): string | null {
  let current = path
  for (let i = 0; i < 64; i++) {
    if (exists(current)) return current
    const up = parent(current)
    if (up === current) return null
    current = up
  }
  return null
}

/** `statfs` figures as free and total bytes. `bavail` is what an ordinary user may write. */
export function spaceOf(stats: { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }): FolderSpace {
  const size = Number(stats.bsize)
  return { free: Number(stats.bavail) * size, total: Number(stats.blocks) * size }
}
