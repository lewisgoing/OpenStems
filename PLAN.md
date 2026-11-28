# OpenStems: build plan for Claude Code

2026-11-20 · @Lewis Going

OpenStems is a local Windows app for stem separation: drop audio files in, pick a recipe or model, and drag DAW-ready stems out. Build it in three layers: a Python engine (domain model, model catalog, GPU worker), a local HTTP API, and an Electron + React desktop shell.

Work through phases 0 to 6 in order. Each phase ends with passing checks, a push to the private GitHub repo `OpenStems`, and a stop for review.

## Ground rules for Claude Code

Treat this doc as the spec: follow it phase by phase, and record every deviation as a short decision record in `docs/adr/`.

1. **Location.** Create the repo as `OpenStems/` inside the Dev folder. Confirm the current directory is the Dev folder before creating anything.
2. **Remote.** Create the private repo with `gh repo create OpenStems --private --source=. --remote=origin --push`. If `gh` is not authenticated, stop and ask for `gh auth login`.
3. **Cadence.** Phase 0 goes straight to `main`. After that, use one branch and one pull request per phase, with small conventional commits, and push at the end of every working session.
4. **Gate.** A phase is done only when its acceptance checks pass. Then update `README.md` and `CHANGELOG.md`, push, open the pull request, and stop for review.
5. **Verify before coding.** Library APIs and model links move fast. Check current docs and versions before using any library named here, and pin exact versions in lockfiles.
6. **Never commit** model weights, audio files, outputs or secrets. The catalog stores URLs and sha256 hashes; weights download at runtime.
7. **Checkpoints are pickles.** Download only from catalog URLs, verify sha256 before loading, and load with `weights_only=True` wherever the checkpoint allows.
8. **Stop and ask** before deleting user files, changing system settings, installing system-wide software, or settling anything listed under Open decisions.
9. **Keep ****`CLAUDE.md`**** current.** It holds the run, test and lint commands, the repo layout, and these rules.

## Product scope

OpenStems turns any dropped audio file into DAW-ready stems on the local GPU, with no cloud step.

**Target machine:** Windows with an NVIDIA RTX 5070 Ti (16 GB of VRAM). Keep the code portable where that is free, but test only on this target.

**What the user does**

1. Drops files or folders onto the window. Any format FFmpeg can decode is accepted, including video containers.
2. Picks a recipe (a use case such as full song, drum kit or melody) or a single model, plus a quality preset.
3. Watches a queue with per-job progress, and can cancel or reorder jobs.
4. Previews stems with solo and mute, then drags one stem or all stems into the DAW or Explorer.

**Output contract**

- One folder per track and recipe: `{output_root}/{track}/{recipe}/{track} - {stem}.wav`, plus `manifest.json`.
- Default format: WAV, 32-bit float, 44.1 kHz stereo, which is the rate these models run at. Options: 24-bit, FLAC, MP3, match the source rate.
- Every stem has exactly the source's length and start, so stems line up at bar 1.
- No normalization or limiting by default. An optional sum-to-mix mode folds the residual into `other`.
- The manifest records the source path and hash, the recipe, and the model, hash and settings behind each stem.
- File names stay valid on Windows and keep non-ASCII characters.

**Non-goals for now:** real-time or plugin (VST) processing, model training, Linux builds, auto-update and code signing.

macOS was a non-goal until 2026-11-23. There is now a build for Apple Silicon Macs, written on Windows and run on one Mac so far (an M1 Max, 2026-11-23): `docs/adr/0014-macos.md`. The target machine above is still the only one the app is tested on.

Machines with less memory than the target are supported since 2026-11-23: every model has a memory figure, every machine a budget, and a run that does not fit ends on the CPU with a note instead of failing. Not yet run on a small machine: `docs/adr/0015-low-memory.md`.

## Domain model

Model the domain before any infrastructure: these types live in a pure-Python package that never imports torch.

