# 0011: Songs wait for Start

Date: 2026-11-22. Status: accepted.

This deviates from the plan, where a dropped file runs at once.

## Decision

A file that is dropped or added goes into the queue and waits. It runs when the user presses
Start. A setting, "Start songs automatically", brings back the old behavior. Manual start is
the default.

## How it works

- **A held job.** A queued job can be held: it keeps its place in the list but is not sent to
  the GPU. `JobManager.release` lets one held job go, or all of them; they then run in queue
  order behind whatever is already in line. A held job has no queue position, since it is not
  in line yet. Held jobs are still held after the engine restarts.
- **Who is held.** A new job follows the `auto_start` setting (off by default), unless the
  request says `start: true` or `false`. The watch folder always starts its files: nobody is
  there to press anything. A retry runs: asking again is asking for it to run.
- **API.** `POST /v1/jobs/start` starts every waiting job, `POST /v1/jobs/{id}/start` one.
  A job has `held`. `OPENSTEMS_AUTO_START=1` or `0` overrides the setting.

## What the user sees

- A waiting song reads "Ready to start".
- While songs wait, the queue header has one accent button that says how many it starts:
  "Start 3 songs". Ctrl+Enter does the same. With nothing waiting, the button is not there.
- A waiting row has "Start this one" among its hover actions, for running one song ahead of
  the rest.
- While songs wait, "Add files" steps back to the plain style, so Start is the only accent
  button on the screen.
- The drop overlay says what a drop will do: "Drop to add to the queue" or "Drop to separate".
- The quick-drop window has the same button and row action.
- The tray icon does not show work in progress for songs that only wait.

## Motion

Nothing new moves. The Start button comes and goes with every drop, so it is simply there or
not, and Ctrl+Enter, like every keyboard action, changes the rows at once. The button gives
under the press like the others.

## Why manual by default

The user asked for it: lining up several songs, choosing their order, and then starting, is
how the app is used here. The cost is one more press for a single song, most felt in the
quick-drop window; the setting is one switch away, and the button is the only accent on the
screen when a song waits.

## Testing

- **Engine** (`tests/test_manual_start.py`): held by default, nothing runs by itself, Start
  runs all in order, one job by itself, `start` in a request, the watch folder, the setting,
  cancel and retry of a held job, and held jobs after a restart.
- **Unit**: the button and the row action in both windows, Ctrl+Enter, the status line, and
  the tray's view of waiting songs.
- **End-to-end** (`e2e/manual-start.spec.ts`): songs wait and the tray stays idle, Start runs
  them, one song by itself then Ctrl+Enter, the quick-drop window, and the setting.
