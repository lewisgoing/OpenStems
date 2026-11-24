# 0020: Light mode

Date: 2026-11-23. Status: accepted. Not in `PLAN.md`, which assumes one dark look.

## Decision

The app has a light theme beside the dark one, and a pick of three: System, Light, Dark.

- **Where the pick lives.** In `shell.json` (`ShellPrefs.theme`, `electron/traylogic.ts`),
  beside the other preferences of the desktop shell. It is not an engine setting: the engine
  has no screen. A missing or unknown value reads as `dark`.
- **Dark by default.** The app looked like this before there was a choice, so nobody's app
  changes under them after an update. A new install starts dark too, which is what the
  screenshots and the README show. One thing does change for existing users: before,
  `themeSource` was left at `system`, so on a light Mac or a light Windows the native menus
  (the menu bar item's Control-click menu among them) were drawn light beside a dark page.
  Under the default pick they are now dark, matching the page.
- **One source of truth.** The main process sets `nativeTheme.themeSource` from the pick
  before any window opens, and again on every change. Electron then answers
  `prefers-color-scheme` with it in every window, so the full window and the quick-drop
  window follow one setting without a message of their own. Native menus and dialogs, and
  on a Mac the window buttons and scrollbars, follow too. Under `system` the theme follows
  the operating system live.
- **The page.** `src/lib/theme.ts` reads that query and sets `data-theme` on the root element
  before the first render; `src/styles.css` swaps the color tokens under
  `:root[data-theme='light']`. Tailwind utilities read the tokens, so components did not
  change. What was not a token (shadows, the tooltip, the dim behind a dialog, the button
  and menu backgrounds) became a variable per theme.
- **What Electron paints itself.** The window's background and, on Windows, the title bar
  buttons drawn over the page are repainted on `nativeTheme`'s `updated` event
  (`windows.recolor`). Their colors are `WINDOW_COLORS` in `traylogic.ts`, the same as
  `--color-bg` and `--color-muted`; a unit test checks the two agree.
- **The switch.** Three icons at the foot of the sidebar, the place a theme switch is looked
  for, and the same pick in words under Settings > Appearance. A pick of light or dark
  shows at once in the page that made it, without waiting for the main process.
- **No animation for the change.** Every color changes in the same frame: for that frame
  `.theme-switching` turns transitions off, so buttons and segmented controls do not fade
  while the rest snaps. Only the switch's thumb slides, as on every segmented control.

## Colors on a light page

- The accent stays lime for fills (the primary button, the play button, a checked switch),
  a little deeper so it holds against white. The lime is too pale for text and thin lines
  on white, so those use a new token, `--color-accent-fg`: the accent itself on a dark
  page, a deep olive (4.8:1) on a light one. Danger, warning and done get deeper shades for
  the same reason, at about 4.7:1.
- Stem colors (`lib/format.ts`) get a deeper shade of their own hue on a light page, at
  least 3:1 against the background, and no two share one (`src/test/theme.test.tsx`). The
  waveform canvas reads them through `useTheme`, since a canvas cannot read a CSS variable.
- Unplayed waveforms fade less on white (42 percent, not 30), where a faded color turns to
  pastel sooner.
- The tooltip stays dark on a light page.

## Mac

Nothing differs in the code: `windowChrome` already leaves a Mac its own window buttons,
and `recolor` repaints only the background there. Not seen on a Mac yet; ADR 0014 lists it.

## Testing

`src/test/theme.test.tsx` (the switch, the shared pick, the stem colors), `tray.test.tsx`
(the preference, the window colors), and `e2e/theme.spec.ts`: both windows turn light, the
pick survives a restart, and System follows `nativeTheme`. Playwright answers
`prefers-color-scheme` with "light" by default; every launch passes `colorScheme: null` so
the pages hear Electron as they do outside the tests. `SHOTS=1 pnpm e2e -g screenshots`
also takes the main views in light (`light-*.png`).
