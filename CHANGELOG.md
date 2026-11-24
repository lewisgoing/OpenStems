# Changelog

## 0.3.6 (2026-11-23)

- **Drag the original song by its title.** The song's name in the stems panel, the queue,
  History and the quick-drop window now drags the original file out, into a DAW or a
  folder, like a stem. A song fetched from a link drags out in the format the site sent
  (often `.webm` or `.m4a`), before or after it is separated, so OpenStems also works as a
  song downloader. Letting go over OpenStems itself does not queue the song again. A title
  whose file was moved or deleted stays plain text. On Windows and on a Mac alike (not seen
  on a Mac yet).

## 0.3.5 (2026-11-23)

- **Tempo sync says when it cannot work.** FL Studio reads a sample's tempo from WAV files
  only, so MP3 and FLAC stems never carried one, and nothing said so: with MP3 chosen, most
  stems reached FL with no tempo. Now the format list marks MP3 and FLAC "No tempo" while
  tempo sync is on, Settings says so under the switch, and a song written that way carries
  a note saying why its stems have no tempo. A song in which no tempo was found says that
  too, and the note goes once you type a tempo in. FL Studio also needs "Read sample tempo
  information" on in its General settings; the hint names it. `docs/adr/0016-tempo-sync.md`.
- **Full-length stems in FL Studio: use Fit to tempo.** FL Studio stretches a sample to the
  project's tempo by itself only when it is about a minute long or less (measured: 60 seconds
  stretch, 90 do not). A whole stem is longer, so FL reads its tempo but leaves it unstretched.
  Open the clip's menu, choose Fit to tempo and pick the tempo marked "(embedded)": the stem
  then follows the project. The tempo sync hint in Settings says so.

## 0.3.4 (2026-11-23)

- **Pasted links: yt-dlp 2026.11.23**, from 2026.10.26. Sites change how they serve audio,
  and a newer yt-dlp is what keeps links working. Tried with a real YouTube link on Windows.
- For the project, nothing changes in the app: a daily check opens an issue in the
  repository when a newer yt-dlp is out, the usual sign that pasted links need an update
  (`.github/workflows/links-check.yml`, `scripts/check_ytdlp.py`).

## 0.3.3 (2026-11-23)

- **Light mode.** Pick Light, Dark or System with the three icons at the foot of the
  sidebar, or under Settings > Appearance. System follows the computer's setting as it
  changes. The quick-drop window follows the same pick. Stem colors and waveforms get
  deeper shades on a light page so each stays visible. The app stays dark until you pick
  otherwise. On Windows and on a Mac alike (not seen on a Mac yet).
  `docs/adr/0020-light-mode.md`.

## 0.3.2 (2026-11-23)

- **The tempo and key can be corrected.** A song that waits in the queue shows two small
  fields, "auto" until you type the tempo or the key yourself. Finished stems show the same
  fields in the stems panel: type over a wrong figure and the manifest, file names made
  with `{bpm}` or `{key}`, and the tempo FL Studio reads from the stems and their mixes all
  follow. The audio is not rewritten and the song is not separated again. What detection
  found is kept in the manifest. `docs/adr/0019-edit-tempo-key.md`.
- The stems panel shows the tempo to two decimals, not rounded to a whole number.
- **A Mac app can update itself without an Apple Developer ID.** The Mac build can now be
  signed with a certificate the project makes itself, and an app signed that way installs
  new versions as on Windows. Seen on a CI Mac, where one build installed a newer one; not
  yet on a Mac with a person at it, and no release has been signed this way yet. macOS
  still asks before the first open. Apps on 0.3.0 and 0.3.1 take the first such release by
  hand, once. `docs/adr/0018-mac-self-signed.md`.

## 0.3.1 (2026-11-23)

- **Every stem.** A new recipe, `every-stem`, chains four models into the deepest split
  in one run: lead and backing vocals, the drum kit piece by piece (kick, snare, toms, hh,
  ride, crash and what is left of the drums), bass, guitar, piano and other. Thirteen
  files, and each sample of the song is in exactly one of them, so they can all go into
  a DAW together. In the stems panel the parts sit under Vocals, Drums and Melody: solo
  or mute a whole group from its heading, or drag it out as one file. On Windows and on
  a Mac alike (not run on a Mac by us). `docs/adr/0017-every-stem.md`.
- Recipes of your own can put stems in a group with `group = "drums"` on an output.
- **Tempo-synced stems for FL Studio.** A new setting, off by default, writes the detected
  tempo into WAV stems and mixes, so FL Studio stretches them to the project's tempo when
  they are dropped in. Tried in FL Studio 2026 on Windows. It is as accurate as the detected
  tempo; FLAC and MP3 cannot carry it. `docs/adr/0016-tempo-sync.md`.
- **Machines with little memory.** The app now knows how much memory each model needs and
  how much the machine has for one run, and marks every model and recipe as fitting, tight
  or too large. Think of a Mac with 8 GB, or a card with 4 to 6 GB. Nothing is blocked. The
  README has a table of what fits where; `docs/adr/0015-low-memory.md` has the rules.
- **A job that runs out of graphics memory no longer fails.** The engine frees its other
  loaded models and tries again, then runs that one model on the CPU for that job. The job
  finishes, slower, and says "ran on the CPU: not enough GPU memory". The note is also in
  the manifest. Out-of-memory errors from the Apple GPU are now recognised here too.
- **The first download fits the machine.** Where a recommended model is too large, a lighter
  model for the same use is offered in its place. `openstems models pull --set recommended`
  does the same from the terminal.
- A machine with a budget under 8 GB keeps one model loaded at most and frees it after one
  minute without a job, not ten.
