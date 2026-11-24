# OpenStems

Local Windows app for stem separation. `PLAN.md` is the spec; follow it phase by phase.
There is also a build for Apple Silicon Macs, written on Windows. The owner runs it on an
M1 Max; what has and has not been seen working there is in `docs/adr/0014-macos.md`.

## Commands

Engine (run from `engine/`):

- `uv sync`: install (Python 3.12, PyTorch from the cu130 index: the `cuda` group)
- `UV_PROJECT_ENVIRONMENT=<folder> uv sync --no-default-groups --group rocm --group dev`: the AMD
  (ROCm) build in a separate environment; `<folder>/Scripts/python -m pytest` runs the tests on it
- On a Mac: `uv sync --no-default-groups --group mps --group dev` (PyTorch from PyPI, the
  Apple GPU), then `uv run --no-sync ...` for every command below. A plain `uv sync` or
  `uv run` asks for the `cuda` group, which has no macOS wheel
- `uv run openstems doctor`: Python, PyTorch, GPU backend (CUDA, ROCm or MPS), GPU, FFmpeg
  check; non-zero without a working GPU. On a Mac the "VRAM" line reads "Memory (shared)".
  `--json` prints the report as JSON (the API reads it that way).
  "Memory for one model" is the budget one model run gets on this machine
- `uv run openstems selftest [--ops-only] [-m MODEL]`: GPU against CPU, per operation and per
  model; non-zero on a mismatch
- `uv run ruff check` and `uv run ruff format --check`: lint and format check
- `uv run pyright`: type-check
- `uv run pytest`: unit tests (CPU; `gpu`-marked tests are deselected by default).
  `tests/test_macos.py` covers the Mac branches on Windows by patching the platform
- `uv run pytest -m gpu`: GPU tests, need downloaded models
- `uv run openstems separate SONG --recipe full-song`: run a recipe on the GPU
- `uv run openstems models list | pull | verify | check`: catalog and downloads.
  `pull --set recommended` is the seed set cut to what this machine's memory can run
- `OPENSTEMS_MEMORY_GB=<number>` before any engine command or `pnpm dev`: plan as if the
  machine (with a graphics card: the card) had that much memory, so a large machine acts as
  a small one. It changes the budget, the fit, the recommended set and the warm-model cap.
  It takes no memory away, so nothing really runs out
- `uv run pytest tests/test_low_memory.py`: the memory rules, the fallback to the CPU and
  the API's fit fields, with stand-ins and the FakeEngine
- `uv run python ../scripts/null_test.py SONG`: runner vs the loader library (must be < -40 dB)
- `uv run python ../scripts/benchmark.py SONG [--markdown]`: run time and peak VRAM
- `uv run python ../scripts/check_stems.py FOLDER [--sum-to-mix]`: alignment check
- `uv run python ../scripts/accept_recipes.py SONG`: run every recipe with alignment checks
- Stem to MIDI benchmark (Phase 7, `docs/research/stem-to-midi.md`):
  - `python -I ../scripts/midi_bench_data.py [--skip-slakh] [--max-gb N]`: fetch the CC BY
    sets into `D:\lew-stems\bench`. Slakh's archive is shuffled, so complete songs need most of
    its 104 GB streamed.
  - `uv run --no-sync --with mido==1.3.3 --with mir_eval==0.8.2 python ../scripts/midi_bench.py score|pack`:
    score transcribers with mir_eval, or build the audio pack the owner runs through Melodyne
    and NeuralNote.
  - `python ../scripts/make_midi_import_tests.py`: the MIDI files that show how a DAW imports
    bends, MPE and tempo maps.
- `python ../scripts/compare_builds.py run --out DIR MODEL...` in each environment, then
  `compare DIR DIR`: the same stems from two PyTorch builds (on the CPU)
- `uv run pytest tests/test_links_mixes.py`: links and mixes, with a stand-in for the fetch
  (no test touches the network)
- `uv run openstems serve`: start the local API (prints a JSON line with port and token)
- `uv run openstems openapi --out openapi.json`: export the schema after any API change, then
  `pnpm gen:api` in `app/` (a test fails if `engine/openapi.json` is stale)
