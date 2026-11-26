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
    sets into `D:\lew-stems\bench`. Slakh's archive is shuffled, so it is downloaded whole to D:
    (104 GB free needed; it resumes after a drop or a restart), checked, the test songs
    extracted and the archive deleted.
  - `uv run --with mido==1.3.3 --with mir_eval==0.8.2 python ../scripts/midi_bench.py score|pack`:
    score transcribers with mir_eval, or build the audio pack the owner runs through Melodyne
    and NeuralNote. `--methods openstems,openstems-midi` is the engine's own transcriber, at
    exact pitch and as the keys its MIDI holds; `yin` is the tracker it replaced.
    `--sets slakh-low` is Slakh's bass played 7 semitones lower, for notes under SwiftF0's
    floor. `score --pack-only --methods ...,openstems-midi,melodyne` compares with
    Melodyne on the same clips. Melodyne's notes file says 120 BPM, but its notes sit on the
    tempo in the `<document>.tempo.mid` it writes beside it. The scorer pairs each export with
    the tempo file written at the same moment (`melodyne_tempo`). The owner's exports go in
    `baseline-pack/midi/` as `<clip>.melodyne.mid`, copied with their times kept (`cp -p`)
    from the `<clip>.mid` Melodyne names them; the originals are left as they are.
  - `python ../scripts/make_midi_import_tests.py`: the MIDI files that show how a DAW imports
    bends, MPE and tempo maps.
  - `uv run --with mir_eval==0.8.2 --with mido==1.3.3 python ../scripts/midi_calibrate.py fit|report`:
    fit the transcriber's confidence model on every other clip, read alone and with the rest
    of a song bleeding in (`BLEED`), and print the `weights` and `threshold` for `PROFILES`
    (`fit`), or say how far the weights now in the code can be trusted on the clips between,
    alone and with bleed (`report`). Each clip's audio and frames are kept in
    `<bench>/cache/f0`: delete it after changing how frames are made
- `python ../scripts/compare_builds.py run --out DIR MODEL...` in each environment, then
  `compare DIR DIR`: the same stems from two PyTorch builds (on the CPU)
- `uv run pytest tests/test_links_mixes.py`: links and mixes, with a stand-in for the fetch
  (no test touches the network)
- `uv run pytest tests/test_clips.py`: clips, bar 1 and the previews of songs' own files,
  with the FakeEngine and synthetic beats
- `uv run pytest tests/test_separate_selection.py`: a part of a song separated alone (the
  setting, `POST /v1/jobs/{id}/range`, the run), with the FakeEngine
- `uv run pytest tests/test_hidden_stems.py`: stems hidden or kept by hand (the manifest,
  the route, a second separation, a rename), with the FakeEngine
- `uv run pytest tests/test_rename.py`: a song's name by the user (the rule, a run under a
  name, stems renamed on the disk, both routes), with the FakeEngine
- `uv run pytest tests/test_empty_stems.py`: which stems are empty (the rule, the peak a run
  measures, stems from before it, the setting), with the FakeEngine
- `uv run pytest tests/test_swiftf0.py`: SwiftF0 (the pitch tracker stem to MIDI uses, pinned
  with `onnxruntime` in `pyproject.toml`) is installed with its model and hears a tone on the CPU
- `uv run pytest tests/test_transcribe.py tests/test_notes_pipeline.py tests/test_notes_midi.py`:
  stem to MIDI: the transcriber on synthetic lines, the files a run writes, `POST /v1/notes`,
  and the notes file and MIDI writer
- `uv run openstems serve`: start the local API (prints a JSON line with port and token)
- `uv run openstems openapi --out openapi.json`: export the schema after any API change, then
  `pnpm gen:api` in `app/` (a test fails if `engine/openapi.json` is stale)
- `uv run python ../scripts/gen_catalog.py --write`: regenerate `catalog/models.toml` (never
  edit that file by hand). A model's `memory_gb` comes from `MEMORY_GB` in that script,
  copied from the Peak VRAM column of `docs/benchmarks.md`

Site (the landing page on GitHub Pages, `site/`, `docs/adr/0025-site.md`; its sections,
their addresses and what the app could link to are in `docs/site.md`):

- `node scripts/build-site.mjs [OUT]`: assemble the site into `_site/` (or OUT) with the
  changelog, the icon and three README pictures, and the version from `app/package.json`
  (what the page shows until GitHub answers); serve it with `python -m http.server -d OUT`
  (the page fetches `CHANGELOG.md`, so `file://` does not work)
