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
- `python ../scripts/compare_builds.py run --out DIR MODEL...` in each environment, then
  `compare DIR DIR`: the same stems from two PyTorch builds (on the CPU)
- `uv run pytest tests/test_links_mixes.py`: links and mixes, with a stand-in for the fetch
  (no test touches the network)
- `uv run pytest tests/test_clips.py`: clips, bar 1 and the previews of songs' own files,
  with the FakeEngine and synthetic beats
- `uv run pytest tests/test_separate_selection.py`: a part of a song separated alone (the
  setting, `POST /v1/jobs/{id}/range`, the run), with the FakeEngine
- `uv run openstems serve`: start the local API (prints a JSON line with port and token)
- `uv run openstems openapi --out openapi.json`: export the schema after any API change, then
  `pnpm gen:api` in `app/` (a test fails if `engine/openapi.json` is stale)
- `uv run python ../scripts/gen_catalog.py --write`: regenerate `catalog/models.toml` (never
  edit that file by hand). A model's `memory_gb` comes from `MEMORY_GB` in that script,
  copied from the Peak VRAM column of `docs/benchmarks.md`

Site (the landing page on GitHub Pages, `site/`, `docs/adr/0024-site.md`):

- `node scripts/build-site.mjs [OUT]`: assemble the site into `_site/` (or OUT) with the
  changelog, the icon and two README pictures; serve it with `python -m http.server -d OUT`
  (the page fetches `CHANGELOG.md`, so `file://` does not work)
- `.github/workflows/pages.yml` deploys it on a push to `main` that touches it, the
  changelog or those pictures (a pull request only builds it). The support button is hidden
  until `href` is set on `#support-link` in `site/index.html`. Its requirements, the
  Mac's first-open steps and "Will it run?" (`MACHINES` in `site/main.js`, the README's
  Memory table) copy the README's: change both together

App (run from `app/`):

- `pnpm install`, `pnpm dev`: run the app with hot reload (starts the engine itself)
- `pnpm typecheck`, `pnpm test`: TypeScript and component tests
- `pnpm test trimmer`: the trimmer's plain functions, the twins against
  `engine/tests/fixtures/clip_labels.json`, and the editor with the engine mocked
  (`src/test/trimstub.ts` stands in for Web Audio, which jsdom lacks)
- `pnpm build && pnpm e2e`: end-to-end tests (Playwright + Electron + FakeEngine); the build
  must be current
- `SHOTS=1 SHOTS_DIR=<folder> pnpm e2e -g screenshots`: capture every view for design review,
  the quick-drop window included (`tray-on-screen.png` is the real screen around it)
  and a machine with little memory (`memory-1-queue.png` to `memory-7-settings.png`).
  The main views are taken in light as well (`light-1-empty.png` to `light-tray.png`),
  the welcome's steps in both (`welcome-1-folders.png` to `light-welcome-3-models.png`) and
  the row menus (`3b-row-menu.png`, `tray-4b-row-menu.png`). The trimmer is taken in both
  (`trim-1-open.png` to `trim-5-queue-part.png`, `light-trim-1-open.png` to
  `light-trim-5-queue-part.png`), on a drum loop the spec writes
- `pnpm e2e theme`: the theme switch, both windows, the pick across a restart
- `pnpm e2e welcome`: the welcome on a first start (`OPENSTEMS_E2E_WELCOME=1` forces it,
  since the FakeEngine has every model; `__openstemsE2E.pickFolder` stands in for the folder
  picker). `pnpm e2e row-menu`: the right-click menu on queue rows, both windows
- `pnpm e2e trimmer`: the trimmer on the FakeEngine: a grid fixed by hand and parts of a
  stem, of every stem and of a mix dragged out as WAVs the length of the part; a waiting
  song's own file; "Separate only the trimmed part"; Trim from the stems panel; a stem that
  enters late (`OPENSTEMS_FAKE_LATE=<stem>:<seconds>` leaves a FakeEngine stem silent at its
  start, so with Trim silence on its file begins later in the song)
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
  `APPLE_TEAM_ID` are set as well. Never commit any of them. There is no Developer ID: the
  certificate is one the project makes itself (`bash scripts/make-mac-cert.sh NAME FOLDER
  PASSWORD`, once, with the folder outside the repository), which lets an installed Mac app
  update itself. `release-mac.yml` sees that it is self-signed, trusts it on the runner and
  sets `OPENSTEMS_SELF_SIGNED=1` (no hardened runtime, no notarization). Every release must
  use the same certificate: `docs/adr/0018-mac-self-signed.md`
- `bash scripts/mac-update-test.sh ENGINE` in `app/` (Mac CI runner only: it trusts the
  certificate with sudo): two self-signed builds, with the project's certificate from the
  secrets or a throwaway one, the requirement check the installer makes, and the older one
  installing the newer one through the real updater (`e2e/mac-update.spec.ts`). The Mac app
  job in CI runs it