- `uv run python ../scripts/gen_catalog.py --write`: regenerate `catalog/models.toml` (never
  edit that file by hand). A model's `memory_gb` comes from `MEMORY_GB` in that script,
  copied from the Peak VRAM column of `docs/benchmarks.md`

App (run from `app/`):

- `pnpm install`, `pnpm dev`: run the app with hot reload (starts the engine itself)
- `pnpm typecheck`, `pnpm test`: TypeScript and component tests
- `pnpm build && pnpm e2e`: end-to-end tests (Playwright + Electron + FakeEngine); the build
  must be current
- `SHOTS=1 SHOTS_DIR=<folder> pnpm e2e -g screenshots`: capture every view for design review,
  the quick-drop window included (`tray-on-screen.png` is the real screen around it)
  and a machine with little memory (`memory-1-queue.png` to `memory-7-settings.png`)
- `pnpm e2e low-memory`: the CPU note and the marks of an 8 GB machine, with the FakeEngine
  (`OPENSTEMS_FAKE_OOM`, `OPENSTEMS_MEMORY_GB`)
- `README_SHOTS=1 pnpm e2e -g "readme pictures"`: retake the README's pictures into
  `docs/images/` at twice the pixels, with a synthetic demo song (`scripts/make_demo_song.py`)
  whose parts are written over the FakeEngine's stems. `README_OUTPUT=<new folder>` and
  `README_MODELS=<folder>` set the folders the pictures show; each run leaves a few GB of
  demo stems in the output folder. `README_SONG=<file>` with `README_SONG_STEMS=<folder>`
  (that file separated beforehand on the real GPU with `full-song` and `drum-kit`, into that
  folder) puts a real song first and adds `drums.png`; only its `.peaks` are copied
- `--tray` on the app's command line starts it in the tray with no window (the end-to-end
  suite passes it through Playwright's `args`)
- `REAL_SONG=<file> REAL_MODELS=<folder> pnpm e2e -g "real engine"`: the app on the real GPU
- `REAL_LINK=<address> REAL_MODELS=<folder> pnpm e2e -g "pasted link is fetched from the web"`:
  a real link fetched from the web, separated on the GPU and mixed