A recipe works like a mixer insert chain. Each pass is one plugin, and a pass can take the track or an earlier pass's stem as its input.

| Type | What it is | Rules |
| --- | --- | --- |
| Track | A source audio file, registered by path and content hash | Never modified. Decoding writes to a cache. |
| Model | A catalog entry: architecture, files (URL, sha256, size), license, stems emitted | Usable only when every file is present and hash-verified. |
| Engine | The adapter that builds a model and runs it over audio chunks | Reports progress, honors cancel, never reads or writes audio files. |
| Pass | One model run: model, input, settings, stems to keep | Input is the mix or a stem from an earlier pass. No cycles. |
| Quality preset | Named settings: overlap, chunk size, batch size, test-time augmentation, precision | Fast, Balanced and Best, resolved per architecture. |
| Derived stem | A stem computed from other stems or the mix by sum or difference | Example: melody = other + guitar + piano. Sample-exact. |
| Recipe | A named, ordered set of passes plus derived stems and output options | Declarative TOML data with a version. Built-in or user-defined. |
| Job | One track run through one recipe | States: queued, preparing, running, writing, then done, failed or cancelled. One job on the GPU at a time. |
| Stem | One output audio file with its kind and provenance | Same length and start as the source. Knows its pass and model. |
| StemSet | All stems of a job plus the manifest | Files are the source of truth. The database is a rebuildable index. |

The cache key is track hash + recipe version + settings. A job whose key already has a complete StemSet returns it without running.

## Architecture

The UI never touches the GPU: it talks over localhost to an engine process that owns models, jobs and files.

The shell and the engine talk only over localhost. The engine writes stems to disk, and the shell hands those files to the DAW by native drag.