- `.github/workflows/pages.yml` deploys it on a push to `main` that touches it, the
  changelog or those pictures (a pull request only builds it). The support button opens the
  `href` of `#support-link` in `site/index.html` (the owner's Ko-fi page) and hides if that
  is emptied. Its requirements, the
  Mac's first-open steps and "Will it run?" (`MACHINES` in `site/main.js`, the README's
  Memory table) copy the README's, and its OpenStems Studio section (anchor `#trim`) copies `rangeLabel`, `rangeLength`
  and `mixLabel`: change both together. Sizes in `site/style.css` are in rem (media queries and
  hairlines stay in px): past 1920px the root size grows with the window, to twice at 3840px,
  so a 4K screen at 100% shows the 1920px layout larger. Write new sizes in rem

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
  the row menus (`3b-row-menu.png`, `tray-4b-row-menu.png`), and the foot of Settings with
  its links to the website (`7b-settings-about.png`). Renaming is taken in both
  (`rename-1-menu.png` to `rename-5-panel-field.png`, and `light-` the same). The trimmer is taken in both
  (`trim-1-open.png` to `trim-5-queue-part.png`, `light-trim-1-open.png` to
  `light-trim-5-queue-part.png`, and `trim-6-bar-one-before.png` with its light twin: bar 1's
  flag at the left edge), on a drum loop the spec writes
- `pnpm e2e theme`: the theme switch, both windows, the pick across a restart
- `pnpm e2e welcome`: the welcome on a first start (`OPENSTEMS_E2E_WELCOME=1` forces it,
  since the FakeEngine has every model; `__openstemsE2E.pickFolder` stands in for the folder
  picker). `pnpm e2e row-menu`: the right-click menu on queue rows, both windows
- `pnpm e2e trimmer`: the trimmer on the FakeEngine: a grid fixed by hand and parts of a
  stem, of every stem and of a mix dragged out as WAVs the length of the part; a waiting
  song's own file; bar 1 dragged before the song and back, lengths in bars and the loop a new
  part gets; "Separate only the trimmed part"; Trim from the stems panel; a stem that
  enters late (`OPENSTEMS_FAKE_LATE=<stem>:<seconds>` leaves a FakeEngine stem silent at its
  start, so with Trim silence on its file begins later in the song)
- `pnpm e2e -g "undo and redo"`: a grid messed up in the trimmer and put right, read back
  from the song's manifest, the part, and the steps kept across leaving the song.
  `UNDO_SHOTS=<folder>` saves two pictures of it
- `pnpm e2e rename`: a song renamed from its row's menu before it runs, then its stems on
  the disk from the stems panel (also while they play) and from History
- `pnpm exec playwright test e2e/empty-stems.spec.ts`: stems with nothing in them left out of
  the panel, the quick-drop window and the drag handles (`OPENSTEMS_FAKE_EMPTY=<stem>,<stem>`
  leaves those FakeEngine stems a hiss). `EMPTY_SHOTS=<folder>` saves pictures of it
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

Website links: `app/electron/links.ts` holds the addresses the app opens in the browser
(`WEBSITE`, `REPOSITORY`, `siteLink(section)` for the changelog, Will it run? and Support
sections), with no Node or Electron imports, for the main process and the renderer alike.
`AboutSettings` (Settings > About, both systems) and the Mac Help menu (`macMenuTemplate`)
use them, and the memory row links to Will it run?. In a window a link is `ExternalLink`
(`components/ui.tsx`), a real link with `target="_blank"`, which `electron/windows.ts` sends
to the browser. The section anchors are the site's (`docs/site.md`): `src/test/links.test.tsx`
reads `site/index.html` and fails when one the app names is gone. Change both together.
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

Queue order and search: the engine lists jobs in the order they run; the full window sorts
and narrows that list itself (`app/src/lib/queuesort.ts`, plain functions: `sortQueue`,
`searchTerms`, `matchesSearch`, `loadSort`). Newest first by default, also Oldest, Name and
Run order; the pick is `openstems.queue.sort.v1` in local storage. Links being fetched are
sorted with the jobs. A waiting song's drag handle is there in Run order only (`reorderable`);
the menu's moves stay. Search matches every word in the song's or recipe's name, accents and
case aside; Ctrl+F (Cmd+F) goes to it (`QueueSearch` in `QueueView.tsx`). A row animates in
only when it is new to the queue (`enter`, read once), never when a search or a sort brings
it back. Tests about rows, not their order, pin `SORT_KEY` to `run`. The quick-drop window
has neither. `docs/adr/0026-queue-search-sort.md`.

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

