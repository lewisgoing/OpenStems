# OpenStems

Local Windows app for stem separation. `PLAN.md` is the spec; follow it phase by phase.

## Commands

Engine (run from `engine/`):

- `uv sync`: install (Python 3.12, PyTorch from the cu130 index: the `cuda` group)
- `UV_PROJECT_ENVIRONMENT=<folder> uv sync --no-default-groups --group rocm --group dev`: the AMD
  (ROCm) build in a separate environment; `<folder>/Scripts/python -m pytest` runs the tests on it
- `uv run openstems doctor`: Python, PyTorch, GPU backend (CUDA or ROCm), GPU, FFmpeg check;
  non-zero without a working GPU
- `uv run openstems selftest [--ops-only] [-m MODEL]`: GPU against CPU, per operation and per
  model; non-zero on a mismatch
- `uv run ruff check` and `uv run ruff format --check`: lint and format check
- `uv run pyright`: type-check
- `uv run pytest`: unit tests (CPU; `gpu`-marked tests are deselected by default)
- `uv run pytest -m gpu`: GPU tests, need downloaded models
- `uv run openstems separate SONG --recipe full-song`: run a recipe on the GPU
- `uv run openstems models list | pull | verify | check`: catalog and downloads
- `uv run python ../scripts/null_test.py SONG`: runner vs the loader library (must be < -40 dB)
- `uv run python ../scripts/benchmark.py SONG [--markdown]`: run time and peak VRAM
- `uv run python ../scripts/check_stems.py FOLDER [--sum-to-mix]`: alignment check
- `uv run python ../scripts/accept_recipes.py SONG`: run every recipe with alignment checks
- `python ../scripts/compare_builds.py run --out DIR MODEL...` in each environment, then
  `compare DIR DIR`: the same stems from two PyTorch builds (on the CPU)
- `uv run openstems serve`: start the local API (prints a JSON line with port and token)
- `uv run openstems openapi --out openapi.json`: export the schema after any API change, then
  `pnpm gen:api` in `app/` (a test fails if `engine/openapi.json` is stale)
- `uv run python ../scripts/gen_catalog.py --write`: regenerate `catalog/models.toml` (never
  edit that file by hand)

App (run from `app/`):

- `pnpm install`, `pnpm dev`: run the app with hot reload (starts the engine itself)
- `pnpm typecheck`, `pnpm test`: TypeScript and component tests
- `pnpm build && pnpm e2e`: end-to-end tests (Playwright + Electron + FakeEngine); the build
  must be current
- `SHOTS=1 SHOTS_DIR=<folder> pnpm e2e -g screenshots`: capture every view for design review,
  the quick-drop window included (`tray-on-screen.png` is the real screen around it)
- `--tray` on the app's command line starts it in the tray with no window (the end-to-end
  suite passes it through Playwright's `args`)