- `OPENSTEMS_UPDATE_FEED=<http(s) address>` before starting the app: read updates from that
  folder (a `latest-mac.yml` or `latest.yml` and the build beside it) in place of the GitHub
  releases (`updatelogic.testFeedUrl`). For trying an update by hand
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
  setup, tray), `src/` (React UI: `api/`, `components/`, `views/`, `audio/`, `state/`, `tray/`,
  `trimmer/`), `e2e/`
- `site/`: the landing page (static, no build tool), deployed to GitHub Pages
- `docs/adr/`: decision records; `docs/benchmarks.md`: speed and VRAM per model
- `scripts/`: dev start, benchmarks

Engine structure: `runtime.build_runtime()` wires settings, catalog, `ModelStore`, recipes and
the `Pipeline`. Engines implement the port in `engines/base.py`; all real models run through
`engines/runner.py`. `OPENSTEMS_ENGINE=fake` swaps in the FakeEngine everywhere (tests, UI
work). Tests never touch real settings: `tests/conftest.py` points every folder at a temp dir.

API structure: `api/app.py` (routes), `api/service.py` (runtime, index, queue, downloads in one
object), `api/jobs.py` (the queue and job states), `worker/supervisor.py` and `worker/process.py`
(the GPU worker process), `api/db.py` (SQLite index). API tests use a real worker process with
the FakeEngine; the API process itself never imports torch. A job that fails with an
unexpected error (not a `DomainError`, not a cancel) ends the worker, and the supervisor
starts a fresh one for the next job (`WorkerSupervisor._replace`, not a crash). The reason:
a failed import of torch leaves the process failing every job after it with "module 'torch'
has no attribute 'device'". So never import torch again in a process where its import
failed. The traceback goes to `engine.log`, the only place it is kept, and
`OPENSTEMS_FAKE_IMPORT_FAILS=<model id>` acts the failure out with the FakeEngine
(`docs/adr/0024-fresh-worker-after-failure.md`). What needs torch is asked of a
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
2026-11-23 and setup, a separation and the menu bar item worked; later that day 0.3.2
installed 0.3.3 there by itself. Say what has been seen on a
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
(`engines/device.is_oom` is the one check: CUDA's class, the MPS wording, the CPU's; the
pipeline asks it only once torch is loaded, `run._out_of_memory`)
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

Light and dark: the pick (`system`, `light`, `dark`; dark by default) is `theme` in
`shell.json`. The main process sets `nativeTheme.themeSource` from it, and both windows read
it back through `prefers-color-scheme` (`src/lib/theme.ts` sets `data-theme` on the root,
`styles.css` swaps the tokens under `:root[data-theme='light']`). Use the color tokens and
the variables beside them, never a raw color: `--color-accent-fg` for the accent as text or a
thin line, `stemColor(name, useTheme())` for a stem. `WINDOW_COLORS` in `traylogic.ts` must
match `--color-bg` and `--color-muted` (a test checks it). Playwright answers
`prefers-color-scheme` with "light" unless a launch passes `colorScheme: null`, as every one
in `e2e/` does. The switch sits at the foot of the sidebar and under Settings > Appearance.
`docs/adr/0020-light-mode.md`.

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
quits and the Dock icon stays. The icon has four states (`trayPresentation`): busy (a ring),
stems ready (a dot), a new version (`update`: a small dot over a shortened fourth bar, blue on
Windows) and idle, in that order of priority; `node scripts/make-icons.mjs` draws all four
for both systems. Both windows load one bundle; `?window=tray` picks
`src/tray/TrayApp.tsx`. What both windows do with dropped files lives in
`src/state/dropflow.tsx`. The quick-drop window does not hide on blur, on purpose:
`docs/adr/0008-tray.md`. In tests the tray is driven through `__openstemsE2E` (`e2e/helpers.ts`),
and the login item is a stand-in that never touches the registry.

Self-update: `electron/updatelogic.ts` is the state machine with no Electron in it (tested in
`src/test/update.test.tsx`); `electron/updater.ts` is the thin part on `electron-updater`.
Both steps, download and restart, wait for the user. The repository is public because
installed apps read its releases: `docs/adr/0010-self-update.md`. A Mac app updates itself
only when it is signed with a certificate, a Developer ID or the project's own
(`updater.updateBackend` asks `codesign` once at start; `updatelogic.canInstallUpdates`
decides). One signed ad hoc takes the manual path: the offer is marked `manual`, "download"
opens the release page, and the state stays `available`. 0.3.2 is the first self-signed
release, and it installed 0.3.3 by itself on the owner's M1 Max (ADR 0018).