Empty stems: a stem is `empty` when its peak stays more than 45 dB under the loudest stem
of its set (`domain/levels.py`, `EMPTY_BELOW_DB`; the figures behind it are in the ADR). A
run measures each stem's peak before normalize and keeps it in the manifest (`Stem.peak`);
stems from before that are judged from their peaks files (`pipeline/levels.py`,
`mark_empty`), index rows and saved jobs once at start (`Index.mark_empty_stems`,
`_with_empty` in `api/jobs.py`). `StemFile.empty` carries the verdict. Every stem is
written whatever it says, and the engine never reads the `hide_empty_stems` setting (on by
default): it is the app's. In the app `lib/empty.ts` (`splitEmpty`) decides what a list
shows: the stems panel (`hideEmpty`; a line under the list brings them back), the pills of
the quick-drop window ("+N empty", per song) and the handles that drag every stem all leave
empty stems out, and a song whose stems are all empty shows them all. What is left out is
not decoded, played, mixed or dragged, and Trim from the panel opens on what is shown. With
the setting off an empty stem is only dimmed (`data-empty`). The trimmer's own chips list
every stem. The user can also decide for one stem: `hidden` in the manifest's stem and in
`StemFile` (true: left out whatever the setting; false: kept in though empty; absent: the
rule and the setting decide). `POST /v1/stemsets/hidden` (`pipeline/levels.py`,
`set_hidden`) keeps it in the manifest, so it stays after the panel is left, in both
windows, through a rename, and through a second separation into the same folder
(`_hidden_choices` in `pipeline/run.py`). `isLeftOut` is the one rule for every list, the
History row included; `hideChoice` is what a row's Hide button stores, and `leftOutWord`
says "hidden" once any left-out stem was hidden by hand. The quick-drop window has no Hide
button. `docs/adr/0027-empty-stems.md`.

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