| Layer | Choice | Why |
| --- | --- | --- |
| Engine runtime | Python 3.12, [uv](https://docs.astral.sh/uv/guides/integration/pytorch/), PyTorch 2.13 or newer from the CUDA 13.0 wheel index | 50-series cards need a CUDA 12.8 or newer build. [PyTorch 2.13](https://dev-discuss.pytorch.org/t/pytorch-2-13-final-rc-available/3410) ships cu126, cu130 and cu132 wheels, so cu126 is out. |
| Model code | [bs-roformer-infer](https://github.com/openmirlab/bs-roformer-infer), [melband-roformer-infer](https://github.com/openmirlab/melband-roformer-infer), [mdxnet-infer](https://github.com/openmirlab/mdxnet-infer) | Inference-only, MIT, and they build the exact model classes the catalog needs. Their sha256-checked registries seed the catalog. |
| Inference loop | One shared chunked runner, ported from the `demix` function in [MSST](https://github.com/ZFTurbo/Music-Source-Separation-Training) (MIT) | None of these libraries documents a progress or cancel hook. One loop gives progress, cancel, overlap, test-time augmentation and out-of-memory backoff for every model. |
| Fallback engine | [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | Covers Demucs, VR and MDX-Net models and has built-in ensembling. |
| Decode | FFmpeg bundled through a Python package such as PyAV (verify) | Any input format with no system install. |
| API | FastAPI on 127.0.0.1 with a random port and a bearer token; WebSocket for events | Typed (OpenAPI to a generated TypeScript client), easy to debug, reusable from scripts. |
| Worker | One long-lived GPU process fed by a queue | Keeps the last model warm. A cancel or a crash cannot take the API down. |
| State | Manifests on disk plus a SQLite index | Outputs stay usable without the app. |
| Shell | [Electron](https://releases.electronjs.org/) (45 is the current stable line) | First-party [native drag-out](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop) through `webContents.startDrag`, and real paths for dropped files through `webUtils.getPathForFile`. |
| UI | React, TypeScript, Vite, Tailwind, shadcn/ui, TanStack Query, wavesurfer.js | Web Audio gives sample-synced stem playback; a web UI can be tested with Playwright. |

Pin PyTorch to the CUDA index in `engine/pyproject.toml`:

```toml
[tool.uv.sources]
torch = [{ index = "pytorch-cu130" }]

[[tool.uv.index]]
name = "pytorch-cu130"
url = "https://download.pytorch.org/whl/cu130"
explicit = true
```

**Alternatives not chosen**

- **Tauri 2:** lighter, but it adds a Rust toolchain and needs the third-party [tauri-plugin-drag](https://docs.crabnebula.dev/plugins/drag-rs/) for drag-out.
- **PySide6:** one language and native drag, but slower UI iteration and no browser test loop.
- **Browser-only UI:** has no reliable way to start a native file drag into a DAW.
- **splifft as the engine:** one library for BS, Mel-Band and MDX23C models, but its author still calls it pre-alpha. Re-evaluate it in the Phase 1 spike.

## Model catalog

Seed the catalog with the best public checkpoint per use case. The very top vocal and drum models are MVSEP-only and stay out.

| Use case | Model | Stems out | Loader | Status |
| --- | --- | --- | --- | --- |
| Full song | [BS-RoFormer SW](https://github.com/openmirlab/bs-roformer-infer) | vocals, drums, bass, guitar, piano, other | bs-roformer-infer | Verified: 699 MB, sha256 recorded, Hugging Face mirror. License unrecorded. |
| Vocals | [unwa BS-Roformer Leap Xe](https://mvsep.com/quality_checker/multisong_leaderboard?sort=vocals), vocals | vocals | bs-roformer-infer | In registry. Best public vocal score found: 11.79 dB SDR on MVSEP Multisong. |
| Instrumental | unwa BS-Roformer Leap Xe, instrumental | instrumental | bs-roformer-infer | In registry. |
| Vocal and instrumental alternates | unwa HyperACE v2; becruily vocals, instrumental and deux; Kim Mel-Band RoFormer | vocals, instrumental | bs-roformer-infer, [melband-roformer-infer](https://github.com/openmirlab/melband-roformer-infer) | In registries. For A/B listening and ensembles. |
| Lead and backing vocals | becruily karaoke; anvuew karaoke | lead, backing | bs-roformer-infer, melband-roformer-infer | In registries. |
| De-reverb | anvuew de-reverb | dry | bs-roformer-infer, melband-roformer-infer | In registries. |
| Denoise and de-bleed | Gabox denoise-debleed | clean | melband-roformer-infer | In registry. |
| Drum kit | [DrumSep MDX23C](https://github.com/openmirlab/mdxnet-infer) by aufr33 and jarredou | kick, snare, toms, hh, ride, crash | mdxnet-infer | Verified: OpenMIRLab release mirror with sha256. Weights license undocumented. |
| Guitar | becruily Mel-RoFormer guitar | guitar | melband-roformer-infer | In registry. |
| Many instruments | MVSep mega 53-stem by ZFTurbo | 53 stems | bs-roformer-infer | In registry. Experimental: at least 16 GB of VRAM recommended. |

Verified means the link, size or hash was confirmed on the source page on 2026-11-20. In registry means the loader's registry lists it; confirm the link and hash when adding it.

**Catalog rules**

- Keep the catalog in `engine/src/openstems/catalog/models.toml`: id, use cases, architecture, loader, files (URL, sha256, bytes), license, stems, sample rate, default chunk and overlap, notes.
- Copy URLs and hashes from the loaders' own registries, then check that every link is live. melband-roformer-infer reports only 57 of its 99 catalogued models as fully usable.
- Pull the whole seed set early and back up the models folder. Hosts vanish: the original SW and DrumSep hosts are both gone.
- Record every license. SW and DrumSep have none documented, which is fine for personal use but rules out redistributing weights.

**Out of reach locally**

- Vocals: MVSEP's BS Roformer 124 bands (no public weights found) and becruily's 124-band model (MVSEP-only).
- [MVSEP's DrumSep models](https://mvsep.com/algorithms/29) on SCNet XL, Mel-Band and BS RoFormer: kick SDR of 17.6 to 19.9 dB, against 14.5 dB for the public MDX23C model.
- The 5-stem MDX23C DrumSep by jarredou: its only host is gone and no intact mirror is known.

## Recipes

Each use case ships as a recipe, so choosing a use case is one click while choosing a single model stays possible.

| Recipe | Passes | Stems out |
| --- | --- | --- |
| `full-song` | SW on the mix | vocals, drums, bass, guitar, piano, other |
| `full-song-best-vocals` | Leap Xe vocals on the mix; SW on the mix for the rest | vocals from Leap Xe; drums, bass, guitar, piano, other from SW |
| `every-stem` (added 2026-11-23, `docs/adr/0017-every-stem.md`) | Leap Xe vocals, then the lead and backing split; SW on the mix, then DrumSep on the drums stem | lead vocals, backing vocals; kick, snare, toms, hh, ride, crash, other drums; bass; guitar, piano, other. The parts are grouped as vocals, drums and melody, and the groups themselves are not written |
| `vocals-instrumental` | Leap Xe vocals; Leap Xe instrumental | vocals, instrumental |
| `acapella-clean` | Leap Xe vocals, then de-reverb, then the lead and backing split | dry vocals, lead, backing |
| `drum-kit` | SW on the mix, then DrumSep on the drums stem | kick, snare, toms, hh, ride, crash, plus the full drums stem |
| `melody` | SW on the mix; melody derived as other + guitar + piano | melody, guitar, piano, other |
| `drumless` | SW on the mix; derived as mix minus drums | drumless |
| `cleanup` | One utility model on any file: de-reverb or denoise | cleaned file |
| `mega-53` (experimental) | The 53-stem model on the mix | the stems the user ticks |

- Recipes are TOML files in `engine/src/openstems/recipes/`. User recipes load from the config folder.
- A pass names its input as `mix` or `<pass>.<stem>`. That is how `drum-kit` and `acapella-clean` chain.
- A single-model run is a one-pass recipe generated on the fly.
- An output can name a `group`, the larger stem it is a part of. The parts of a group add up to it.
- `melody` assumes melody separation means everything that is not vocals, drums or bass. Confirm it under Open decisions.
- `full-song-best-vocals` has a second wiring to test: SW on the Leap Xe instrumental instead of the mix. Keep whichever sounds cleaner.
- Ensemble passes, which average several models for one stem, arrive in Phase 2.

## Repo layout

One repo holds two packages: `engine/` in Python and `app/` in Electron and React.

```
OpenStems/
├─ CLAUDE.md               # commands, layout, ground rules
├─ PLAN.md                 # this plan
├─ README.md
├─ CHANGELOG.md
├─ .gitignore              # models, outputs, caches, venvs, node_modules
├─ .github/workflows/ci.yml
├─ docs/
│  ├─ adr/                 # decision records
│  └─ benchmarks.md        # speed and VRAM per model on the 5070 Ti
├─ engine/
│  ├─ pyproject.toml       # uv project, PyTorch index pin
│  ├─ src/openstems/
│  │  ├─ domain/           # Track, Model, Pass, Recipe, Job, Stem (no torch)
│  │  ├─ catalog/          # models.toml, loader, downloader, verify
│  │  ├─ recipes/          # built-in recipe TOML files
│  │  ├─ audio/            # decode, write, resample, peaks
│  │  ├─ engines/          # Engine port, adapters, shared chunked runner
│  │  ├─ pipeline/         # runs a recipe: passes, derived stems, manifest
│  │  ├─ worker/           # GPU worker process, queue, cancel
│  │  ├─ api/              # FastAPI app, routes, events, schemas
│  │  ├─ settings.py
│  │  └─ cli.py            # doctor, models, separate, serve
│  └─ tests/               # unit, pipeline with FakeEngine, gpu-marked
├─ app/
│  ├─ package.json
│  ├─ electron/            # main process, preload
│  ├─ src/                 # React UI
│  └─ e2e/                 # Playwright
└─ scripts/                # dev start, benchmarks
```

Dependencies point inward: `domain` imports nothing from the other packages, and `cli` and `api` are the only entry points.

## Build phases

Run the phases in order. Every acceptance check is a command or an observable result; tick it in `PLAN.md` when it passes.

### Phase 0: bootstrap

Goal: an empty but working repo on GitHub, with the GPU confirmed.

- Create `OpenStems/` with the layout above, run `git init`, and add the root files. Save this plan as `PLAN.md`.
- Set up `engine/` with uv and Python 3.12, PyTorch pinned to the cu130 index, plus ruff, pyright and pytest.
- Write `openstems doctor`. It prints the Python, PyTorch and CUDA versions, the GPU name and VRAM, and whether FFmpeg decoding works. It exits non-zero without CUDA.
- Add CI on GitHub Actions with a Windows runner: lint, type-check and unit tests on CPU, with no model downloads.
- Record the verified stack versions in `docs/adr/0001-stack.md`.
- Create the private remote and push.

Acceptance:

- [x] `uv run openstems doctor` reports CUDA available on the RTX 5070 Ti.
- [x] `uv run ruff check`, `uv run pyright` and `uv run pytest` pass locally and in CI.
- [x] `gh repo view OpenStems --json visibility` returns `PRIVATE`.

### Phase 1: core engine and CLI

Goal: one recipe works end to end from the terminal, with no UI.

- Build the domain package and its unit tests first.
- Add the catalog with two models, SW and Leap Xe vocals, and a downloader with resume, sha256 verification and progress. Commands: `openstems models list`, `pull` and `verify`.
- Decode any input to 44.1 kHz stereo float32. Write WAV 32-bit float stems and a peaks file per stem.
- Run a half-day spike to choose the Engine adapter. It must load SW and Leap Xe on the 5070 Ti, allow chunk-level progress and cancel, and match the library's own output.
- Port the shared chunked runner: overlap-add windows, batching, autocast, test-time augmentation, a cancel token, a progress callback, and batch-size backoff on out-of-memory errors.
- Build the pipeline: passes, input wiring, derived stems, sum-to-mix, the manifest and the cache key.
- Add `openstems separate <files> --recipe full-song --quality balanced --out <dir>`.
- Add a FakeEngine for tests, so the pipeline and later the API run without a GPU.

Acceptance:

- [x] `openstems separate song.mp3 --recipe full-song` writes six stems and a manifest on the GPU, with live progress.
- [x] Every stem has exactly the decoded source's sample count.
- [x] With sum-to-mix on, the stems sum to the mix within -60 dB.
- [x] Null test: at the same chunk and overlap settings, the runner's output differs from the library's own by less than -40 dB.
- [x] Ctrl+C stops within about two seconds and leaves no partial files.
- [x] Running the same command again returns from the cache.
- [x] `docs/benchmarks.md` lists run time and peak VRAM for both models.

### Phase 2: catalog, recipes and quality presets

Goal: every use case in the Recipes table runs from the CLI.

- Fill the catalog from the Model catalog table, with URL, sha256, size and license per file. Add `openstems models pull --set seed` and a liveness check.
- Add the Mel-Band and MDX23C adapters behind the same Engine port.
- Add every recipe in the Recipes table as TOML, including chained inputs and derived stems.
- Define the Fast, Balanced and Best presets per architecture, and measure each on the 5070 Ti.
- Add ensemble passes: average several models' outputs for one stem, starting with a plain waveform average.
- Add custom model import: a local checkpoint, its YAML config and a declared architecture, behind a pickle warning.
- Compare both wirings of `full-song-best-vocals` by ear on three songs, and record the choice as a decision record.

Acceptance:

- [x] Each recipe completes on a test song and passes the alignment check.
- [x] `drum-kit` writes kick, snare, toms, hh, ride and crash.
- [x] `melody` equals other + guitar + piano, sample for sample.
- [x] `openstems models verify` passes for every installed model.
- [x] `docs/benchmarks.md` covers every model and preset.

### Phase 3: local API and job queue

Goal: everything the CLI does is available over a local API with live progress.

- Build the FastAPI app. Bind to 127.0.0.1 on a random port and require a bearer token.
- Run one GPU worker process fed by a queue. Keep the last model loaded, evict by VRAM budget, and restart the worker if it dies.
- Add endpoints for tracks (register paths, probe metadata), jobs (create, batch, cancel, retry, reorder), recipes, models (list, pull, delete, verify), settings and files (range requests for audio, JSON for peaks).
- Stream job and download progress over one WebSocket.
- Index tracks, jobs and stem sets in SQLite, rebuildable by scanning manifests.
- Export `openapi.json` and generate the TypeScript client into `app/`.
- Add `openstems serve`.

Acceptance:

- [x] A batch of five files runs through the API with ordered progress events.
- [x] Cancelling a running job frees the GPU for the next job.
- [x] Killing the worker mid-job leaves the API up, marks the job failed and restarts the worker.
- [x] Requests without the token are rejected.
- [x] API tests pass in CI using the FakeEngine.

### Phase 4: desktop app

Goal: drop files in, watch the queue, and drag stems out into the DAW.

- Scaffold `app/` with Electron, React, TypeScript and Vite. Turn on context isolation and the sandbox, keep Node integration off, and expose a small typed preload API.
- On launch, the main process starts `openstems serve`, waits for its health check, and hands the port and token to the UI. On quit it stops the engine. Allow one app instance.
- Drag-in: accept files and folders anywhere in the window, and resolve real paths in the preload with `webUtils.getPathForFile`.
- Drag-out: each stem row and an all-stems handle call `webContents.startDrag` through IPC with the file paths and an icon.
- Queue view: jobs with progress, cancel, retry and reorder.
- Recipe picker: recipes by use case, a single-model option and the quality preset.
- Results view: a waveform per stem from the peaks files, solo and mute, and playback that starts all stems together through Web Audio. Add Reveal in Explorer.
- Models view: installed and available models, size, license, download progress and delete.
- Settings: output folder, models folder, output format and naming template.
- Tests: component tests, plus Playwright end-to-end runs against the FakeEngine.

Acceptance:

- [x] Dropping an MP3, a FLAC and an MP4 together produces three finished jobs.
- [x] Dragging one stem, then all stems, onto the FL Studio Playlist and into Explorer works.
    Confirmed by hand by Lewis on 2026-11-20. The tests cover the file paths that reach
    `startDrag`; a native drag cannot be automated.
- [x] Paths with spaces and non-ASCII characters work end to end.
- [x] Quitting the app leaves no engine process running.
- [x] The end-to-end suite passes in CI.

### Phase 5: producer features

Goal: the extras that save time in a session. Build them in this order; stopping after any one is fine.

- Tempo and key detection, available as `{bpm}` and `{key}` tokens in the naming template.
- Output options: WAV 24-bit, FLAC, MP3, and match the source sample rate.
- History: search past tracks, rerun a track with another recipe, and re-drag old stems.
- A watch folder that queues new files with a default recipe.
- Stem to MIDI for melody, bass and vocal stems, written as a draggable `.mid` file.
- Optional per-stem silence trim and normalization, both off by default.

Acceptance:

- [x] Each shipped feature has tests and a line in the README.
- [x] The defaults still produce the Product scope output contract.

### Phase 6: packaging

Goal: install and run without a terminal.

- Build a Windows installer for the app.
- On first run, create the Python environment with uv, run the doctor check, and offer to download the seed models. (Widened into a welcome of three steps: folders, format, models. ADR 0021.)
- Add an app icon, a Start menu entry, a logs folder and an Export diagnostics action.

Acceptance:

- [x] On a fresh Windows user account, going from install to the first separation needs no terminal.
    Checked two ways on 2026-11-20, both driven through the app window only
    (`app/e2e/packaged.spec.ts`): the packaged app on an empty profile, and the installer run
    for real on this account, where the installed app set up its environment and finished a
    separation. A second Windows account was not created.
- [x] Uninstalling leaves the models folder and the outputs untouched.
    Checked on 2026-11-20: after the uninstall the app folder, `engine-env`, the Start menu
    shortcut and the registry entry were gone; all 51 model files (9.28 GB) and the settings
    file were byte-for-byte the same, and no output file was removed.

### Phase 7: stem to MIDI

Goal: MIDI from every kind of stem that beats Melodyne's export of the same stem, with
per-note pitch curves, drum parts on their own notes and a confidence on every note. The
design does not copy Melodyne's method. The research and the full plan are in
`docs/research/stem-to-midi.md`. Its stages, M0 to M7, are this phase's steps, each its own
pull request.

- M0: a benchmark. CC BY multitracks go through the app's own separators and are scored with
  mir_eval, with Melodyne's and NeuralNote's MIDI of the same stems as baselines. Plus test MIDI
  files for FL Studio, Logic and Live.
- M1: a note file beside each stem, and a MIDI writer for plain notes, pitch bends and MPE.
- M2: drums from the drum-kit parts.
- M3: monophonic stems (vocals, bass, lead lines), with a pitch curve per note.
- M4: polyphonic stems (piano, guitar, keys, other), with bleed and ghost-note filtering.
- M5: confidence and a note editor.
- M6 and M7: training on separator output, and research bets.

Acceptance:

- [ ] M0's report is in `docs/benchmarks.md`: the app, Melodyne and NeuralNote scored on the
      same separated stems.
- [ ] For each stem class, the app's note F1 is at or above Melodyne's on that benchmark, or
      the gap is recorded with its cause.
- [ ] Drum parts, per-note pitch curves and per-note confidence are written and measured.
- [ ] Every default model may be redistributed, with its training data and attribution shown
      in the catalog.
- [ ] The MIDI files open in FL Studio, Logic and Live as the test files showed they would.
- [ ] Windows and Mac pass alike (ground rule 9).

## Open decisions

Every decision has a default, so the build never blocks. Change any of them before the phase named.

| Decision | Default | Alternative | Settle by |
| --- | --- | --- | --- |
| What melody separation means | Everything that is not vocals, drums or bass as one stem, plus guitar and piano | Lead-instrument isolation with the 53-stem model, or MIDI extraction | Phase 2 |
| Desktop shell | Electron | Tauri 2 | Phase 4 |
| Engine adapter | OpenMIRLab loaders plus the shared runner | splifft, or python-audio-separator | Phase 1 spike |
| Full-song wiring | SW runs on the mix | SW runs on the Leap Xe instrumental | Phase 2, by ear |
| Output default | WAV 32-bit float at 44.1 kHz | 24-bit, or match the source rate | Phase 1 |
| Review flow | One pull request per phase | Commit straight to `main` | Phase 0 |
| Packaging | Installer in Phase 6 | Stay on a dev start script | Phase 6 |
| Cloud-only models | Not supported | An optional MVSEP adapter behind the Engine port, after checking its API terms | After Phase 5 |
| Apple Developer ID for the Mac build (the owner's to make) | Not bought: the Mac build is unsigned, macOS asks before the first open, and updates are manual | Buy a Developer ID (Apple Developer Program) and set the signing secrets, so the app is signed, notarized and updates itself (`docs/adr/0014-macos.md`) | Before the first release with a Mac build |
| Recipes on a small machine (the owner's to make) | The built-in recipes name fixed models. On an 8 GB Mac `full-song` is tight and the Leap Xe recipes are marked as not fitting; lighter models are offered for download and run as single models | Light variants of the recipes, or recipes that pick a lighter model by fit (`docs/adr/0015-low-memory.md`) | Before the first release with a Mac build |
| Who tests on a Mac (the owner's to make) | The owner, on an M1 Max with 32 GB (first run 2026-11-23). Smaller Macs wait for user reports | The owner or a named tester runs the doctor, the self-test and a separation on an Apple Silicon Mac | Before the label is dropped |
| Training data behind shipped transcription weights | Decided by the owner on 2026-11-23. Weights under a permissive license are allowed even when trained partly on restricted data ("tier B"), with the training data and attribution shown with the model | Only weights trained entirely on openly licensed data ("tier A") | Settled |
| GPL transcription code (YourMT3+) | Not in the app. Measured locally in M0 as a reference only | A separately installed optional component, or asking the author to relicense the inference code (the weights are already Apache-2.0) | Phase 7, M4, after M0's numbers |
| MIDI pitch format | Plain notes by default. Pitch bends at +/-2 for monophonic stems and MPE as options | MPE by default | Phase 7, M1, after the FL Studio test files |

## Kickoff prompt

Export this doc as Markdown (click the doc's name, then Export), save it as `PLAN.md` in the Dev folder, start Claude Code there, and paste this:

```
Read PLAN.md in this folder. It is the spec for a new repo called OpenStems.

Follow its Ground rules. Do Phase 0 only:
1. Confirm this is my Dev folder, then create OpenStems/ here and move PLAN.md into it.
2. Before writing code, check the current docs for every library the plan names. List anything the plan gets wrong and record your fixes in docs/adr/0001-stack.md.
3. Bootstrap the repo, run the doctor check on the GPU, create the private GitHub repo OpenStems, and push.
4. Tick the Phase 0 acceptance boxes in PLAN.md, then stop and summarize what you did and what you changed from the plan.

Do not start Phase 1 until I say so.
```

For each later phase, paste: `Do Phase N from PLAN.md. Open a pull request when its acceptance checks pass, then stop.`

## Sources

All pages were checked on 2026-11-20.

- [bs-roformer-infer](https://github.com/openmirlab/bs-roformer-infer): registry, SW mirror and hash, 53-stem model, loader API.
- [melband-roformer-infer](https://github.com/openmirlab/melband-roformer-infer): registry, usable-model count, loader API.
- [mdxnet-infer](https://github.com/openmirlab/mdxnet-infer): DrumSep mirror, the lost 5-stem checkpoint, weights license note.
- [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator): architectures, ensembling, no documented progress hook.
- [MSST](https://github.com/ZFTurbo/Music-Source-Separation-Training) and its [pretrained models list](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md): model types, public checkpoints, MIT license.
- [splifft](https://github.com/undef13/splifft): supported model families, pre-alpha status.
- [MVSEP DrumSep](https://mvsep.com/algorithms/29): MVSEP-only drum models and their scores.
- [MVSEP Multisong leaderboard](https://mvsep.com/quality_checker/multisong_leaderboard?sort=vocals): the Leap Xe vocal score.
- [PyTorch 2.13 final RC post](https://dev-discuss.pytorch.org/t/pytorch-2-13-final-rc-available/3410): cu126, cu130 and cu132 wheels.
- [PyTorch forums](https://discuss.pytorch.org/t/how-do-i-use-pytorch-with-rtx-5060-ti/220926/14): CUDA 12.8 or newer for 50-series cards.
- [uv PyTorch guide](https://docs.astral.sh/uv/guides/integration/pytorch/): explicit index configuration.
- [Electron releases](https://releases.electronjs.org/), [native file drag and drop](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop) and the [File object page](https://electronjs.org/pt/docs/latest/api/file-object): current stable line, `startDrag` and `getPathForFile`.
- [drag-rs](https://docs.crabnebula.dev/plugins/drag-rs/): the Tauri drag-out plugin.
- Not checked against a source, so confirm in Phase 0: PyAV bundling FFmpeg, Playwright driving Electron, the multi-file form of `startDrag`, and MVSEP's API terms.