Names: `OpenStems` where people read it and for folders, `openstems` for the command, the
Python package and keys, `OPENSTEMS_*` for environment variables. The app was lew-stems before
0.2.0; `settings.adopt_legacy_settings` carries a user's settings over once, and that name
survives only there, in the changelog and in `docs/adr/0009-rename-openstems.md`. The folder
`D:\lew-stems` on the development machine is a real folder and keeps its name.

Welcome: the first start with the engine ready, nothing installed and the key
`openstems.welcome.v1` (or the older `openstems.seed-offer.v1`) not in local storage opens
`components/Welcome.tsx`: folders with free space, format and auto start, the recommended
models. Every choice is the setting itself, saved at once. Free space is `fs:space` in the
main process (`statfs`; the folder walk is `electron/space.ts`, pure). Settings > Getting
started calls `showWelcomeAgain`. `OPENSTEMS_OUTPUT_DIR` and `OPENSTEMS_MODELS_DIR` win over
the folders picked there. `docs/adr/0021-welcome.md`.

Row menus: a right-click on a queue row (both windows) and a link row opens
`components/RowMenu.tsx`. `jobMenuItems` decides the items from the job's state and the
handlers a window passes (the quick-drop window has no reordering or Trim); `moveQueued` in
`QueueView.tsx` is the reorder shared with dragging. `shell:reveal` answers whether the file
was there. Nothing in the menu deletes a file. `docs/adr/0022-row-menus.md`.

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
When a site stops working, bump that pin and release: `.github/workflows/links-check.yml`
runs `scripts/check_ytdlp.py` every day and keeps an issue "Update yt-dlp to <version>" open
while the pin is behind the newest release. `python scripts/check_ytdlp.py --write` moves the
pin; then `uv lock` in `engine/`, try a real link, release. With `OPENSTEMS_ENGINE=fake` a stand-in
fetches: no test touches the network, and `slow`, `fail` or `playlist` in the address make it
slow, fail or refuse. In the app both windows share `components/LinkRow.tsx`, and pasting and
dropping links live in `state/dropflow.tsx` beside files.

Original file: a song's title drags its own file out (`components/SourceTitle.tsx`, in the
stems panel, the queue, History and the tray). The main process lets a drag through only
for the extensions in `DRAGGABLE` (`electron/main.ts`), which must hold the engine's
`AUDIO_SUFFIXES` (`cli_inputs.py`): change both together. A title dragged out and let go
over the app's own window is not queued again (`lib/sourcedrag.ts`).

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
stays 0. The option enters a run's cache key only when on. FL reads tempo from WAV only:
`domain/tempo.py` holds which formats carry it (`TEMPO_FORMATS`, the same set as
`TEMPO_FORMATS` in `app/src/components/FormatSelect.tsx`: change both together) and the notes
a job gets when its stems carry none (an MP3 or FLAC run, or no tempo found; the second goes
when a tempo is typed in). FL stretches a sample by itself only up to about a minute (60 s
yes, 90 s no, measured on 2026-11-23, not in its manual); a full stem needs the clip menu's
"Fit to tempo" with the "(embedded)" tempo, which the hint says. `docs/adr/0016-tempo-sync.md`.

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

Clips: a stretch of a song as a file of its own, to drag into a DAW. `POST /v1/clips`
(`pipeline/clip.py`) cuts it from stems of one stem set, summed into one file or one file
each, into `<stem folder>/Clips/`, or from the song's own file (`source`; a stem that was
itself separated is both) into `<output>/<track>/Clips/`. Start and end are seconds of the
song's timeline, a stem whose silence was trimmed keeps its place, and every clip of one
request has the same length. Always WAV: wav24 when the stems are, float otherwise. Each
clip carries `OpenStems clip <hash>` in its WAV's `LIST`/`INFO` comment and is found again by
it; a file of its name that is newer than what it was cut from is never written over (the
clip takes `(2)`, `(3)`), one that is older is replaced. `POST /v1/sources/preview`
(`pipeline/preview.py`) makes a song in the queue or the history playable before separation:
a FLAC, its peaks and the detected grid in `<cache>/previews/`, the 8 newest kept, which
`is_served` serves. Bar 1 (`downbeat`, seconds into the song) is detected with the tempo
(`analysis.detect_grid`) and set by hand like the tempo and key: `JobOptions.downbeat`,
`SetAnalysis.downbeat`, `analysis.downbeat` in the manifest; bar 1 alone rewrites the
manifest only. Stems carry `start` (offset / 44100). `clip_label` in `domain/grid.py` and
`rangeLabel` in `app/src/lib/grid.ts` name a selection alike ("bars 9-16", "9.3-11.2",
"0m21.40s-0m33.10s"), with JavaScript's rounding; the cases are in
`engine/tests/fixtures/clip_labels.json`, which `src/test/trimmer.test.tsx` reads too: change
both together. What may be typed for bar 1 is decided in `grid.clean_downbeat` and in
`cleanDownbeat` (`app/src/lib/grid.ts`): change both together. `docs/adr/0023-trimmer.md`.