- `REAL_SONG=<file> REAL_MODELS=<folder> pnpm e2e -g "real engine"`: the app on the real GPU
- `pnpm gen:api`: regenerate `src/api/schema.d.ts` from `engine/openapi.json`
- `node scripts/make-icons.mjs`: redraw the icons in `resources/`
- `pnpm run pack`: build the unpacked app into `release/win-unpacked` (run `pnpm package:prepare`
  first; plain `pnpm pack` is pnpm's own command and makes a tarball instead)
- `pnpm dist`: build the installer, `release/OpenStems-Setup-<version>.exe`, with its
  `.blockmap` and `latest.yml` (the three files a GitHub release needs for self-update)
- Releasing: set the version in `app/package.json`, `engine/pyproject.toml` and
  `engine/src/openstems/__init__.py`, `uv lock`, changelog heading, merge, tag `v<version>` on
  `main`, `pnpm dist`, then `gh release create v<version>` with those three files. Never a
  draft or pre-release: installed apps would not see it
- `OPENSTEMS_E2E_UPDATE=<version>` (end-to-end tests only): self-update with a stand-in that
  offers that version and never touches the network
- `PACKAGED_PROFILE=<empty folder> REAL_SONG=<file> REAL_MODELS=<folder> pnpm e2e -g packaged`:
  first-run setup and a separation in the packaged app, on a clean profile. Add
  `PACKAGED_VARIANT=rocm` to force the AMD build; `PACKAGED_SWITCH=cuda|rocm ... -g "switch the
  engine build"` switches the build from Settings on a profile that is already set up

## Layout

- `engine/`: Python package `openstems` (`src/openstems/`) with `domain`, `catalog`, `recipes`,
  `audio`, `engines`, `pipeline`, `worker`, `api`, `settings.py`, `cli.py`; tests in
  `engine/tests/`
- `app/`: Electron + React shell. `electron/` (main process, preload, engine launcher, first-run
  setup, tray), `src/` (React UI: `api/`, `components/`, `views/`, `audio/`, `state/`, `tray/`),
  `e2e/`
- `docs/adr/`: decision records; `docs/benchmarks.md`: speed and VRAM per model
- `scripts/`: dev start, benchmarks

Engine structure: `runtime.build_runtime()` wires settings, catalog, `ModelStore`, recipes and
the `Pipeline`. Engines implement the port in `engines/base.py`; all real models run through
`engines/runner.py`. `OPENSTEMS_ENGINE=fake` swaps in the FakeEngine everywhere (tests, UI
work). Tests never touch real settings: `tests/conftest.py` points every folder at a temp dir.

API structure: `api/app.py` (routes), `api/service.py` (runtime, index, queue, downloads in one
object), `api/jobs.py` (the queue and job states), `worker/supervisor.py` and `worker/process.py`
(the GPU worker process), `api/db.py` (SQLite index). API tests use a real worker process with
the FakeEngine; the API process itself never imports torch.

GPU vendors: PyTorch comes from one of two conflicting dependency groups, `cuda` (default) and
`rocm` (AMD). Both answer through `torch.cuda`, so engine code never branches on the vendor;
`doctor.torch_backend` is the one place that tells them apart. `app/electron/variant.ts`
decides which build first-run setup installs. AMD support has never run on a Radeon:
`docs/adr/0007-amd-rocm.md`.

Tray: `electron/tray.ts` owns the icon and the quick-drop window; `electron/traylogic.ts` is
the part with no Electron in it (window placement, icon state, the `shell.json` preferences)
and is what the unit tests cover. Both windows load one bundle; `?window=tray` picks
`src/tray/TrayApp.tsx`. What both windows do with dropped files lives in
`src/state/dropflow.tsx`. The quick-drop window does not hide on blur, on purpose:
`docs/adr/0008-tray.md`. In tests the tray is driven through `__openstemsE2E` (`e2e/helpers.ts`),
and the login item is a stand-in that never touches the registry.

Self-update: `electron/updatelogic.ts` is the state machine with no Electron in it (tested in
`src/test/update.test.tsx`); `electron/updater.ts` is the thin part on `electron-updater`.
Both steps, download and restart, wait for the user. The repository is public because
installed apps read its releases: `docs/adr/0010-self-update.md`.

Names: `OpenStems` where people read it and for folders, `openstems` for the command, the
Python package and keys, `OPENSTEMS_*` for environment variables. The app was lew-stems before
0.2.0; `settings.adopt_legacy_settings` carries a user's settings over once, and that name
survives only there, in the changelog and in `docs/adr/0009-rename-openstems.md`. The folder
`D:\lew-stems` on the development machine is a real folder and keeps its name.

Dependencies point inward: `domain` imports nothing from the other packages and never imports
torch. `cli` and `api` are the only entry points.

## UI rules

Motion and interaction rules are in `docs/adr/0005-desktop-shell.md` and `app/src/styles.css`.
Keep them: press feedback on every pressable element, popups that scale from their trigger and
never from zero, named transition properties, custom ease-out curves, under 300 ms, nothing
animated for keyboard actions, hover styles behind a hover media query, reduced motion honored.
Motion scales with rarity: things seen constantly (solo, mute, switching jobs or views) change
at once, and only rare moments (first queue render, dialogs, the panel appearing) animate. Use
`.press` for press-only feedback and `.pressable` when color may also ease.
Component classes live in `@layer components` so Tailwind utilities can override them.

## Ground rules

1. `PLAN.md` is the spec. Record every deviation as a short decision record in `docs/adr/`.
2. Phase 0 went straight to `main`. After that: one branch and one pull request per phase, small
   conventional commits, push at the end of every working session.
3. A phase is done only when its acceptance checks pass. Then update `README.md` and
   `CHANGELOG.md`, tick the boxes in `PLAN.md`, push, and open the pull request.
4. Verify before coding: check current docs and versions for any library before using it, and
   pin exact versions in lockfiles.
5. Never commit model weights, audio files, outputs or secrets. The catalog stores URLs and
   sha256 hashes; weights download at runtime.
6. Checkpoints are pickles. Download only from catalog URLs, verify sha256 before loading, and
   load with `weights_only=True` wherever the checkpoint allows.
7. Stop and ask before deleting user files, changing system settings, installing system-wide
   software, or settling anything listed under Open decisions in `PLAN.md`.
8. Keep this file current.

## Machine notes

- This PC has twice lost power (Kernel-Power 41, 2026-11-21 and 2026-11-22) while the GPU
  self-test ran real models on the GPU and then on every CPU core. Do not run `openstems
  selftest` with models, the Settings button or `PACKAGED_SELFTEST=1` here without asking.
  `selftest --ops-only` is light.

- Test songs (CC-BY, Kevin MacLeod) are in `D:\lew-stems\test-audio`; they are never committed.
- Target: Windows, NVIDIA RTX 5070 Ti (16 GB). C: is nearly full; keep models and outputs on D:
  (`OPENSTEMS_MODELS_DIR`, `OPENSTEMS_OUTPUT_DIR`).
