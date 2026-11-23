# 0006: Packaging

Date: 2026-11-20. Status: accepted (the plan's default: an installer).

## Decision

An NSIS installer built with electron-builder (`pnpm dist` in `app/`). It installs per user,
with no administrator rights, into `%LOCALAPPDATA%\Programs\OpenStems`, and adds a Start menu
entry. Auto-update and code signing stay out of scope, as the plan says, so Windows SmartScreen
will warn about an unknown publisher on first launch.

## What the installer carries

| Item | Size | Why |
| --- | --- | --- |
| The Electron app | about 110 MB | The shell and UI |
| `resources/bin/uv.exe` | about 55 MB | Creates the Python environment on first run |
| `resources/engine/requirements.txt` | small | Every engine dependency, pinned from `uv.lock` |
| `resources/engine/wheels/` | under 1 MB | OpenStems and the three loaders, pre-built |

The loaders are pinned to git commits (ADR 0002, 0003). `scripts/prepare-package.mjs` builds
their wheels at packaging time, so the user's machine needs neither git nor a compiler. It also
downloads uv at a pinned version and checks its sha256.

The installer does not carry Python, PyTorch or any model: together they are several
gigabytes, and PyTorch's CUDA wheel alone is about 3 GB.

## First run

1. The app finds no environment and shows "Set up the audio engine".
2. `uv venv --python 3.12` creates `%LOCALAPPDATA%\OpenStems\engine-env`. uv downloads its own
   Python, so nothing has to be installed beforehand.
3. `uv pip install --no-deps -r requirements.txt` installs the pinned set, taking the four
   local wheels from `resources/engine/wheels` and PyTorch from the CUDA 13.0 index.
4. `openstems doctor` runs. A problem is logged and shown in Settings; it does not block the
   app.
5. The engine starts. With no model installed, the app offers the recommended set (3.4 GB).

Since ADR 0007 the app first reads the video adapters and installs one of two pinned sets:
`requirements.txt` (NVIDIA) or `requirements-rocm.txt` (AMD Radeon). The steps are otherwise the
same.

A marker file records the app version the environment was built for. A later version of the
app runs the setup again; the same version starts straight away.

## Where things live

| What | Where | On uninstall |
| --- | --- | --- |
| The app | `%LOCALAPPDATA%\Programs\OpenStems` | removed |
| Python environment | `%LOCALAPPDATA%\OpenStems\engine-env` | removed (`build/installer.nsh`) |
| Models | `%LOCALAPPDATA%\OpenStems\models`, or the folder set in Settings | kept |
| Outputs | `%USERPROFILE%\Music\OpenStems`, or the folder set in Settings | kept |
| Settings, user recipes | `%APPDATA%\OpenStems` | kept |
| Logs and diagnostics | `%LOCALAPPDATA%\OpenStems\logs` | kept |
| History index | `%LOCALAPPDATA%\OpenStems\cache` | kept (rebuildable) |

The uninstaller's only extra step is removing `engine-env`, and it skips that during an update.

## Logs and diagnostics

`app.log` (the shell: start, engine status, setup output) and `engine.log` (the engine) sit in
the logs folder. Settings has "Export diagnostics", which writes a zip with system
information, settings, model status and the logs. It holds no audio and no weights.

## What was checked

All on 2026-11-20, on the target machine.

- **Clean profile.** `e2e/packaged.spec.ts` ran the packaged app with `LOCALAPPDATA` and
  `APPDATA` pointed at empty folders, which is what a fresh Windows account looks like to the
  app. It clicked through the setup, waited for Python and PyTorch, confirmed the GPU on the
  Settings page and finished a separation in 1.8 minutes, with no terminal.
- **The real installer.** (The app was then called lew-stems.) `lew-stems-setup-0.1.0.exe /S`
  installed to `%LOCALAPPDATA%\Programs\lew-stems`, added the Start menu shortcut and registered the
  uninstaller. The installed app then ran its first-run setup in the real profile (the doctor
  check reported the RTX 5070 Ti and CUDA 13.0) and finished a separation, again driven only
  through its window.
- **The uninstaller.** Afterwards the app folder, `engine-env` (3.4 GB), the shortcut and the
  registry entry were gone. The models folder (51 files, 9,278,096,988 bytes) and the settings
  file were unchanged, the logs were kept, and no output file was removed.

Not done: creating a second Windows account. The clean-profile run stands in for it.

## Things this turned up

- **One instance per data folder.** The installed app and a development copy (`pnpm dev` or
  `pnpm start`) share Electron's data folder, `%APPDATA%\openstems-app`, so the second one to
  start exits at once. That is the single-instance rule working, but it is worth knowing when
  both are on the machine.
- **Memory, not the installer, was the fragile part.** With another GPU app open and a second
  copy of the engine running, the machine ran out of commit memory and jobs failed with
  "bad allocation" or a CUDA out-of-memory error that reported plenty of free VRAM. The engine
  now retries once after cleaning up, drops other warm models before giving up, and reports a
  failed model load as a memory problem instead of blaming the checkpoint.

## On a Mac (added 2026-11-23)

ADR 0014 adds a Mac build for Apple Silicon. **None of this has been run on a Mac by us.**

`pnpm dist:mac`, run on a Mac, builds `OpenStems-<version>-arm64.dmg` and a zip of the same
app, with `latest-mac.yml`. The app carries uv for `aarch64-apple-darwin` (0.13.6, the same
pinned version, checked against its sha256) and one pin set, `requirements-mps.txt`. First run
is the same five steps with one build and no card detection. PyTorch comes from PyPI, so the
download is about 350 MB instead of about 3 GB. The environment has `bin/python` and
`bin/openstems` where Windows has `Scripts\python.exe` and `Scripts\openstems.exe`.

| What | Where | When the app is removed |
| --- | --- | --- |
| The app | `/Applications/OpenStems.app`, or wherever it was dragged | removed by dragging it to the Trash |
| Python environment | `~/Library/Application Support/OpenStems/engine-env` | stays |
| Models | `~/Library/Application Support/OpenStems/models`, or the folder set in Settings | stays |
| Settings, user recipes | `~/Library/Application Support/OpenStems` | stays |
| Outputs | `~/Music/OpenStems`, or the folder set in Settings | stays |
| Logs and diagnostics | `~/Library/Logs/OpenStems` | stays |
| History index | `~/Library/Caches/OpenStems` | stays (rebuildable) |

A Mac app has no uninstaller. Dragging the app to the Trash removes the app and nothing else,
so `engine-env` (several hundred MB) stays until the user deletes
`~/Library/Application Support/OpenStems/engine-env` by hand. The README says so. Deleting
the whole `OpenStems` folder there also deletes the settings and the downloaded models.

The shell's own preferences (`shell.json`) stay in Electron's data folder, as on Windows:
`~/Library/Application Support/openstems-app`, named after the package. Giving the app its
display name there would move the Windows folder too, and lose existing users' preferences.
The engine (`openstems/settings.py`) and the app (`electron/platform.ts`) each decide these
folders, and must agree.

The app is signed ad hoc unless a Developer ID certificate is supplied: ADR 0014, "Signing".