Trimmer: the app's side of clips, an editor for one song at a time (`src/trimmer/`). Trim on
a queue row that waits or is separated (`canTrim`), in the row menu, and in the stems panel
(Queue and History: it opens on what solo and mute leave audible, past `OPEN_STEMS` on the
song's own file since every chosen stem is decoded whole, and `initialMix` puts them
back) shows `TrimEditor` in place of the view and the panel (`Workspace` in `App.tsx`); the
sidebar stays, and a view switch or the song leaving the list closes it. The view stays
mounted under it (`inert`, and not drawn once the editor has come in), so Back finds its
scroll and search; only the stems panel goes, frozen during the entrance (`frozen`), and
`StartButton` stops listening (`listen`). The quick-drop window has none. `song.ts` builds the song from a job or a stem set and holds the grid rules
(`songGrid`, `gridChange`, `resetChange`); `model.ts` the chips, snapping and moving, the
readout, the zoom wheel per platform (`isZoomWheel`) and what a handle asks for
(`clipRequest`); `Stage.tsx` the ruler (bar 1's flag, the two-point fit with `fitBar`), the
waveform and the overview; `memory.ts` what each song was left as, for the session, with the
timeline it was on (`origin`, moved by `moveRange` when a part comes back separated). One tempo
per song: the grid, `downbeat` with it, is saved through `useSetAnalysis` (the job's route,
else the stem set's) when a gesture ends, never on every frame; a nudge or tap still waiting
is saved when the editor is left. `lib/grid.ts` is the grid as
plain functions. `audio/pyramid.ts` draws a waveform at any zoom from decoded audio, and from
the engine's peaks until then; several chosen stems are layers (`drawLayers`), each in its
`stemColor`, ordered per pixel column so none hides another. `audio/trimplayer.ts` plays the song's own file (its preview,
`useSourcePreview`) and the stems from the song's 0 (a stem padded by its `start`), with a
loop, play once and a click, and decodes a track only when it is chosen. `state/clip.ts`
(`useClipFiles`) has the engine write what a handle gives before its drag: a mix through
`/v1/mixes`, a part through `/v1/clips`, 350 ms after the request settles and never
mid-gesture; an editor opened anew asks again (`forgetWritten`), so a deleted or stale clip
is written anew. The footer's widths are set per container width in `styles.css`, and the
toasts rise above it (`--toast-lift`). Twins: `rangeLabel` and `clip_label`, `cleanDownbeat` and `clean_downbeat` (see
Clips): change both together. Words for keys come from `freeKey` (Alt, Option), `modName` and
`modClick` in `src/platform.ts`. Tests: `src/test/trimmer.test.tsx`, `src/test/layers.test.ts`
(the layered waveform), the Mac cases in `src/test/mac.test.tsx`, and `pnpm e2e trimmer`.
`docs/adr/0023-trimmer.md`.

Separating only the part: with `separate_selection` on (off by default; read when the song
starts), a part chosen on a waiting song is all that is separated, as a song of its own named
"<song> (<label>)" (`Track.part`). `POST /v1/jobs/{id}/range` sets it (`{"range": {start,
end, grid?}}`) or takes it away (`{"range": null}`), refused once the song has started and
when a job is created; it is named by `clip_label` when it is set, and again whenever the
job's tempo or bar 1 changes (`JobManager.set_analysis`). A job without a tempo of its own
keeps the grid the part was named on (`_keep_grid` in `api/jobs.py`). It is cut where a clip of
the same selection is (`SongPart.frames`), and its timeline starts at the part's start:
`manifest.source.range` records it, and its samples and duration are the part's. Bar 1 is
moved into the part by whole bars (`grid.part_downbeat`). The cache key carries the frames
only for a part. `JobInfo.part` and `StemSetInfo.part` say what ran; the trimmer opens a
part's stems without Original (`isPart` in `song.ts`). In the app the setting is "Separate
only the trimmed part" in Settings > Queue. While it is on, `TrimEditor` sends a waiting
song's selection as its part once it settles (`useSetJobRange`; again when a new grid names
it differently, `null` when it is cleared), its readout says "Start separates only
<label>.", and the queue rows of both windows add "<label> only" (`statusText`, `jobRange`).
Off, the editor sends nothing and nothing mentions a part. `docs/adr/0023-trimmer.md`.

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

- Test songs (CC-BY, Kevin MacLeod) are in `D:\lew-stems\test-audio`; they are never committed.
- Target: Windows, NVIDIA RTX 5070 Ti (16 GB). C: is nearly full; keep models and outputs on D:
  (`OPENSTEMS_MODELS_DIR`, `OPENSTEMS_OUTPUT_DIR`).
