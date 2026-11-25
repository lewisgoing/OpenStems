# 0026: Search and an order for the queue

Date: 2026-11-24. Status: accepted. Not in `PLAN.md`.

## Decision

The queue's header has a search field and a menu for the order of the list, in the full
window. The list shows the newest song first unless another order is picked.

- **The order is the list's, not the engine's.** The engine still lists and runs jobs in one
  order (`JobManager._order`). What the window shows is sorted in the renderer
  (`sortQueue` in `app/src/lib/queuesort.ts`): Newest (the default), Oldest, Name (A to Z,
  case ignored, "9" before "10") and Run order, the engine's own. Nothing about a run
  changes with the pick, and the API is untouched.
- **Newest first by default**, as the quick-drop window always was: what was just dropped is
  where the eye is, at the top, however long the list has grown. The pick is kept in local
  storage (`openstems.queue.sort.v1`), per window profile, like the recipe selection.
- **Songs being fetched from a link are sorted with the jobs** by when they were added or
  by name. In Run order they come last, where their jobs will appear, as before.
- **Dragging belongs to Run order.** A waiting song's handle sets when it runs, so it is
  there only while the list shows that order; in any other order a waiting row has the
  hollow circle of a song that has not started. The menu's Move to the top and Move to the
  bottom stay in every order: they say what they do, and the row's "Queued, 2 ahead" answers.
  The menu's own line for Run order says that dragging lives there.
- **Search narrows the list** to the rows where every word typed is found, in any order, in
  the song's name or its recipe's (a link: its name or address). Case and accents do not
  count. The count beside "Queue" reads "2 of 14" while it does. Nothing found says so, with
  a button that empties the search; the drop hint is for an empty queue only. Start and Clear
  finished act on the whole queue, not on what the search shows: they say what they do, and
  a search is a way to look.
- **Keys.** Ctrl+F (Cmd+F on a Mac) goes to the field with its text selected. Escape empties
  it, and leaves it once it is empty. Not while the trimmer covers the queue.
- **Nothing moves.** Typing and sorting happen constantly, so rows the search brings back and
  rows that change place are simply there. Only a song new to the queue comes in, as before:
  a row reads once, when it first appears, whether the list has shown it (`enter`).
- **The search is not kept.** It lasts while the queue is shown (and under the trimmer, which
  leaves the view mounted), and is gone after a view switch, like History's.
- **The quick-drop window has neither.** It shows the eight newest songs and always did.

## Mac

The same on both systems. The shortcut is worded and heard through `shortcut` and `modKey`
(`src/platform.ts`), and `src/test/mac.test.tsx` covers Cmd+F with the platform stubbed. Not
seen on a Mac yet.

## Consequences

- Reordering by drag takes one pick of the menu first. That is the price of the default the
  owner asked for; the menu's moves need none.
- Tests that are about rows and not their order pin the list to Run order
  (`localStorage.setItem(SORT_KEY, 'run')`).
