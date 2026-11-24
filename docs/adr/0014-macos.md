# 0014: macOS on Apple Silicon

Date: 2026-11-23. Status: accepted as a preview. **Not yet run on a Mac by us.**

This deviates from the plan, which lists macOS builds as a non-goal and targets one machine:
Windows with an NVIDIA RTX 5070 Ti.

## Decision

OpenStems gets a Mac build for Apple Silicon (arm64) and macOS 14 or later. The models run on
the Apple GPU through PyTorch's MPS backend, at full precision. The app keeps the same three
layers and the same code: what differs sits in a few named places (see "Where the difference
lives").

The development machine is Windows, and nothing here was run on a Mac. Every Mac branch was
written by reading the code and the documentation. Every Mac decision is a plain function
covered by unit tests that run on Windows with the platform passed in or patched; the glue
that carries those decisions to Electron and the system is only read ("Read, not tested"
below). Windows behaviour is unchanged: the same paths, the same commands, the same package. "Run on a Mac" and "Still unproven on a Mac" below say what is
unproven, and "For whoever tests on a Mac" says how to find out.

## The decisions and why

- **Apple Silicon only.** PyTorch publishes no wheels for Intel Macs any more, so there is
  nothing to install on one. Setup refuses on an Intel Mac and says why
  (`variant.unsupportedReason`), and the doctor says the same.
- **macOS 14 or later.** The PyTorch 2.14.1 wheel on PyPI is `macosx_14_0_arm64`. The app
  declares the same minimum (`minimumSystemVersion` in `app/package.json`).
- **The device is "mps", at full precision.** Half precision is a speed-up that was measured
  on CUDA only, and autocast stays CUDA-only (`runner.use_half_precision`). On a Mac every
  preset runs in fp32.
- **A fourth build, `mps`.** `engine/pyproject.toml` gains a dependency group `mps`:
  `torch==2.14.1` from PyPI, in conflict with `cuda`, `cu126` and `rocm`. It is the same
  PyTorch version as the two NVIDIA builds, so the loaders and every other pin are the same.
  The packaged pin set is `requirements-mps.txt`. On a Mac it is the only build: nothing is
  detected and nothing is chosen. On Windows it is never offered, and the three exported
  Windows pin sets are unchanged.
- **No Developer ID by default.** There is no Apple Developer ID yet (an open decision in
  `PLAN.md`). Signing with one, and notarization, are wired to electron-builder's standard
  environment variables and happen only when those are set. Without them the app is signed
  ad hoc, which names nobody. See "Signing".
- **A manual update without a Developer ID.** macOS installs an update only into an app
  signed with a Developer ID. A build without one therefore says a new version exists and
  opens the release page. ADR 0010 has the details.

## The loaders dropped MPS; OpenStems does not use that part

The pinned OpenMIRLab loaders removed their own MPS support on 2026-09-14. Their inference
entry points refuse the device: `bs_roformer/inference.py` says `device="mps"` always raises
("MLX/MPS support was removed org-wide, 2026-09-14"), and `mdxnet_infer/inference.py` raises a
`ValueError` for it.

OpenStems never calls those entry points. As ADR 0002 records, it takes only the model
classes from the loaders and runs them with its own runner (`engines/runner.py`), so the
refusal is not in its path. It does mean that upstream no longer tests these models on MPS,
and that `scripts/null_test.py`, which compares the runner with the loaders' own `demix_track`,
has no MPS reference to compare with.

## Engine

- **One place for what differs** (`engines/device.py`): which GPU device there is, freeing
  cached memory, waiting for the GPU, reading memory in use, and recognising an out-of-memory
  error. NVIDIA and AMD answer through `torch.cuda`; a Mac answers through `torch.mps`. The
  runner, the model host and the self-test ask there instead of calling `torch.cuda`.
  `torch_common.pick_device` returns `mps` when the GPU is allowed, CUDA is absent and MPS is
  available.
- **Out of memory.** MPS raises a plain `RuntimeError`: "MPS backend out of memory (...)", or
  "Invalid buffer size: ..." when one buffer is larger than Metal allows. The wording was read
  from `aten/src/ATen/mps/MPSAllocator.mm` at PyTorch v2.14.1. Both now halve the batch, as a
  CUDA out-of-memory error does.
- **`PYTORCH_ENABLE_MPS_FALLBACK=1`** is set in `openstems/__init__.py` on a Mac only, with
  `setdefault`, before PyTorch is imported. An operation the Apple GPU lacks then runs on the
  CPU instead of failing the job.
- **The STFT safety net** (`engines/stft_fallback.py`). Every model starts with `torch.stft`
  and ends with `torch.istft` on its own device, and the MPS FFT has a history of wrong
  results and missing cases. On "mps" the engine runs an STFT round trip against the CPU once
  per process, before the first model loads. If it raises or does not match, `torch.stft` and
  `torch.istft` are replaced for that process by versions that do the transform on the CPU for
  MPS inputs and move the result back; the network stays on the GPU. The doctor and the
  self-test then carry a note saying so. A note is not a problem: the doctor still passes.
  The MDX23C loader already had its own CPU STFT for MPS; the two RoFormer loaders did not.
- **Memory for warm models.** A Mac has no graphics memory of its own: weights sit in the
  memory everything else uses. `Settings.vram_budget_bytes` caps the warm-model budget at half
  of the machine's memory on a Mac. The stored setting (12 GB) is untouched. Half is a first
  guess, not a measurement. ADR 0015 adds a budget for one model run, and one warm model at
  most on a Mac with 8 GB.
- **Doctor.** The backend reads "MPS" with the macOS version, the GPU name is the chip
  ("Apple M2 Pro", from `sysctl machdep.cpu.brand_string`), and the memory line reads "Memory
  (shared)" instead of "VRAM". It names an Intel Mac, a macOS older than 14, and MPS not being
  available as separate problems. The API's field names are unchanged: `cuda_available`
  still means "a GPU works", and `gpu_backend` gains `"mps"`. `SystemInfo` and `SelfTest` gain
  `notes`.
- **Folders** (`settings.py`): see ADR 0006. The settings of the old lew-stems name are not
  looked for on a Mac, since the app never had that name there.

## App

- **Folders and file names** (`electron/platform.ts`, pure functions with the platform passed
  in): the data root, `engine-env`, the logs folder, `bin/python` and `bin/openstems` in the
  environment where Windows has `Scripts\python.exe`, and `uv` where Windows has `uv.exe`.
  It decides the same folders as the engine's `settings.py`: change both together.
- **First-run setup** (`electron/setup.ts`, `electron/variant.ts`): no adapter detection, one
  build, `requirements-mps.txt` with no extra index, about 350 MB to download where the NVIDIA
  build is about 3 GB. `uv venv` gets `--managed-python`, so a Python from Homebrew is never
  used. Setup refuses a build the platform does not offer.
- **Development**: `uv run` gets `--no-default-groups --group dev --group mps` on a Mac,
  because the default groups hold the CUDA PyTorch, which has no macOS wheel.
- **Stopping the engine**: off Windows the engine is its own process group. Stopping sends
  SIGTERM to the group, then SIGKILL after three seconds.
- **Packaging** (`scripts/prepare-package.mjs`, `build.mac` in `package.json`): uv 0.13.6 for
  `aarch64-apple-darwin`, checked against its published sha256; a dmg and a zip for arm64;
  hardened runtime with one entitlement (`build/entitlements.mac.plist`: JIT, which
  Electron needs; the signing library's own default asks for no other code entitlement).
  The menu bar's template images go into the Mac bundle only, and the `.ico` files into the
  Windows one only, so the Windows package holds what it held. `pnpm dist:mac` builds it,
  on a Mac only, with `mac-build.cjs` as its configuration ("Signing").
  `PACKAGE_PLATFORM=darwin node scripts/prepare-package.mjs` runs the Mac preparation on
  Windows, which is how the pin set was checked.
- **The window**: a hidden title bar with the three window buttons at the top left, a standard
  application menu (without one a Mac has no Cmd+Q, Cmd+C or Cmd+W), Settings on Cmd+comma,
  and a Dock icon that stays. Closing the window never quits. ADR 0008 has the menu bar item.
- **Icons** (`scripts/make-icons.mjs`): `icon.icns` and six template images for the menu bar.
- **The page** (`src/platform.ts`, and `data-platform` on the root element for the
  stylesheet): Cmd where Windows has Ctrl, and Control is left alone, since Control+1 switches
  desktops and a Control-click is a right click. A Mac keeps its own scrollbars and gets the
  system font first. The Hide button of the quick-drop window is at the left. Settings from
  the application menu switches views without animation; for a window that is still loading,
  the preload leaves a mark on the root element (`data-open-view`) that the page reads once
  it is up.

## Where the difference lives

| Question | Place |
| --- | --- |
| Which GPU device, and its memory | `engine/src/openstems/engines/device.py` |
| Which backend a PyTorch build is | `doctor.torch_backend` |
| The STFT check and CPU patch | `engine/src/openstems/engines/stft_fallback.py` |
| Engine folders | `engine/src/openstems/settings.py` |
| App folders, file names in the environment | `app/electron/platform.ts` |
| Which build is offered | `app/electron/variant.ts` (`variantsFor`) |
| Window frame, menus, when the app quits, menu bar placement | `app/electron/traylogic.ts` |
| Words and shortcut keys in the page | `app/src/platform.ts` |
| Whether the app can install an update | `app/electron/updater.ts` (`updateBackend`) |

## Signing

A build made with no certificate is signed ad hoc. Left alone, electron-builder 26.18 looks
for a Developer ID identity, finds none, warns and skips signing; it does not fall back to an
ad hoc signature (read from `macPackager.js` and `MacTargetHelper.js` in the installed
version). It has also changed the bundle Electron signed by then, so what is left has no valid
signature at all, and Electron's documentation says macOS delivers notifications only for a
signed app. So the Mac commands read their configuration from `app/mac-build.cjs`: the
`build` block of `package.json`, and, when `CSC_LINK` is not set, `identity: "-"` (ad hoc) and
the hardened runtime off, since with an ad hoc signature the hardened runtime refuses to load
the app's own libraries. The same two settings on the command line do not work: `false`
arrives as a string and fails the validator. An ad hoc signature names no developer: macOS
still asks before the first open, and the app still cannot install an update.

To ship a build signed with a Developer ID and notarized, set these where `pnpm dist:mac`
runs (as repository secrets for a CI job). Nothing else changes:

| Variable | What it is |
| --- | --- |
| `CSC_LINK` | The Developer ID Application certificate as a `.p12` file: a path, or the file base64-encoded |
| `CSC_KEY_PASSWORD` | The password of that `.p12` |
| `APPLE_ID` | The Apple account that notarizes |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that account |
| `APPLE_TEAM_ID` | The developer team's ID |

With the first two the app is signed. With the last three as well it is notarized. A signed
app updates itself through `electron-updater` as on Windows: the app asks `codesign` once at
start whether it carries a Developer ID signature (`updater.macAppIsSigned`).

A Mac release carries `OpenStems-<version>-arm64.dmg`, `OpenStems-<version>-arm64.zip`, their
blockmaps and `latest-mac.yml`. The check of an app without a Developer ID reads
`latest-mac.yml` too, so a release without a Mac build offers nothing to Mac users: the
missing file is read as "no update", not as a failed check (`updatelogic.isMissingUpdateFile`).

## What was checked, all on Windows

- **Dependencies for macOS 14 arm64.** The `mps` export was resolved for the target without
  installing it:
  `MACOSX_DEPLOYMENT_TARGET=14.0 uv pip install --dry-run --python-platform
  aarch64-apple-darwin --python-version 3.12 --no-deps -r <the mps pin set>`. Every package
  resolves, and with `--only-binary :all:` every package except the three git loaders has a
  wheel, PyTorch 2.14.1 and deno included. With uv's default target of macOS 13 the same
  command fails, because PyTorch has only the `macosx_14_0_arm64` wheel. That is the macOS 14
  minimum showing.
- **The Windows pin sets are unchanged.** The `cuda`, `cu126` and `rocm` exports were diffed
  before and after the new group: identical.
- **Mac packaging steps on Windows.** `PACKAGE_PLATFORM=darwin node
  scripts/prepare-package.mjs` downloaded uv for `aarch64-apple-darwin`, matched its sha256,
  extracted a Mach-O file and wrote `requirements-mps.txt`. Run for Windows afterwards, the
  script gives what it gave before.
- **electron-builder's configuration.** The installed version's own validator accepts the
  `build` block and what `mac-build.cjs` makes of it, with and without `CSC_LINK`.
- **Unit tests with the platform patched or passed in.** Engine (`tests/test_macos.py`): the
  device choice, the memory calls, the out-of-memory wording and the batch backoff, the STFT
  patch (exact on the CPU, and it restores cleanly), the doctor and the self-test on a pretend
  Mac, the folders, the memory cap and the environment variable. App
  (`src/test/platform.test.ts`, `variant.test.tsx`, `tray.test.tsx`, `update.test.tsx`): the
  folders and file names, the one build and the Intel refusal, what setup asks of uv, the
  window frame, both menus, what a click on the menu bar item does, when the app quits, where
  the quick-drop window sits under the menu bar, the manual update, the Developer ID check, a
  release without a Mac build, the bundle's path, and the ad hoc build configuration.
- **Read, not tested.** The glue around those functions has no test that reaches it on
  Windows, and first runs on the Mac CI job or on a Mac: registering the menu bar item's
  click handlers and raising a `Notification` (`electron/tray.ts`; the end-to-end suite
  records notices instead of raising them), the `codesign` call and reading its answer
  (`updater.macAppIsSigned`), starting the engine in its own process group and signalling
  it (`electron/engine.ts`), the application menu's Settings item, the `activate` handler
  and the window-button inset sent to the page (`electron/main.ts`, `electron/preload.ts`).
- **Windows is as it was.** The engine's lint, type-check and unit tests pass, the app's
  type-check, unit tests and end-to-end suite pass, and `openstems doctor` and `selftest
  --ops-only` print what they printed before on the RTX 5070 Ti.
- **The manual update, end to end.** `e2e/update.spec.ts` starts the app with the manual
  stand-in and checks that a click on the offer asks for the release page and nothing else.

## CI

`.github/workflows/ci.yml` runs both jobs on `windows-latest` and on `macos-15`, an Apple
Silicon runner. The Windows commands are unchanged. Neither Mac job has run yet: the first
push is the first place this code meets a Mac.

- **Engine on the Mac runner.** `uv sync --locked --no-default-groups --group mps --group dev`,
  then `UV_NO_SYNC=1` for the rest of the job (the same as `uv run --no-sync`), then the lint,
  the type-check and the unit tests. `tests/conftest.py` switches MPS off for every test on a
  Mac, so the unit tests stay on the CPU there as well; the tests about a Mac switch it back
  on with stand-ins.
- **App on the Mac runner.** The type-check, the unit tests, the build and the end-to-end
  suite with the FakeEngine, then `pnpm package:prepare` and `pnpm run pack:mac` with no
  certificate, with a check that the bundle holds the app, `bin/uv`, `requirements-mps.txt`
  and the template icon. electron-builder skips signing on a pull request unless
  `CSC_FOR_PULL_REQUEST` is set; the job holds no secret and sets it, so the ad hoc signing
  that a release does is tried on every run, and `codesign --verify` reports on it.
- **Release** (`.github/workflows/release-mac.yml`). When a release is published, or by hand
  for a tag that has one, it does what `pnpm dist:mac` does and uploads the dmg, the zip, the
  blockmaps and `latest-mac.yml` to that release. The tag must be
  `v<version in app/package.json>`. It signs with a Developer ID and notarizes only when the
  secrets under "Signing" are set. The build job can only read the repository, and gives the
  signing secrets to the one step that runs electron-builder, after the steps that fetch and
  run other people's code (`pnpm install`, the wheels' build backends). A second job, which
  checks nothing out, holds the token that can write and adds the files to the release.
  Every action there is pinned to a commit, and uv to the version the app ships.

A green Mac job shows that the code installs, imports, passes its tests and packages on a
Mac. It runs no model, so it proves nothing in the next section.

## Run on a Mac: 2026-11-23

The first Mac job in CI passed on its first run: the engine tests, the component tests, the
end-to-end suite with the FakeEngine and an ad hoc signed bundle. `release-mac.yml` then built
the 0.3.0 dmg, zip and `latest-mac.yml` and added them to the release.

The owner installed that dmg on an M1 Max with 32 GB and reported, without figures:

- The app opened after the confirmation in System Settings, with the window buttons in place.
- First-run setup finished: uv's Python, PyTorch and the model code.
- A separation ran on the Apple GPU and the stems were right.
- The menu bar item and the quick-drop window worked.

Setup failed once before that, at its first step, with "EACCES: permission denied, mkdir" on
`~/Library/Application Support/OpenStems`. That Mac's `Application Support` folder belonged to
root, a fault on the machine that stops any new app. `sudo chown` on the folder fixed it. Setup
now explains that case and gives the command (`platform.explainSetupError`).

Not recorded from that run: how long a separation takes, whether the STFT check passed
natively or the CPU patch went in, the doctor's output, and the self-test with a model.

## On GitHub's Mac runner: 2026-11-23

`mac-check.yml` ran `scripts/mac_check.sh` with real models on a `macos-15` runner: a virtual
Apple M1 with 7 GB, macOS 15.8.2, PyTorch 2.14.1 from the `mps` group. The song was the
synthetic demo song (`scripts/make_demo_song.py`), 192 s. The runner does expose the Apple
GPU: the doctor reported the MPS backend, "Apple M1 (Virtual)", 7.0 GB shared memory and 3.8 GB
for one model.

- **Every operation matches the CPU**, the STFT and inverse STFT included (errors of 3e-7),
  so the STFT check passed natively and the CPU fallback (`engines/stft_fallback.py`) never
  went in.
- **BS-RoFormer on MPS matches the CPU**: `selftest -m bs-roformer-sw` gave -127.2 dB, GPU
  against CPU, where the pass mark is -40 dB. 34.7 s on the GPU and 82.5 s on the CPU for the
  6 s test signal.
- **`full-song` on Fast finished**: 1136 s for the 192 s song, 0.17x real time, on a machine
  whose budget (3.8 GB) is below the estimate for SW at full precision. A second run took
  1413 s.
- **Not reached**: `every-stem` (Mel-Band RoFormer is not in it; MDX23C is), because the job hit
  its two-hour limit. The limit is now four hours and the second `full-song` run is gone.

What it does not tell: speed on real hardware. The runner's GPU is virtual and its memory
small, and the self-test's own ratio (2.4x the CPU) is far below what a real M1 gives, so
these times are a floor for the slowest Mac, not a benchmark. Whether the CPU fallback for
memory went in during that run is not in the report: the command line does not print a job's
notes.

## Still unproven on a Mac

The list as it stood before the run above. The items that run covers in broad terms (the
models on MPS, first-run setup, the window, the menu bar item, packaging, opening a build with
no Developer ID, the test suites) are seen working once, on one machine, with no measurements.
The rest has not been seen at all.

- **Whether the models run correctly on MPS, and how fast**, for each family: BS-RoFormer,
  Mel-Band RoFormer and MDX23C. BS-RoFormer is now measured on the runner (above); the other
  two, and any speed on real hardware, are not. They use complex tensors, `index_fill` and einsum, among
  others, and upstream no longer tests them on MPS. A missing operation falls back to the CPU;
  a wrong result would only show in the self-test or by ear.
- **The STFT safety net.** Whether the native MPS STFT passes its check on real hardware, so
  whether the patch ever goes in (on the runner's virtual GPU it passed); and whether a patched STFT's complex output moves back to
  the GPU correctly. The patch is tested on CPU tensors only.
- **Memory.** Whether an MPS out-of-memory error reaches the batch backoff, or macOS swaps or
  ends the process first. Whether half of the machine's memory is the right cap.
- **First-run setup**: `uv venv --managed-python`, the install into `bin/`, the doctor run.
- **Stopping the engine** through its process group.
- **The window**: the position of the three window buttons and the room left for them.
- **The menu bar item**: the template images in a light and a dark bar, the click and the
  Control-click, the panel over a full-screen app, drops onto the panel, where it sits.
- **Notifications and the login item.** Electron's documentation says macOS delivers
  notifications only for a signed app, and that a login item should be signed to work
  reliably. Whether the ad hoc signature is enough for either is not known.
- **Packaging**: `pnpm dist:mac` has never run. The dmg, the zip and `latest-mac.yml` have
  never been produced.
- **Opening a build with no Developer ID.** Downloaded with a browser, it may be reported by
  macOS as damaged instead of merely unverified. The ad hoc signature should make that the
  ordinary prompt. The README gives the steps for both cases; which one a user meets is not
  known. Whether electron-builder's ad hoc signing succeeds at all has not been seen either.
- **Signing and notarization.** No certificate exists yet. Whether the bundled `uv` runs once
  signed under the hardened runtime is unknown, and whether the app and its helpers start
  with the JIT entitlement alone.
- **Self-update.** Neither path has run: the check against `latest-mac.yml` in an unsigned
  app, and `electron-updater` replacing a signed app.
- **The test suites on a Mac.** No test has run on macOS. The engine tests that start a
  worker process, and the end-to-end suite, are the likeliest to need attention there.

Not built: dropping files on the menu bar item itself. Queuing lives in the windows, and the
quick-drop window is one click away.

## For whoever tests on a Mac

With the app installed and set up, one command gathers what is still unmeasured (the
doctor, the self-tests, a timed `full-song` and `every-stem`, and the 8 GB view) into a text
file on the Desktop:

```
bash scripts/mac_check.sh ~/Music/a-song.mp3
```

The report holds the song's length and format, not its name.

In a development checkout (`cd engine` first):

```
uv sync --no-default-groups --group mps --group dev
uv run --no-sync openstems doctor
uv run --no-sync openstems selftest --ops-only
uv run --no-sync openstems models pull bs-roformer-sw
uv run --no-sync openstems selftest -m bs-roformer-sw
```

`--no-sync` matters: a plain `uv run` would try to install the default groups, which hold the
CUDA PyTorch.

In the installed app, the same program is at
`"$HOME/Library/Application Support/OpenStems/engine-env/bin/openstems"`.

1. `doctor` should show GPU backend "MPS", the chip's name and "GPU available: yes". A "note:"
   line about the STFT means the safety net went in.
2. `selftest --ops-only` compares every kind of operation the models use on the Apple GPU and
   on the CPU. It takes seconds and loads no model.
3. `selftest -m MODEL` separates a short built-in signal with that model on both devices and
   prints the difference in dB and the time on each. One model per family covers the three
   architectures.
4. In the app: Settings > System > GPU self-test > Run, then Export diagnostics, and send the
   zip with the Mac's model and macOS version.

If the GPU misbehaves, Settings > System > "Use the GPU" off (or `OPENSTEMS_DEVICE=cpu`) runs
everything on the CPU.