A song's name: a song goes by its file's name until the user gives it another, and the
name is the song's, not a row's. A job's `name` option (`RunOptions.name`, `Track.title`)
names a run: the folder `<output>/<name>/<recipe>`, the stems through `{track}`, and
`source.name` in the manifest; it is not in the cache key. `JobInfo.track_name` is that
name or else the file's. `POST /v1/jobs/{id}/name` (`Service.rename_job`) names every row
of the same file: a row that waits keeps it for its run, and stems that are written are
renamed on the disk. `POST /v1/stemsets/name` (`rename_stem_set`) does the same from a stem
folder and resolves with the stem set where it is now. `pipeline/rename.py` (`rename_song`)
is the disk's part: the song's folder first (on Windows it cannot move while a file in it
is open elsewhere, and then nothing has changed), then the stems and MIDI files of every
stem folder in it and each manifest, undone if a step fails; a folder or file that has the
new name stops it. Mixes and clips keep the names they have. `Service._rename_folder` has
the index and the queue follow (`JobManager.moved`, `set_name`), and refuses while the song
runs. A file queued again takes the name it was given (`Service._given_name`). A part
separated alone keeps its label: the job's route composes "<name> (<label>)", the stem
set's takes the name whole. null gives the file's name back. The song's own file is never
renamed. What may be typed is decided in `clean_name` (`domain/naming.py`) and `cleanName`
(`app/src/lib/songname.ts`), both tested against `engine/tests/fixtures/song_names.json`:
change both together. In the app `components/SongName.tsx` is the title that turns into a
field in place (`.name-input`: margin takes back padding, so nothing moves; no motion);
`useRename` in `api/queries.ts` saves. Ways in: Rename in the queue row's menu (an item
with `takesFocus` keeps the closing menu from taking the focus back: `finalFocus` in
`RowMenu.tsx`), the pencil and F2 in the stems panel, and a double click on a title where a
click does not move it (`doubleClick`: not a row of the queue or History whose stems are
closed, since the first click opens them and the list can reflow). The quick-drop window has none.
`docs/adr/0028-rename.md`.

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
readout, the zoom wheel per platform (`isZoomWheel`), a part of so many bars (`barsRange`,
`BAR_LENGTHS`, the typed length kept as `openstems.trim.bars.v1`), where a click puts the
playhead (`seekPlace`: 0:00 when that is nearer than a line) and what a handle asks for
(`clipRequest`); `Stage.tsx` the ruler (bar 1's flag, the two-point fit with `fitBar`), the
waveform and the overview. Bar 1 before the song's start keeps its flag at the left edge
(`pinned`), to be dragged back in; the start takes hold of a flag dragged close to it
(`flagPlace`), and a double click on the flag or 0:00 in the toolbar puts bar 1 there. A part
chosen where there was none is looped (`selectionDone` in `TrimEditor.tsx`); Home is
`toStart`; `memory.ts` what each song was left as, for the session, with the
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

Undo and redo in the trimmer: `trimmer/history.ts` is the history as plain functions
(`record`, `undo`, `redo`, `figuresChange`, `nextWhat`). A step (`Moment`) is the song's
saved figures, the grid they draw, the part and `fitted`, taken when a change is complete:
in `save` for the grid (a run of nudges or taps is one save, so one step) and in
`selectionDone` and `clearSelection` for the part, where changes less than `RUN_MS` apart
are one step. The view, the snap, the chips, the loop and the playhead are not steps. An
undo goes through the editor's own `save` (`travel`), so it is saved like any change of the
grid and put back with a toast when the engine refuses; `travelling` keeps that save from
being a step itself. Steps are taken from what the song is meant to have (`intended`,
`settledGrid`), ahead of the song while a save is on its way. They are kept in
`TrimMemory.history` for the session and dropped when the song's timeline changes. Keys:
Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y (Cmd on a Mac; `shortcut('Z')`, `redoShortcut()`), not in a
field and not during a gesture. The two buttons are in `TopBar`, always there.
`docs/adr/0029-studio-undo.md`.

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

Stem to MIDI: with `write_midi` on (off by default), a stem that plays one note at a time is
read by `audio/transcribe.py` (`transcribe_line`: no torch, so the API process may call it).
Every stem is read at one level (`LEVEL`; its peak is its 32nd largest sample, `peak_level`),
so the notes do not depend on its gain, and a sample that is no number counts as silence.
SwiftF0 gives a pitch every 16 ms; its own segmenter, ported there, cuts them into notes. The
stem's name picks one of three profiles (`domain/notes.line_kind`): `voice`, `bass` (a second
pass at double speed for notes under SwiftF0's 46.9 Hz floor) and `line` for any other pitched
stem; `bass` and `line` cut a note where it is struck again (an onset in the spectrum with a
rise in the stem's own level, `struck_again`: bleed from a drum has only the first) and move
each start back to the attack. Drums, mixtures and empty stems are not read. `MIDI_STEMS` is
what the setting reads by itself: voices, basses and `melody`. A second, more willing pass adds
candidates, which never move a note of the first pass (`_placed`). Every note has a confidence
from a logistic model whose weights are in `PROFILES` (printed by `scripts/midi_calibrate.py
fit`: never typed by hand; fitted on each clip alone and with the rest of a song 25 and 15 dB
under it, the stand-in for separated stems); a profile's `threshold` is where a note counts.
`pipeline/notes.py` writes two files beside the stem: `<stem>.notes.json` (`domain/notes.py`:
every note, the threshold, the tuning, what wrote it, and `texture`, `chords` for a stem that
plays several notes at once and was read as one line: `transcribe.clarity`) and `<stem>.mid`,
the notes that count, one track, on the song's tempo and key. A stem in which no note counts
gets the notes file alone. `Stem.notes` and `StemFile.notes` carry it; `STEM_FILES`
(`domain/stem.py`) names the files a rename or a replaced run must take along. Every MIDI file
is made from its notes file, to the byte (`midi_from_sidecar`): a retag makes it again, and a
rename puts the song's new name inside one that is still what the app made
(`retag.rewrite_midi`). A damaged or missing notes file stops neither; one that cannot be read
now stops both. The keys are at A440 unless a stem with fixed pitches agrees firmly on another
tuning, one tuning for the song over every stem whose notes are known
(`pipeline/notes.song_tuning`): a stem read later can settle it, and the MIDI of the stems read
before is then rounded again from their notes files. If reading a stem fails the stems are
still written and the job says so (`extras._read_notes`). `POST /v1/notes` reads stems that are
already written; nothing in the app calls it yet. It is two steps: `read_stems` (seconds,
writes nothing) and `write_notes`, which starts from the manifest as it is then and writes
everything or puts every file back. A file that is not a stem's own is never written over or
removed (`_in_the_way`; Melodyne saves its export as `<audio name>.mid` beside the audio). Its
own are the ones the manifest names and ones that are, to the byte, what the app writes there
(`_adopt`). The manifest is written before the files it names (a stem's notes file last), so a
write cut short is finished by the next. Putting back is a rename: what a file held is parked
beside it (`.old.tmp`) until the write is done. In the API process whatever rewrites a stem
folder's manifest (notes, a tempo or key, hidden stems, a rename) holds `Service._folder`, one
lock per folder, and is refused while the running job may be writing that folder
(`Service._not_being_written`): do both in anything new that does. The cache:
`KEYED_MIDI_STEMS` are the only names in a run's key, written as 0.4.x wrote them, and a song
from the cache whose stems have no notes file, or notes from another transcriber, is read where
it lies, not separated again (`Pipeline._with_notes`, `notes.stale`). Raise the number in
`METHOD` (`pipeline/notes.py`) whenever the notes a stem gives change. Measured on clean
recordings, and with the rest of a song under the stem as a stand-in for bleed; separated stems
wait for the GPU. Nothing of it has been seen on a Mac, and its tests have not run on one (CI
runs on pull requests and `main`). `docs/adr/0030-single-line-transcriber.md`,
`docs/research/stem-to-midi.md` section 14.

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
