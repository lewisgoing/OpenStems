# 0005: Desktop shell

Date: 2026-11-20. Status: accepted (Electron, the plan's default).

## Decision

Electron 45 with React 19, TypeScript, Vite 8 (through electron-vite), Tailwind 4, Base UI and
TanStack Query. The open decision "Desktop shell: Electron or Tauri 2" stays at Electron:
`webContents.startDrag` and `webUtils.getPathForFile` are first-party, and the UI can be driven
by Playwright.

## How the shell is put together

- **Security**: context isolation on, sandbox on, Node integration off, a strict Content
  Security Policy, no new windows, no navigation. The preload exposes one small typed object,
  `window.openstems` (`app/electron/bridge.d.ts`).
- **Engine lifecycle**: the main process starts `openstems serve --parent-pid <its pid>`, reads
  the JSON line with port and token, waits for the health check, and hands both to the UI. On
  quit it kills the engine's process tree; the engine also exits on its own when the app's
  process is gone. One app instance is allowed.
- **Drag-in**: files and folders dropped anywhere in the window; the preload resolves real paths
  with `webUtils.getPathForFile`. The "Add files" button uses a file input that goes through
  the same code.
- **Drag-out**: a stem row, the "Drag all" handle, and the stems chip on a job or history row
  call `webContents.startDrag` with `files` (several paths) and an icon.
- **Playback**: every stem is decoded into a Web Audio buffer and all sources start at the same
  context time, so stems are sample-aligned. Solo and mute are gain changes. Audio is only
  loaded when Play is pressed; the waveforms come from the peaks files.
- **State**: TanStack Query holds server state; the single WebSocket patches the cache, so
  progress never triggers a refetch.

## Deviations from the plan

1. **Components are hand-authored in the shadcn style on Base UI** (`src/components/ui.tsx`),
   not generated with the shadcn CLI. Base UI is one of the primitive libraries shadcn targets;
   writing the handful of components directly kept the motion rules below in one stylesheet.
2. **No wavesurfer.js.** The waveform is two canvases drawn from the peaks file, with the played
   part revealed by a clip-path. That needs no audio decoding to draw, costs nothing on the main
   thread while playing, and keeps the playhead of every stem in lockstep.
3. **`cleanup` shows as two recipes**, as in ADR 0003.

## Motion and feel

The interface follows a small set of rules, all in `src/styles.css`:

- Every pressable element scales to 0.97 on press. Transitions name their properties.
- Popups scale from their trigger (`--transform-origin`), start at 0.96, never at 0, and close
  faster than they open. Dialogs stay centered.
- Custom ease-out curves; interface transitions stay under 300 ms.
- Keyboard-initiated actions never animate: Ctrl+1 to 4 switch views at once, arrow keys move a
  segmented control at once, Space toggles playback.
- Progress bars and the playhead move by transform or clip-path only.
- The first tooltip waits; neighbouring ones then open at once.
- How often something is seen decides how much it moves. The queue cascades its rows once per
  session, the first time it is shown; after that rows appear without a stagger. Views that
  are opened all the time (History, Models, the stems of a job) show their rows at once, and
  the stems panel slides in only when it appears, not each time another job is picked.
- Toggles used constantly (solo, mute) and anything the keyboard can also trigger (the view
  switcher) change color at once; only the press itself scales.
- Entrances use transitions and `@starting-style` rather than keyframes.
- Hover never eases on rows: the highlight and the row's action buttons are there the moment
  the pointer is. A waveform dims at once with its solo or mute button.
- A progress bar eases forward and snaps when its value drops, so it never slides backwards.
- A toast's timer pauses while the pointer is over it and while the window is hidden.
- Every exit is shorter than its entrance, tooltips and the dialog backdrop included. Under
  reduced motion the indeterminate progress bar pulses instead of sliding; the spinner stays.
- Hover styles apply only to devices that hover. Reduced motion keeps fades and drops movement.

## Testing

- **Component tests** (Vitest, Testing Library): queue rows per job state, reorder, drag
  handles, solo and mute, the segmented control's keyboard rule, naming preview, job requests.
- **End-to-end** (Playwright driving Electron, FakeEngine): three formats in and three finished
  jobs, stem preview and drag-out, non-ASCII paths, recipes and the other views, cancel and
  retry, and no engine process left after quit. It runs in CI on a Windows runner.
- **Real engine**: `e2e/real-engine.spec.ts` runs a song through the app on the GPU. It is not
  part of CI.

## What automation cannot check

- **The native drag itself.** A real drag blocks until the mouse is released, so in tests the
  main process records the file paths it would hand to the OS instead of starting the drag.
  Dropping onto the FL Studio Playlist and into Explorer was tried by hand on 2026-11-20
  and works for one stem and for all stems.
- **A real drop from Explorer.** The tests feed files through the file input, which shares the
  path-resolution code with the drop handler.
