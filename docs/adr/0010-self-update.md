# 0010: The app updates itself

Date: 2026-11-22. Status: accepted. First shipped in 0.2.0, so 0.2.0 is the oldest version
that can update itself.

This deviates from the plan, which stops at an installer.

## Decision

An installed OpenStems looks for a newer release on GitHub, says so, and on the user's word
downloads it and restarts into it. Nobody has to go back to the repository for a new version.

The work is done by `electron-updater` (6.8.11) against the releases of
`lewisgoing/OpenStems`, which is why that repository is public.

## What the user sees

- Nothing, while there is nothing new.
- When a newer version exists, a small button in the title bar: **Update to 0.3.0**. The
  quick-drop window has the same button as one word.
- One click downloads it. The button shows the progress.
- Then the button reads **Restart to update**. A click stops the engine, runs the new
  installer silently and starts the new version. The installer is per user, so Windows asks
  nothing.
- With jobs queued or running, the restart asks first, since it stops them.
- Settings > Updates has the same steps, a "Check for updates" button, and a switch for the
  automatic check (on by default).

Nothing is downloaded and nothing is installed unless the user asked. The app checks 15
seconds after it starts and every six hours after that. A check it made by itself says
nothing when it fails (the usual reason is no network); a check the user asked for does.

## Motion

The rules of ADR 0005 hold. The offer is one button from "Update" to "Restart": it arrives
once (a 200 ms fade from 0.96 scale; it is seen about once a month), and after that only what
it says changes, so its entrance never replays. While downloading it fills from the left by
`transform` alone, linear because it tracks real work, with tabular numerals and a fixed
width so the title bar does not twitch. Full, it turns into the solid accent "Restart"
button; background, border and text change together. The restart answers the press at once
with "Restarting", since the engine takes a few seconds to stop. A check shows no spinner:
it is over in a moment.

## How it works

- `electron-builder` is given the repository under `publish`. A build then writes, beside the
  installer, `latest.yml` (the version and the installer's sha512) and a blockmap, and puts
  `app-update.yml` (where to look) into the app.
- A release on GitHub carries those three files. The app reads `latest.yml` from the latest
  release, compares versions, and downloads the installer, which is checked against the
  sha512 before it is run. With the blockmap, only the parts that changed are downloaded.
- `electron/updatelogic.ts` is the state machine (idle, checking, available, downloading,
  ready) with no Electron in it; `electron/updater.ts` is the thin part that talks to
  `electron-updater`. The status goes to every window (`window.openstems.onUpdateStatus`).
- `autoDownload` and `autoInstallOnAppQuit` are off: both steps belong to the user.
- Before the installer takes over, the app destroys the tray and the quick-drop window and
  stops the engine, so nothing of its own holds a file the installer replaces.

## Releasing a version

1. Set the version in `app/package.json`, `engine/pyproject.toml` and
   `engine/src/openstems/__init__.py`; run `uv lock`; give the changelog its heading.
2. Merge to `main`, tag `v<version>` there.
3. `pnpm dist` in `app/`.
4. `gh release create v<version>` with `OpenStems-Setup-<version>.exe`, its `.blockmap` and
   `latest.yml` from `app/release/`.

The release must be a normal one. A draft or a pre-release is invisible to installed apps.
The tag must be `v` plus the version in `package.json`.

## What a new version does after the restart

Up to 0.2.1 the Python environment belonged to a version: after an update the app asked to
set it up again, which took a click and several minutes. From 0.2.2 the new version brings
the existing environment up to date by itself (`EngineSetup.refresh`): it runs the same pinned
install over the environment, and uv skips every requirement that is already satisfied, so
normally only the app's own small package is installed. The window shows "Updating the audio
engine" for the seconds it takes. If that fails, the full setup is offered as before. A first
install and a switch of the engine build still create the environment from scratch.

## Not signed

The installer is not code-signed. An update that the app downloads itself is not stopped by
SmartScreen, because the file never passes through a browser. A first install from a browser
download still gets the SmartScreen prompt. `electron-updater` verifies the sha512 from
`latest.yml`; it cannot verify a publisher, since there is no signature.

## Alternatives considered

- **A notice that opens the download page.** Simpler, but the user asked for the app to
  update itself.
- **Download and install without asking.** Rejected: a restart stops running jobs, and an app
  that fetches 140 MB by itself is not what "runs locally" suggests.
- **A separate public repository for installers**, with the code private. Not needed once the
  repository went public.

## Testing

- **Unit** (`src/test/update.test.tsx`): the state machine with a stand-in for the network:
  a newer version, none, progress, a failed check by itself and on request, a failed
  download, the order of stopping and installing, and an app that cannot update. The button
  in each state, the question before a restart with jobs queued, the Settings rows.
- **End-to-end** (`e2e/update.spec.ts`): with `OPENSTEMS_E2E_UPDATE=0.3.0` the app offers the
  version in both windows, downloads on a click, and installs on a restart; with a job
  running it asks first.
- **Against the real release**: see "Checked against GitHub" below.

## Checked against GitHub

On 2026-11-22, after 0.2.0 was published, a packaged build with its version set to 0.1.9 was
started on a clean profile (`e2e/real-update.spec.ts`). It found 0.2.0 in the latest release,
showed "Update to 0.2.0", downloaded `OpenStems-Setup-0.2.0.exe` (137 MB, about ten seconds)
into the updater's cache, verified it against `latest.yml` and showed "Restart to update".
There was no blockmap for 0.1.9, so it fell back to the full download, as it should. The
test stops there.

The packaged 0.2.0 itself ran first-run setup and a separation on a clean profile with the
NVIDIA build, and first-run setup with the AMD build forced.

## The quick engine update, checked

On 2026-11-22 the packaged 0.2.2 was started on two profiles whose environments were built by
older versions: NVIDIA by 0.2.1 and AMD by 0.2.0. Each time the app replaced one package (its
own) in 0.8 seconds, wrote the new version to the marker and started the engine, with no
click. The first setup of the same profile had taken 75 seconds. A separation then ran on the
updated NVIDIA environment, and the updated AMD environment imports the new package beside
AMD's PyTorch.

## What automation cannot check

The last step, the installer replacing the running app and starting the new version, needs
two published versions and an installed app. It is `electron-updater`'s standard path for a
per-user NSIS installer; the first real update (0.2.0 to the next) is its first run here.
