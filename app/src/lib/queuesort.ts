/**
 * The queue's order and search, as plain functions. The engine lists jobs in the order they
 * run; what the list shows is a choice of the person looking at it, kept in local storage.
 */

export type QueueSort = 'newest' | 'oldest' | 'name' | 'run'

export const DEFAULT_SORT: QueueSort = 'newest'
export const SORT_KEY = 'openstems.queue.sort.v1'

export const SORTS: { value: QueueSort; label: string; description: string }[] = [
  { value: 'newest', label: 'Newest', description: 'The song added last comes first' },
  { value: 'oldest', label: 'Oldest', description: 'The song added first comes first' },
  { value: 'name', label: 'Name', description: 'A to Z' },
  { value: 'run', label: 'Run order', description: 'The order songs are separated in: drag to change it' },
]

export function isQueueSort(value: unknown): value is QueueSort {
  return SORTS.some((sort) => sort.value === value)
}

export function loadSort(): QueueSort {
  try {
    const stored = localStorage.getItem(SORT_KEY)
    return isQueueSort(stored) ? stored : DEFAULT_SORT
  } catch {
    return DEFAULT_SORT
  }
}

export function saveSort(sort: QueueSort): void {
  try {
    localStorage.setItem(SORT_KEY, sort)
  } catch {
    // A full or closed store: the pick lasts for this session only.
  }
}

/** A row of the queue: a job, or a song still being fetched from a link. */
interface Sortable {
  name: string
  created_at: number
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * `rows` (in the engine's order: jobs as they run, then the links being fetched) as the list
 * shows them. Songs added in the same instant keep a steady place: the later one in the
 * engine's order counts as newer.
 */
export function sortQueue<T extends Sortable>(rows: readonly T[], sort: QueueSort): T[] {
  if (sort === 'run') return [...rows]
  const age = (a: [T, number], b: [T, number]) => a[0].created_at - b[0].created_at || a[1] - b[1]
  const compare: (a: [T, number], b: [T, number]) => number =
    sort === 'oldest' ? age : sort === 'newest' ? (a, b) => age(b, a) : (a, b) => byName.compare(a[0].name, b[0].name) || age(b, a)
  return rows
    .map((row, index): [T, number] => [row, index])
    .sort(compare)
    .map(([row]) => row)
}

/** Lower case, with accents taken off: "beyonce" finds "Beyoncé". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

/** The words of a search, ready to match. Empty when there is nothing to search for. */
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

/** Every word of the search is somewhere in one of the texts, in any order. */
export function matchesSearch(terms: readonly string[], ...texts: (string | null | undefined)[]): boolean {
  if (terms.length === 0) return true
  const hay = fold(texts.filter(Boolean).join(' '))
  return terms.every((term) => hay.includes(term))
}
