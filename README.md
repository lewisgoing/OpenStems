# OpenStems

Local Windows app for stem separation: drop audio files in, pick a recipe or model, and drag
DAW-ready stems out. Everything runs on the local GPU; there is no cloud step. A build for
Apple Silicon Macs exists as a preview that has not yet been run on a Mac: see [macOS](#macos).

Three layers: a Python engine (domain model, model catalog, GPU worker), a local HTTP API, and an
Electron + React desktop shell. See [`PLAN.md`](PLAN.md) for the full spec and build phases.

## Status

- [x] Phase 0: bootstrap (repo, engine project, `doctor`, CI)
- [x] Phase 1: core engine and CLI (`full-song` end to end from the terminal)
- [x] Phase 2: catalog, recipes and quality presets (17 models, 11 recipes)
- [x] Phase 3: local API and job queue (FastAPI, one GPU worker, WebSocket events)
- [x] Phase 4: desktop app (drop in, queue, preview, drag out into the DAW)
- [x] Phase 5: producer features (tempo and key, formats, history, watch folder, MIDI, trim)
- [x] Phase 6: packaging (installer, first-run setup, logs, diagnostics)

## Requirements

- Windows with an NVIDIA GPU (built and tested on an RTX 5070 Ti, 16 GB). The GTX 16 and RTX
  20 series and later use the standard build. The GTX 900 and 10 series get a build of their
  own, as an untested preview: [`docs/adr/0012-older-nvidia.md`](docs/adr/0012-older-nvidia.md)
- Or, as an untested preview, an AMD Radeon that AMD's PyTorch for Windows supports: RX 9070,
  RX 9070 XT, RX 9060 XT, RX 7900 XTX, RX 7700, PRO W7900 or AI PRO R9700, with AMD driver
  26.2.2 or newer. See [AMD Radeon](#amd-radeon).
- Or, as a preview that has not been run on a Mac by us, a Mac with Apple Silicon (M1 or
  later) and macOS 14 or later. Intel Macs are not supported. See [macOS](#macos).
- [uv](https://docs.astral.sh/uv/)
- Node 22 and pnpm for the app

## Install

Download `OpenStems-Setup-<version>.exe` from the
[latest release](https://github.com/lewisgoing/OpenStems/releases/latest), or build it
yourself: `cd app && pnpm install && pnpm dist` writes it to `app/release/`. The installer is
not code-signed, so Windows SmartScreen asks once ("More info", then "Run anyway").

The installer needs no administrator rights and adds a Start menu entry. On first launch the
app looks at the graphics card, sets up its Python environment for it (it downloads Python and
PyTorch, about 3 GB, into your user profile), checks the GPU, and offers to download the
recommended models (3.4 GB). After that, drop a file on the window.

Uninstalling removes the app and that Python environment. Your models, outputs and settings
stay where they are. Logs are in `%LOCALAPPDATA%\OpenStems\logs`, and Settings has an Export
diagnostics button.

**Coming from lew-stems?** OpenStems was called lew-stems before version 0.2.0. Install
OpenStems and start it: your settings, models, outputs and recipes are picked up where they
are. Then uninstall lew-stems from Windows Settings, which also removes its old Python
environment (several GB). Details: [`docs/adr/0009-rename-openstems.md`](docs/adr/0009-rename-openstems.md).

## macOS

Mac support is a preview. It was written and unit-tested on Windows, and **nobody on the
project has run it on a Mac yet**: not a separation, not the installer, not the menu bar item.
[`docs/adr/0014-macos.md`](docs/adr/0014-macos.md) lists what was checked and what is unproven.
Reports from a Mac are welcome.

**What it needs.** A Mac with Apple Silicon (M1 or later) and macOS 14 or later. The models
run on the Apple GPU through PyTorch's MPS backend. PyTorch has no build for Intel Macs, so
the app refuses to set up on one.

**Getting it.** A release that includes a Mac build carries `OpenStems-<version>-arm64.dmg`
on the [releases page](https://github.com/lewisgoing/OpenStems/releases/latest). Or build it
on a Mac, with uv, git, Node 22 and pnpm installed: `cd app && pnpm install && pnpm dist:mac`
writes the dmg to `app/release/`. Open the dmg and drag OpenStems to Applications.

**Opening it the first time.** The app is not signed with an Apple Developer ID and not
notarized (its signature is ad hoc, which names nobody), so macOS will not open it on a
double click.

1. Double-click OpenStems. macOS says it could not verify the app. Click Done.
2. Open the Apple menu > System Settings, and click Privacy & Security in the sidebar.
3. Scroll down to Security. OpenStems is named there as blocked: click Open Anyway. The
   button is there for about an hour after step 1.
4. Confirm in the warning that follows, and enter your login password if macOS asks.

macOS remembers this, and the app opens normally from then on. These are Apple's steps for
[an app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

If macOS says instead that OpenStems "is damaged and can't be opened", the app is not broken:
that is how macOS can report an app with no Developer ID that came through a browser. Move it to
Applications, then remove the download mark in Terminal and open it again:

```
xattr -dr com.apple.quarantine /Applications/OpenStems.app
```

Which of the two a download meets has not been tried. Only do either for a copy you got from
this repository's releases or built yourself.

**First launch.** As on Windows, the app sets up its Python environment (about 350 MB, since
PyTorch for the Mac is much smaller), checks the GPU, and offers the recommended models.
There is one engine build on a Mac and nothing to choose.

**What is different on a Mac**

- OpenStems sits in the menu bar, not in a tray. Click the item for the quick-drop window,
  which opens under the menu bar. Right-click or Control-click it for the menu.
- Closing the window never quits: the app stays in the Dock and the menu bar. Quit with Cmd+Q.
  Settings is also in the OpenStems menu (Cmd+comma).
- Shortcuts use Cmd where this page says Ctrl: Cmd+V pastes a link, Cmd+1 to Cmd+4 switch
  views, Cmd+Enter starts the queue.
- Settings has "Menu bar" where Windows has "Tray", with "Open at login" in place of "Start
  with Windows" and no "Keep running in the tray" switch.
- Every model runs at full precision. On NVIDIA cards most run at half precision, so expect a
  Mac to be slower and to use more memory than the figures in `docs/benchmarks.md`. No Mac
  figures exist yet.
- The GPU shares the Mac's memory with everything else. The engine keeps at most half of it
  for loaded models.
- **Notifications** are the system's. macOS shows them only for an app with a valid
  signature, which is one reason the build is signed ad hoc. Not yet seen on a Mac.
- **Updates are manual while the app has no Developer ID.** The app says when a new version is out,
  and its button ("Get 0.3.0") opens the release page; download the new dmg and replace the
  app.
- Folders: settings, models and the Python environment are in
  `~/Library/Application Support/OpenStems`, logs in `~/Library/Logs/OpenStems`, and stems in
  `~/Music/OpenStems`. The window's own small preferences are in
  `~/Library/Application Support/openstems-app`.
- **Removing it.** Drag the app to the Trash. That leaves the Python environment behind:
  delete `~/Library/Application Support/OpenStems/engine-env` to remove it. The same folder
  holds your settings and downloaded models, should you want those gone too, and
  `~/Library/Application Support/openstems-app` holds the window's preferences.

**Checking a Mac.** `doctor` says whether the Apple GPU is usable, `selftest --ops-only`
compares each kind of operation on the GPU and the CPU in a few seconds, and `selftest -m`
separates a short test signal with one model on both and says how far apart they are:

```
ENGINE="$HOME/Library/Application Support/OpenStems/engine-env/bin/openstems"
"$ENGINE" doctor
"$ENGINE" selftest --ops-only
"$ENGINE" selftest -m bs-roformer-sw
```

In the app the same is Settings > System > GPU self-test > Run, and Export diagnostics
includes the result. If the GPU gives trouble, turn off "Use the GPU" there to run on the CPU.

To develop on a Mac: `uv sync --no-default-groups --group mps --group dev` in `engine/`, then
`uv run --no-sync ...` (a plain `uv run` would try to install the NVIDIA build).

## AMD Radeon

AMD support is a preview: it is built and checked as far as that is possible without a Radeon
card, and nobody has run a separation on one yet. `docs/adr/0007-amd-rocm.md` lists what was
checked and what is unknown.

- First-run setup picks AMD's PyTorch build (ROCm 7.2.1) when it finds a supported Radeon and no
  NVIDIA card. The setup screen says what it found and lets you choose the other build.
- An unsupported Radeon (RX 6000 and older, integrated graphics) gets the standard build and
  runs on the CPU, slowly.
- Settings > System shows the build in use, can switch it, and has a "Use the GPU" switch that
  falls back to the CPU if the card misbehaves.
- To report how a Radeon does: Settings > System > GPU self-test > Run, then Export
  diagnostics, which includes the result. The self-test runs every kind of operation the models
  use, then one short separation per model architecture, on the GPU and on the CPU, and says
  how far apart they are. The same from a terminal, with more detail:

```
"%LOCALAPPDATA%\OpenStems\engine-env\Scripts\openstems.exe" selftest
```

To develop against the AMD build: `uv sync --no-default-groups --group rocm --group dev`.

## Engine quick start

```
cd engine
uv sync
uv run openstems doctor
```

`doctor` prints the Python and PyTorch versions, the GPU backend (CUDA, ROCm, or MPS on a Mac),
the GPU name and VRAM, and whether FFmpeg decoding works. It exits non-zero without a working
GPU.

## Separating from the terminal

```
uv run openstems models pull bs-roformer-sw
uv run openstems separate "song.mp3" --recipe full-song --quality balanced --out D:\stems
```

- `models list | pull | verify`: the catalog, downloads with resume and sha256 verification,
  and a full re-hash of what is installed.
- `separate <files or folders>`: `--recipe` or `--model` (a single model), `--quality fast |
  balanced | best`, `--out`, `--sum-to-mix`, `--format`, `--stems`, `--force`.
- `recipes list`, `config show`, `config set <key> <value>`.

Recipes (`openstems recipes list`):

| Recipe | Stems |
| --- | --- |
| `full-song` | vocals, drums, bass, guitar, piano, other |
| `full-song-best-vocals` | the same, with vocals from Leap Xe |
| `vocals-instrumental` | vocals, instrumental |
| `acapella-clean` | dry vocals, lead, backing |
| `drum-kit` | kick, snare, toms, hh, ride, crash, drums |
| `melody` | melody, guitar, piano, other |
| `drumless` | drumless |
| `cleanup-dereverb`, `cleanup-denoise` | one cleaned file |
| `mega-53` (experimental) | the stems you name with `--stems` |

`openstems models pull --set seed` downloads the seven models these need (3.4 GB);
`--set all` fetches all 17. `models check` tests that every catalog URL is still live, and
`models import CHECKPOINT --config CONFIG --arch ARCH` adds a checkpoint of your own. Your own
recipes are TOML files in `%APPDATA%\OpenStems\recipes`; see the built-in ones in
`engine/src/openstems/recipes/`.

Output: `{out}/{track}/{recipe}/{track} - {stem}.wav` plus `manifest.json`. Stems are WAV 32-bit
float at 44.1 kHz with exactly the source's length, so they line up at bar 1. Nothing is
normalized. `--sum-to-mix` folds the residual into `other` so the stems sum back to the mix.
Running the same command again returns from the cache. Ctrl+C stops within a chunk and leaves no
partial files.

Settings live in `%APPDATA%\OpenStems\settings.json`; `OPENSTEMS_MODELS_DIR`,
`OPENSTEMS_OUTPUT_DIR` and `OPENSTEMS_CACHE_DIR` override the folders. Speed and VRAM per model
are in [`docs/benchmarks.md`](docs/benchmarks.md).

## Desktop app

```
cd app
pnpm install
pnpm dev          # starts Electron and the engine (uv run openstems serve)
```

- Drop files or folders anywhere in the window, or use Add files. They run with the recipe and
  quality shown in the toolbar. If a recipe needs a model that is not installed, the app offers
  to download it and queues your files when it is ready.
- Paste a link to a song (Ctrl+V, or Paste link), or drag one in from a browser. OpenStems
  fetches the audio from YouTube, SoundCloud, Bandcamp and many other sites and queues it like
  a file. Fetch only what you have the right to use.
- The queue shows per-job progress. Cancel, retry, remove, and drag queued jobs to reorder.
- Click a finished job for its stems: a waveform per stem, solo (Ctrl+click adds), mute, and
  playback that starts every stem together. Space plays and pauses.
- Drag one stem, or "Drag all", straight into your DAW or a folder. Reveal in Explorer opens the
  folder.
- Mute or solo stems and a "Drag mix" handle appears: what you hear leaves as one file, such as
  the song without its vocals.
- History lists past separations: search, drag the stems again, or run the same track through
  another recipe. Models shows what is installed, sizes and licenses, with download and delete.
  Settings holds the output and models folders, the output format and the naming template.
- Ctrl+1 to Ctrl+4 switch between Queue, History, Models and Settings.

Tests: `pnpm typecheck`, `pnpm test` (components), `pnpm build && pnpm e2e` (Playwright driving
Electron against the FakeEngine). After an API change run `uv run openstems openapi --out
openapi.json` in `engine/` and `pnpm gen:api` here.

## In the tray

OpenStems keeps an icon in the notification area, by the clock. On a Mac it is an item in the
menu bar, and a few things below differ: see [macOS](#macos).

- **Pick the format** (WAV, FLAC or MP3) next to the quality, in either window.
- **Songs wait for Start.** What you drop is queued; press Start (or Ctrl+Enter) to run it.
  Settings > Queue can make songs start by themselves instead.
- **Click the icon** for the quick-drop window: a small window against the taskbar. Drop a
  song on it, and its stems come back as pills you drag straight into your DAW. It uses the
  same recipe, quality and queue as the full window, and stays open while you work in other
  windows. Click the icon again, press Escape or use its close button to put it away.
- **Click a stem to hear it** before you drag it; click again to stop.
- **Paste a link** with Ctrl+V or the link button, and the song is fetched and queued.
- **Mix** turns the stems into a mix: click a stem to leave it out, play the rest together,
  and drag the result out as one file.
- **A notification** tells you when songs finished while you were looking elsewhere.
- **The icon tells you what is going on**: a ring while a song is being separated, a dot when
  stems finished while you were looking elsewhere. Hover for the track name and progress.
- **Right-click** for Quick drop, Show OpenStems and Quit. A double click opens the full app.
- **Closing the window leaves the app in the tray**, with the engine ready for the next drop.
  Quit from the icon's menu. Settings > Tray turns this off, and can start the app with
  Windows, in the tray. After ten minutes without a job the engine frees its graphics memory.

The decisions behind it are in [`docs/adr/0008-tray.md`](docs/adr/0008-tray.md).

## Updates

An installed OpenStems updates itself. When a newer version is out, an **Update** button
appears in the title bar and in the quick-drop window. One click downloads the new version; a
second click restarts into it. Nothing is downloaded until you click, and a restart asks first
while jobs are running. Settings > Updates can check on request and can turn the automatic
check off. After an update the app brings its Python environment up to date by itself, in a
few seconds.

On a Mac this needs an app signed with an Apple Developer ID. The Mac build has none yet,
so there the button opens the release page and you install the new version yourself.

How a release is published: [`docs/adr/0010-self-update.md`](docs/adr/0010-self-update.md).

## Producer features

- **Tempo and key.** Each track's BPM and key are detected and shown with its stems, and are
  available as `{bpm}` and `{key}` in the naming template, for example `{track} {bpm}bpm {key} -
  {stem}`.
- **Output options.** WAV 32-bit float (default), WAV 24-bit, FLAC or MP3, and "match the source
  sample rate" to get 48 kHz stems from a 48 kHz file (`--format`, `--match-source-rate`).
- **Songs from links.** yt-dlp fetches the audio behind a pasted link. Sites change, so a
  fetch that stops working usually needs a newer OpenStems
  ([`docs/adr/0013-links-and-mixes.md`](docs/adr/0013-links-and-mixes.md)).
- **Mixes.** Any choice of a song's stems as one file, in a `Mixes` folder beside the stems.
- **History.** Search past tracks, drag their stems again, or run a track through another
  recipe.
- **Watch folder.** New files that appear in a folder are queued with the default recipe and
  quality once they have finished copying.
- **Stem to MIDI.** A draggable `.mid` next to vocal, bass and melody stems (`--midi
  vocals,bass`, or "Write MIDI" in Settings). It tracks one note at a time, so it suits single
  lines, not chords.
- **Trim silence and normalize**, per stem (`--trim-silence`, `--normalize`). Both are off by
  default, because trimmed stems no longer line up at bar 1 and normalized stems no longer sit at
  their level in the mix.

## Local API

`uv run openstems serve` starts the API on 127.0.0.1 with a random port and a bearer token, and
prints one JSON line with both. Everything the CLI does is there, with live progress:

| Area | Routes |
| --- | --- |
| Jobs | `POST /v1/jobs`, `POST /v1/jobs/batch`, `GET /v1/jobs`, `POST /v1/jobs/{id}/cancel`, `.../retry`, `POST /v1/jobs/reorder`, `DELETE /v1/jobs/{id}`, `POST /v1/jobs/clear-finished` |
| Tracks and recipes | `POST /v1/tracks` (register paths, probe metadata), `GET /v1/recipes` |
| Links and mixes | `POST /v1/links` (fetch a song from a web address, then queue it), `GET /v1/links`, `POST /v1/links/{id}/retry`, `DELETE /v1/links/{id}`, `POST /v1/mixes` (some stems as one file) |
| Models | `GET /v1/models`, `POST /v1/models/{id}/pull`, `.../cancel`, `.../verify`, `DELETE /v1/models/{id}`, `POST /v1/models/import` |
| Settings and system | `GET` and `PATCH /v1/settings`, `GET /v1/system`, `GET /v1/health`, `POST /v1/diagnostics` |
| Files and history | `GET /v1/files?path=` (range requests), `GET /v1/peaks?path=`, `GET /v1/stemsets?q=`, `POST /v1/stemsets/rebuild` |
| Events | `WS /v1/events`: job and download progress, in order |

One GPU worker process runs the queue, keeps the last model warm, and is restarted if it dies.
Requests without the token get a 401. `uv run openstems openapi --out openapi.json` exports the
schema that the app's TypeScript client is generated from.

## Development

```
cd engine
uv run ruff check
uv run pyright
uv run pytest                 # CPU only, uses the FakeEngine
uv run pytest -m gpu          # needs the GPU and downloaded models
uv run python ../scripts/null_test.py SONG      # runner vs the loader library
uv run python ../scripts/benchmark.py SONG      # run time and peak VRAM
uv run python ../scripts/check_stems.py FOLDER  # alignment and sum-to-mix
uv run python ../scripts/accept_recipes.py SONG # every recipe, with alignment checks
uv run python ../scripts/accept_api.py F1 F2 F3 F4 F5  # the API on the real GPU
uv run python ../scripts/compare_wirings.py MUSDB   # score both full-song wirings (SDR)
uv run python ../scripts/gen_catalog.py --write # rebuild models.toml from the loaders
```

## License

The code is under the [MIT License](LICENSE).

The models are not part of this repository and are not covered by that license. The app
downloads them from their authors at run time, and each has its own terms; some authors state
none. The Models view shows what is known for each one. Check a model's terms before using its
stems commercially.
