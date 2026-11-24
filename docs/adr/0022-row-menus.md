# 0022: A right-click menu on the rows of the queue

Date: 2026-11-23. Status: accepted. Not in `PLAN.md`.

## Decision

A right-click (or the menu key, or Shift+F10) on a song in the queue opens a menu, in the
full window and in the quick-drop window, and on a song still being fetched from a link
(`src/components/RowMenu.tsx`).

- **What it offers** is one plain function, `jobMenuItems(job, handlers)`, from the job's
  state and the actions the window has. An action a window does not pass is not offered.
  - Held: Start now. Finished with stems: Show stems (not for the song already open), Show
    in Explorer (Finder on a Mac). Any song: Show the original in Explorer.
  - Waiting, in the full window: Move to the top, Move to the bottom, where there is
    somewhere to move it. It is the same reorder as dragging the handle (`moveQueued`).
  - Waiting or running: Cancel. Failed or cancelled: Retry.
  - Not waiting and not running: Remove from the list, last, after a line.
  - A link: Try again when it failed, then Cancel or Dismiss. Its two buttons, no more.
- **Nothing in it deletes a file.** Remove from the list leaves the stems where they are, so
  it is not drawn as dangerous. Deleting stems from here would be a new decision (ground
  rule 7).
- **The original may be gone.** Jobs do not say whether their source still exists, so
  `shell:reveal` now answers whether it showed anything, and a missing file is said in a
  toast instead of the click doing nothing.
- **The app's own menu, not a native one.** Base UI's `ContextMenu`, with the `.popup` and
  `.menu-item` styles the selects use: it follows the light and dark theme, scales in from
  the pointer (150 ms in, 100 ms out), and the end-to-end tests can drive it. The row stays
  the list's `<li>` (the trigger renders it), with its handlers and test ids.
- **Text fields keep their own menu.** A right-click in the tempo or key field of a waiting
  song does not open the row's menu.
- **Escape** closes the menu and nothing else: Base UI takes the key first, and the
  quick-drop window hides only on an Escape nobody took.

## Mac

The wording is the platform's ("Finder"). A Control-click on a Mac is a right-click and
opens the same menu. Not seen on a Mac yet.