- `pnpm gen:api`: regenerate `src/api/schema.d.ts` from `engine/openapi.json`
- `node scripts/make-icons.mjs`: redraw the icons in `resources/`
- `pnpm run pack`: build the unpacked app into `release/win-unpacked` (run `pnpm package:prepare`
  first; plain `pnpm pack` is pnpm's own command and makes a tarball instead)
- `pnpm dist`: build the installer, `release/OpenStems-Setup-<version>.exe`, with its
  `.blockmap` and `latest.yml` (the three files a GitHub release needs for self-update)
- `pnpm dist:mac` (on a Mac only, with uv and git on `PATH`): build
  `release/OpenStems-<version>-arm64.dmg` and `.zip`, their blockmaps and `latest-mac.yml`.
  `pnpm pack:mac` builds the unpacked app into `release/mac-arm64` (run `pnpm package:prepare`
  first). Run only by CI and the release workflow: the development machine is not a Mac
- `PACKAGE_PLATFORM=darwin node scripts/prepare-package.mjs`: the Mac packaging steps on
  Windows (uv for `aarch64-apple-darwin`, `requirements-mps.txt`). It leaves `app/package` in
  its Mac state: run `pnpm package:prepare` afterwards to put the Windows one back
- Signing the Mac build: ad hoc (`app/mac-build.cjs`, the configuration the Mac commands
  read) unless `CSC_LINK` and `CSC_KEY_PASSWORD` are set where `pnpm dist:mac` runs; notarized when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID` are set as well. Never commit any of them
- Releasing: set the version in `app/package.json`, `engine/pyproject.toml` and
  `engine/src/openstems/__init__.py`, `uv lock`, changelog heading, merge, tag `v<version>` on
  `main`, `pnpm dist`, then `gh release create v<version>` with those three files. Never a
  draft or pre-release: installed apps would not see it. Publishing the release starts
  `.github/workflows/release-mac.yml`, which builds on a Mac runner and adds the dmg, the zip,
  their blockmaps and `latest-mac.yml` (it can also be started by hand with the tag; the tag
  must be `v<version>`). Until it has finished Mac apps are offered nothing. It built the 0.3.0 Mac files
- CI (`.github/workflows/ci.yml`) runs the engine and app jobs on `windows-latest` and on
  `macos-15` (Apple Silicon). The Mac side syncs the `mps` group, sets `UV_NO_SYNC=1`, and
  ends with `pnpm run pack:mac` and no certificate
- `OPENSTEMS_E2E_UPDATE=<version>` (end-to-end tests only): self-update with a stand-in that
  offers that version and never touches the network. With `OPENSTEMS_E2E_UPDATE_MANUAL=1` as
  well, the stand-in is the manual kind (what an unsigned Mac app has) and records the page it
  would open in `__openstemsE2E.updateOpened`
- After an app update the environment is refreshed, not rebuilt (`EngineSetup.refresh` in
  `electron/setup.ts`): running the packaged test on a profile set up by an older version
  exercises it
- `PACKAGED_PROFILE=<empty folder> REAL_SONG=<file> REAL_MODELS=<folder> pnpm e2e -g packaged`:
  first-run setup and a separation in the packaged app, on a clean profile. Add
  `PACKAGED_VARIANT=rocm` or `cu126` to force another build; `PACKAGED_SWITCH=cuda|rocm ... -g "switch the
  engine build"` switches the build from Settings on a profile that is already set up. On a
  Mac (after `pnpm package:prepare && pnpm run pack:mac`) the profile folder is used as `HOME`;
  the variant, switch and real-update tests are Windows only

## Layout

- `engine/`: Python package `openstems` (`src/openstems/`) with `domain`, `catalog`, `recipes`,
  `audio`, `engines`, `pipeline`, `worker`, `api`, `settings.py`, `cli.py`; tests in
  `engine/tests/`
- `app/`: Electron + React shell. `electron/` (main process, preload, engine launcher, first-run
  setup, tray), `src/` (React UI: `api/`, `components/`, `views/`, `audio/`, `state/`, `tray/`),
  `e2e/`
- `docs/adr/`: decision records; `docs/benchmarks.md`: speed and VRAM per model;
  `docs/research/`: research and plans for features not yet built (`stem-to-midi.md`, the plan
  behind Phase 7)
- `scripts/`: dev start, benchmarks

Engine structure: `runtime.build_runtime()` wires settings, catalog, `ModelStore`, recipes and
the `Pipeline`. Engines implement the port in `engines/base.py`; all real models run through
`engines/runner.py`. `OPENSTEMS_ENGINE=fake` swaps in the FakeEngine everywhere (tests, UI
work). Tests never touch real settings: `tests/conftest.py` points every folder at a temp dir.

API structure: `api/app.py` (routes), `api/service.py` (runtime, index, queue, downloads in one
object), `api/jobs.py` (the queue and job states), `worker/supervisor.py` and `worker/process.py`
(the GPU worker process), `api/db.py` (SQLite index). API tests use a real worker process with
the FakeEngine; the API process itself never imports torch. What needs torch is asked of a
process of its own: the self-test, and the doctor (`service.run_doctor_process`, which runs
`openstems doctor --json`). The doctor's report is kept in the cache folder as `machine.json`
and checked again in the background at each start (`Service._refresh_machine`), so only the
first start of a version waits for it. `/v1/models` and `/v1/recipes` need it for the fit.

GPU builds: PyTorch comes from one of four conflicting dependency groups: `cuda` (default,
CUDA 13.0), `cu126` (the same PyTorch for CUDA 12.6, for GTX 900 and 10 series cards; never
run on one: `docs/adr/0012-older-nvidia.md`), `rocm` (AMD) and `mps` (Apple Silicon, the same
PyTorch from PyPI). The first three answer through `torch.cuda`; a Mac answers through
`torch.mps` with the device "mps", always at full precision. Engine code never branches on
the vendor: `engines/device.py` holds what differs (which device, memory, out-of-memory
errors) and `doctor.torch_backend` tells the builds apart. `app/electron/variant.ts`
decides which build first-run setup installs: one of the first three on Windows, and only
`mps` on a Mac, where nothing is detected (`variantsFor`). A user reported AMD support working
on a Radeon on 2026-11-22; it has not been run on one by us: `docs/adr/0007-amd-rocm.md`.

Mac: Apple Silicon and macOS 14 or later only. The development machine is Windows, so every
Mac branch must be right by reading, and every Mac decision must be a plain function covered
by a unit test that runs on Windows with the platform passed in or patched. The Electron glue
that only carries those decisions is read, not tested: ADR 0014 names it ("Read, not
tested"). The owner tests on an M1 Max with 32 GB: 0.3.0 was installed from the dmg there on
2026-11-23 and setup, a separation and the menu bar item worked. Say what has been seen on a
Mac and what has not wherever Mac support is described, and when a change cannot be proven
from Windows give the owner steps to run on the Mac (`docs/adr/0014-macos.md`). On "mps" the engine checks the STFT against the CPU once per
process and, if it fails, runs `torch.stft` and `torch.istft` on the CPU from then on
(`engines/stft_fallback.py`); the doctor reports that as a note, not a problem.
`PYTORCH_ENABLE_MPS_FALLBACK=1` is set in `openstems/__init__.py` on a Mac. Warm models are
capped at half the machine's memory there (`Settings.vram_budget_bytes`). The pinned loaders
refuse `device="mps"` in their own inference code (removed upstream on 2026-09-14); the engine
uses only their model classes, so do not route anything through their `demix_track`.

Memory: `domain/memory.py` holds the rules as plain functions with no torch
(`docs/adr/0015-low-memory.md`). A model needs its `memory_gb` (measured at half precision on
CUDA), or an estimate from its checkpoint size; at full precision (mps, the CPU, GTX 900 and
10 series) the part above the weights is doubled, which is an estimate. The budget for one
run is the card's memory on CUDA and ROCm, (memory - 2 GB) x 0.75 on mps and half the
machine's memory on the CPU. Fit is "fits" up to 85 percent of the budget, "tight" up to all
of it, "no" above; a recipe is as large as its largest model. "no" never blocks a run. The
API carries `fit` on models and recipes, `recommended` on models (use it, not `seed`, for the
first download), the budget and `memory_kind` (where models run: the app words the budget by
it) in the system info and `notes` on a job. The app's sentences about a fit are in
`app/src/lib/memory.ts`; they say what may happen, since the engine never consults the fit
and always tries the GPU first. On out-of-memory
(`engines/device.is_oom` is the one check: CUDA's class, the MPS wording, the CPU's)
`Pipeline._separate` goes in order: the runner's batch backoff, drop the other warm models
and retry, then that model on the CPU for this job, with the note "<model name> ran on the
CPU: not enough GPU memory" on the job and in the manifest. A machine that runs on the CPU
anyway stops after the retry, with no note. `ModelHost.release` is what frees memory between
the steps (warm models, the collector, the GPU's cache). A budget under 8 GB is a small
machine: one warm model (`ModelHost.get`) and unload after 60 s idle. With
`OPENSTEMS_ENGINE=fake` there is no budget unless `OPENSTEMS_MEMORY_GB` is set (then the
CPU's rule), and `OPENSTEMS_FAKE_OOM=<model id>[:run|load|once|always],...` (or `all`) makes
models run out of memory on a pretend GPU. Every Mac and full-precision figure is an
estimate until measured: say so wherever they are described. On the development machine
everything fits and the recommended set is the seed set.

Folders on a Mac: settings, user recipes, models and `engine-env` in
`~/Library/Application Support/OpenStems`, the cache in `~/Library/Caches/OpenStems`, logs in
`~/Library/Logs/OpenStems`, outputs in `~/Music/OpenStems`. The environment has `bin/python`
and `bin/openstems` where Windows has `Scripts` and `.exe`. The engine decides them in
`settings.py` and the app in `electron/platform.ts` (pure functions with the platform passed
in, no Node or Electron imports): change both together. Windows folders are unchanged. A Mac
has no uninstaller, so `engine-env` stays until the user deletes it.

Words and keys in the UI: `src/platform.ts` holds what the renderer says and listens for
differently on a Mac (Finder, menu bar, "Open at login", Cmd for Ctrl through `shortcut` and
`modKey`). Use it instead of writing "Ctrl", "tray" or "Explorer" into a component.
`main.tsx` sets `data-platform` on the root element for the stylesheet (fonts, scrollbars).
`src/test/mac.test.tsx` holds the Mac component tests, with the platform stubbed.

Tray: `electron/tray.ts` owns the icon and the quick-drop window; `electron/traylogic.ts` is
the part with no Electron in it (window placement, icon state, the `shell.json` preferences,
and what differs between Windows and a Mac: window frame, menus, when the app quits, the
template icons, `menuBarPlacement`) and is what the unit tests cover. On a Mac the icon is a
menu bar item, the quick-drop window is a panel under the menu bar, closing the window never
quits and the Dock icon stays. Both windows load one bundle; `?window=tray` picks
`src/tray/TrayApp.tsx`. What both windows do with dropped files lives in
`src/state/dropflow.tsx`. The quick-drop window does not hide on blur, on purpose:
`docs/adr/0008-tray.md`. In tests the tray is driven through `__openstemsE2E` (`e2e/helpers.ts`),
and the login item is a stand-in that never touches the registry.

Self-update: `electron/updatelogic.ts` is the state machine with no Electron in it (tested in
`src/test/update.test.tsx`); `electron/updater.ts` is the thin part on `electron-updater`.
Both steps, download and restart, wait for the user. The repository is public because
installed apps read its releases: `docs/adr/0010-self-update.md`. A Mac app updates itself
only when it is signed with a Developer ID (`updater.updateBackend` asks `codesign` once at
start). An unsigned one takes the manual path: the offer is marked `manual`, "download" opens
the release page, and the state stays `available`.

Names: `OpenStems` where people read it and for folders, `openstems` for the command, the
Python package and keys, `OPENSTEMS_*` for environment variables. The app was lew-stems before
0.2.0; `settings.adopt_legacy_settings` carries a user's settings over once, and that name
survives only there, in the changelog and in `docs/adr/0009-rename-openstems.md`. The folder
`D:\lew-stems` on the development machine is a real folder and keeps its name.

Manual start: a queued job can be held (`held` on a job; `JobManager.release` lets it go,
`POST /v1/jobs/start` and `/v1/jobs/{id}/start`). Whether a new job is held follows the
`auto_start` setting, off by default; the watch folder always starts its files.
`OPENSTEMS_AUTO_START=1|0` overrides the setting, and the test suites set it to 1 except the
ones about manual start (`engine/tests/test_manual_start.py`, `app/e2e/manual-start.spec.ts`).

Links: a web address becomes a job in two steps. `api/links.py` (`LinkManager`) fetches it on
a thread with progress as `link.updated` events, then `Service._queue_fetched` queues an
ordinary job for the file, kept under `<output>/_links/`. `openstems/links.py` is the fetcher:
yt-dlp, pinned in `pyproject.toml` with its `deno` extra (the JavaScript runtime YouTube
needs; its path is passed to yt-dlp, since `Scripts` is not on `PATH` in the packaged app).
When a site stops working, bump that pin and release. With `OPENSTEMS_ENGINE=fake` a stand-in
fetches: no test touches the network, and `slow`, `fail` or `playlist` in the address make it
slow, fail or refuse. In the app both windows share `components/LinkRow.tsx`, and pasting and
dropping links live in `state/dropflow.tsx` beside files.

Mixes: `POST /v1/mixes` (`pipeline/mix.py`) sums stem files into `<stem folder>/Mixes/`. The
app asks for the file before a drag can start (`state/mix.ts`, `useMixFile`). The mix's name
is decided in `mix_label` (Python, the file) and `mixLabel` (TypeScript, the screen): change
both together. `docs/adr/0013-links-and-mixes.md`.

Groups: an output of a recipe can name a `group`, the larger stem it is a part of (`kick`
in `drums`). The parts add up to it and the group itself is never written: it is a mix of
its parts, named after the group by `mix_label` and `mixLabel`. The group travels in the
recipe (`output_groups`), the manifest and each job stem, and is written only where there
is one, so other recipes keep their cache keys. `every-stem` is the recipe that uses it
(13 stems; its `other drums` and `backing vocals` are differences, so the parts sum
exactly). In the app `state/mix.ts` holds the plain functions (`stemSections`, `partName`,
`groupsOf`) and `StemsPanel.tsx` the headings; a group's file is written when the pointer
first reaches its handle. The 53-stem model is not chained into it on purpose: its stems
overlap. `docs/adr/0017-every-stem.md`.

Tempo sync: with the `tempo_sync` setting on, `write_audio` appends an `acid` chunk with the
detected tempo to WAV stems and mixes (`audio/write.py`, `tempo_chunk`), which FL Studio
reads to stretch them to the project's tempo. FL reads the tempo field only; the beat count
stays 0. The option enters a run's cache key only when on. `docs/adr/0016-tempo-sync.md`.

Tempo and key by hand: a job's `bpm` and `key` options replace what detection finds for
that run (`pipeline/extras.py`); they are not in the cache key, and a cached result is
re-tagged (`Pipeline._retagged`). `pipeline/retag.py` (`set_analysis`) re-tags stems that are
written: the manifest (the detected figures stay under `analysis.detected`), names made with
`{bpm}` or `{key}`, and with tempo sync the mark in each WAV and mix (`write.set_tempo`, in
place). Routes: `POST /v1/jobs/{id}/analysis` (a waiting job keeps them for its run, a
finished one is re-tagged) and `POST /v1/stemsets/analysis` (a folder). In the app
`components/TempoKey.tsx` is the pair of fields, in the queue row of a waiting song and in
the stems panel. What may be typed is decided in `retag.clean_bpm`/`clean_key` and in
`app/src/lib/tempokey.ts`: change both together. `docs/adr/0019-edit-tempo-key.md`.

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
9. Windows and Mac move together. Every feature and fix covers both in the same change: the
   code for each, wording per platform, tests for each, docs for each. Both CI jobs must pass.
   A release carries the Windows installer and the Mac files; check that `release-mac.yml`
   added the Mac ones before calling a release done.

## Machine notes

- This PC has twice lost power (Kernel-Power 41, 2026-11-21 and 2026-11-22) while the GPU
  self-test ran real models on the GPU and then on every CPU core. Do not run `openstems
  selftest` with models, the Settings button or `PACKAGED_SELFTEST=1` here without asking.
  `selftest --ops-only` is light.
- It lost power twice more on 2026-11-23 (Kernel-Power 41 at the 15:52 and 16:13 boots)
  while the stem-to-MIDI benchmark ran CREPE on the GPU (batch 512) with pYIN on 4 CPU
  threads and a network download: far lighter than the self-test. Ask before running any GPU
  model work here, the benchmark's `crepe` method and `separate` subcommand included, until
  the cause is found. Lead suspect (2026-11-23): the memory overclock. Two of the four
  crashes that day were bugcheck 0x124 with a WHEA "fatal hardware error, Component: Memory,
  Machine Check Exception" at different addresses, and the DDR5 (V-Color, rated 4800) runs at
  6400 MT/s through EXPO. Kernel-Power 41 events go back to 2026-11-06.

- Test songs (CC-BY, Kevin MacLeod) are in `D:\lew-stems\test-audio`; they are never committed.
- Target: Windows, NVIDIA RTX 5070 Ti (16 GB). C: is nearly full; keep models and outputs on D:
  (`OPENSTEMS_MODELS_DIR`, `OPENSTEMS_OUTPUT_DIR`).
