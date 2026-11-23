# Changelog

## Unreleased

- The output format (WAV 32-bit float, WAV 24-bit, FLAC, MP3 320 kbps) can be picked where
  files are dropped: on the recipe bar of the full window and in the quick-drop window. It is
  the same setting as Settings > Output > Format, so there is one format everywhere.

## 0.2.0 (2026-11-22)

### Renamed to OpenStems

- lew-stems is now OpenStems: the app, the installer (`OpenStems-Setup-<version>.exe`), the
  Start menu entry and the data folders. The command is `openstems`, the Python package is
  `openstems`, and the environment variables are `OPENSTEMS_*`.
- On the first start, settings, the folders they point to and user recipes are carried over
  from lew-stems. Nothing is moved or deleted, and no model is downloaded twice.
- OpenStems installs beside lew-stems. Uninstall lew-stems afterwards: that also removes its
  old Python environment.
- Every wheel built at packaging time is pinned by sha256 in the requirements files.
- `docs/adr/0009-rename-openstems.md` has the details.

### The app updates itself

- An installed app looks for a newer release on GitHub shortly after it starts and a few
  times a day. When there is one, a button appears in the title bar and in the quick-drop
  window: one click downloads the new version, a second restarts into it.
- Nothing is downloaded or installed unless you asked, and a restart asks first while jobs
  are queued or running.
- Settings > Updates has the same steps, "Check for updates", and a switch for the automatic
  check.
- 0.2.0 is the first version that can do this. `docs/adr/0010-self-update.md` has the details
  and the steps for publishing a release.

### The tray icon and the quick-drop window

- A tray icon. A click opens the quick-drop window against the taskbar: drop a song on it,
  drag the stems out of it, one at a time or all together. It shares the queue, the recipe and
  the quality with the full window, and stays open while another window has focus.
- The icon shows a ring while work is going on and a dot when stems finished out of sight;
  its tooltip names the track and the progress. Right-click for Quick drop, Open and Quit.