- Checkpoints are loaded without holding the weights in memory twice.
- `OPENSTEMS_MEMORY_GB=<number>` makes the engine plan as if the machine had that much
  memory, so a large machine can act as a small one. It is for testing and support, and
  does not take memory away.
- `openstems doctor` prints the memory one model run may use, and `doctor --json` prints
  the whole report as JSON.
- The engine's API process no longer imports PyTorch for the system check: it runs the
  doctor in a process of its own and keeps the report between starts, so it holds no
  graphics memory and the app does not wait for the check each time it starts.
- The memory figures for Macs, for the CPU and for the GTX 900 and 10 series are estimates,
  and none of this has run on a small machine yet. On a card with 16 GB everything fits and
  nothing changes.
- **Run on a Mac.** The 0.3.0 Mac build was installed from the dmg on an M1 Max on
  2026-11-23: first-run setup, a separation on the Apple GPU and the menu bar item all
  worked. Speed is not measured yet, and no Mac with 8 or 16 GB has been tried.
- First-run setup says what is wrong when the system refuses its folder, and how to fix it,
  where it used to show "EACCES". On a Mac the usual cause is an `Application Support`
  folder that belongs to root.
- Two tests that depended on timing no longer fail on the Mac runner.

## 0.3.0 (2026-11-23)

- **macOS on Apple Silicon (preview, not yet run on a Mac by us).** OpenStems can be built
  for Macs with an M1 or later chip and macOS 14 or later. The models run on the Apple GPU
  through PyTorch's MPS backend, at full precision. It was written and unit-tested on
  Windows; no separation, installer or menu bar item has been seen working on a Mac.
  `docs/adr/0014-macos.md` lists what was checked and what is unproven. Intel Macs are not
  supported.
- On a Mac the app lives in the menu bar, with the quick-drop window under it, a standard
  application menu and a Dock icon. Closing the window never quits; Cmd+Q does.
- First-run setup on a Mac installs one build (about 350 MB) with nothing to choose.
- The Mac build has no Apple Developer ID: it is signed ad hoc, which names nobody. macOS
  asks for a confirmation in System Settings the first
  time (the README has the steps), and a new version is offered with a link to the release
  page instead of installing itself. A build signed with an Apple Developer ID updates itself
  as on Windows; signing happens when the certificate is supplied to the build.
- Engine: `openstems doctor` and `selftest` know the Apple GPU. If the GPU's STFT does not
  match the CPU's on a Mac, that one step runs on the CPU and the doctor says so. The doctor
  and the self-test can now carry notes that are not problems.
- Nothing changes on Windows: the same builds, folders and installer.

## 0.2.5 (2026-11-22)

- **Paste a link.** A song can be queued from its web address: copy the link, then press
  Ctrl+V in either window, use Paste link, or drag the link in from a browser. OpenStems
  fetches the audio (YouTube, SoundCloud, Bandcamp and many other sites) and queues it like a
  dropped file, with the recipe and quality that are selected. The fetch shows in the queue
  with its progress and can be cancelled; one that fails says why and can be tried again.
  Playlists and live streams are refused. Fetch only what you have the right to use.
- **Mix stems and drag the mix out.** In the quick-drop window, Mix turns the stems into a
  mix: click a stem to leave it out, play what is left together, and drag it out as one file
  (`Song - no vocals.wav`). In the full window, what solo and mute leave audible has a "Drag
  mix" handle beside "Drag all". Mixes are written to a `Mixes` folder beside the stems.
- In the full window, a stem muted or soloed before pressing Play stays that way.
- An app that updates to this version installs the fetcher into its environment by itself
  (about 45 MB, once).
- `docs/adr/0013-links-and-mixes.md` records the decisions.

## 0.2.4 (2026-11-22)

- **Listen before you drag.** In the quick-drop window, click a stem to hear it and click
  again to stop. Another stem of the same song picks up at the same spot, so the same bar can
  be compared across stems. Dragging still drags.
- **A notification when stems are ready.** When songs finish while OpenStems is out of sight,
  Windows says so once, by name for one song or as a count for several. Clicking it opens the
  quick-drop window. Settings > Tray can turn it off.
- **Older NVIDIA cards (preview, not yet run on one).** A third engine build, PyTorch for
  CUDA 12.6, for the GTX 900 and 10 series, the GTX 750 Ti, the GT 1030, the Titan X, Xp and V
  and Quadro M and P cards. First-run setup picks it for such a card, and Settings > System
  lists all three builds.
- A card the installed build cannot run no longer fails jobs: the app runs on the CPU and
  says which build to switch to.
- On cards where half precision is slow (GTX 900 and 10 series), the engine uses full
  precision.
- `docs/adr/0012-older-nvidia.md` records the decision and what is unknown.

## 0.2.3 (2026-11-22)

- **Songs wait for Start.** Files you drop or add now wait in the queue until you press
  Start, so you can line up several and set their order first. Start runs every waiting song
  (Ctrl+Enter does the same); a waiting song can also be started by itself. Both windows
  have it. This is the new default.
- Settings > Queue > "Start songs automatically" brings back the old behavior, where each
  song starts as soon as it is added. The watch folder always starts its files.
- The tray icon stays quiet while songs only wait.

## 0.2.2 (2026-11-22)

- After an app update the Python environment is no longer rebuilt. The app installs what
  changed into the environment that is there, by itself, in seconds: no click, no download of
  Python or PyTorch. A first install, and switching the engine build, set up as before.
- AMD Radeon support has now been reported working on a Radeon by a user.

## 0.2.1 (2026-11-22)

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