- Closing the window now leaves the app in the tray with the engine running ("Keep running in
  the tray" in Settings, on by default). `--tray` starts the app without a window, and
  "Start with Windows" in Settings registers that for sign-in.
- The engine unloads its warm models after ten minutes without a job, so an app left in the
  tray does not hold graphics memory (`OPENSTEMS_IDLE_UNLOAD_SECONDS`).
- The recipe and quality stay in step between windows.
- `docs/adr/0008-tray.md` records the decisions.

### AMD Radeon support (preview, not yet run on a Radeon)

- A second pinned dependency set: AMD's PyTorch for Windows (ROCm 7.2.1, PyTorch 2.9.1) beside
  the CUDA 13.0 build, as two dependency groups in one lockfile. The NVIDIA set is unchanged.
- First-run setup reads the video adapters and installs the build that fits: NVIDIA when an
  NVIDIA card is present, AMD for a Radeon AMD supports, the standard build on the CPU
  otherwise. The setup screen shows what was found and lets the user choose.
- Settings shows the installed build and can switch it, and has a "Use the GPU" switch.
- `openstems doctor` and the app name the GPU backend (CUDA or ROCm) and explain a missing GPU
  per vendor. The GPU check now includes an STFT compared with the CPU.
- `openstems selftest`: operations and one short separation per architecture, GPU against CPU.
  Settings has a button for it (`POST /v1/selftest`), and Export diagnostics includes the last
  result.
- The installer carries `requirements-rocm.txt`; AMD's wheels are pinned by sha256.
- `scripts/compare_builds.py` compares stems between two PyTorch builds.
- `docs/adr/0007-amd-rocm.md` records the decision, what was checked and what is unknown.

### Since the first installer

- The full-song wiring is decided, by ear and by score: `scripts/compare_wirings.py` scores
  both wirings on 50 MUSDB18 test excerpts, and they land within 0.1 dB of each other, so SW on
  the mix stays the default (`docs/adr/0003-catalog-and-recipes.md`).
- Out-of-memory recovery: the runner retries a chunk once at batch 1 after cleaning up, and the
  pipeline drops other warm models and retries the pass.
- A model that cannot load for lack of memory now says so.
- The installer and uninstaller were run for real and the results recorded in
  `docs/adr/0006-packaging.md`.

## 0.1.0 (2026-11-20)

The first installer, built as lew-stems. It was never tagged.

### Phase 6: packaging

- Windows installer (NSIS through electron-builder): per user, no administrator rights, Start
  menu entry, app icon.
- First-run setup inside the app: the bundled uv creates the Python environment, installs the
  pinned dependencies and four pre-built wheels, and runs the doctor check. No git, compiler
  or terminal is needed.
- `scripts/prepare-package.mjs` builds the wheels, exports the pinned requirements and fetches
  a hash-checked uv.
- `app.log` beside `engine.log`, and Export diagnostics in Settings.
- The uninstaller removes the Python environment and nothing else.
- `e2e/packaged.spec.ts` runs the packaged app on a clean profile. `docs/adr/0006-packaging.md`.

### Phase 5: producer features

- Tempo and key detection (beat tracking with a line fit for the tempo, Krumhansl-Schmuckler
  for the key), shown in the app and available as `{bpm}` and `{key}` naming tokens.
- Output options: WAV 24-bit, FLAC, MP3 320 kbps and match-the-source-sample-rate, with the
  stem length kept exact after resampling.
- History view: search, re-drag, and rerun a track with another recipe.
- Watch folder: new files are queued with the default recipe once their size has settled; the
  output folder is never picked up.
- Stem to MIDI for vocal, bass and melody stems (YIN pitch tracking, a built-in MIDI writer).
- Optional per-stem silence trim and normalization, both off by default.
- A test that pins the default output contract.

### Phase 4: desktop app

- Electron 45 shell with context isolation, sandbox, no Node integration and a small typed
  preload API. The main process starts the engine, waits for its health check, and stops it on
  quit. One app instance.
- Drop files and folders anywhere; native drag-out of one stem or all stems.
- Queue view with progress, cancel, retry, remove and drag-to-reorder. Recipe picker by use
  case with a single-model option, quality preset, sum-to-mix, and a stem picker for the
  53-stem recipe.
- Results panel: waveform per stem from the peaks files, solo, mute, sample-synced playback
  through Web Audio, Reveal in Explorer.
- Models view (installed and available, size, license, download progress, delete, import),
  History view, Settings view, and a first-run offer to download the recommended models.
- Component tests (Vitest) and end-to-end tests (Playwright driving Electron against the
  FakeEngine) in CI. `docs/adr/0005-desktop-shell.md`.

### Phase 3: local API and job queue

- FastAPI app on 127.0.0.1 with a random port and a bearer token on every route; `openstems
  serve` and `openstems openapi`.
- One GPU worker process fed by a queue: last model kept warm, VRAM-budget eviction, restart
  after a crash, cancel by job sequence number. Neither the API nor the worker outlives its
  parent process.
- Routes for tracks, jobs (create, batch, cancel, retry, reorder, remove), recipes, models
  (list, pull, cancel, delete, verify, import), settings, files with range requests, peaks,
  history and diagnostics. One WebSocket streams job and download progress in order.
- SQLite index of tracks, jobs and stem sets, rebuildable by scanning manifests.
- `engine/openapi.json` plus a test that fails when it drifts from the code.
- API tests run in CI against the FakeEngine with a real worker process;
  `scripts/accept_api.py` runs the same checks on the GPU. `docs/adr/0004-local-api.md`.

### Phase 2: catalog, recipes and quality presets

- Catalog of 17 models generated from the loaders' registries (`scripts/gen_catalog.py`);
  `models pull --set seed | all`, `models check` (liveness), `models import` (custom
  checkpoints behind a pickle warning).
- Mel-Band RoFormer and MDX23C adapters behind the same Engine port.
- Every recipe in the plan as TOML: `full-song-best-vocals` (plus the second wiring as
  `-alt`), `vocals-instrumental`, `acapella-clean`, `drum-kit`, `melody`, `drumless`,
  `cleanup-dereverb`, `cleanup-denoise`, `mega-53`. User recipes load from the config folder.
- Fast, Balanced and Best measured for every model; null test extended to all 17 models.
- `scripts/accept_recipes.py`; `docs/adr/0003-catalog-and-recipes.md`.

### Phase 1: core engine and CLI

- Domain package (pure Python, no torch): models, quality presets, recipes with chained passes
  and derived stems, jobs, stems, Windows-safe naming, the cache key.
- Catalog with BS-RoFormer SW and Leap Xe vocals; downloader with resume, sha256 verification
  and progress; `openstems models list | pull | verify | check`.
- Decode through PyAV to 44.1 kHz stereo float32; WAV 32-bit float stems plus a peaks file each.
- Shared chunked runner ported from MSST's `demix`: overlap-add windows, batching, autocast,
  test-time augmentation, cancel token, progress callback, out-of-memory batch backoff.
- BS-RoFormer adapter (model classes from bs-roformer-infer, pinned to a git commit) and a
  FakeEngine for tests.
- Pipeline: passes, input wiring, derived stems, ensembles, sum-to-mix, manifest, cache, and
  temp-folder writes so a cancel leaves no partial files.
- `openstems separate`, `recipes list`, `config show | set`.
- `scripts/`: `null_test.py`, `benchmark.py`, `check_stems.py`. `docs/benchmarks.md`,
  `docs/adr/0002-engine-adapter.md`.

### Phase 0: bootstrap

- Repo layout, `PLAN.md`, `CLAUDE.md`, CI on a Windows runner (ruff, pyright, pytest on CPU).
- `engine/` uv project on Python 3.12 with PyTorch 2.14.1 pinned to the cu130 wheel index.
- `openstems doctor`: Python, PyTorch, CUDA, GPU, VRAM and an FFmpeg decode round trip.
- `docs/adr/0001-stack.md`: verified stack versions and corrections to the plan.
