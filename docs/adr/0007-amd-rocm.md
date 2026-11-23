# 0007: AMD Radeon support through ROCm

Date: 2026-11-21. Status: accepted as a preview. **Not yet run on a Radeon card.**

This deviates from the plan, which targets one machine: Windows with an NVIDIA RTX 5070 Ti.

## Decision

The engine supports a second PyTorch build: AMD's own PyTorch for Windows (ROCm 7.2.1,
PyTorch 2.9.1, Python 3.12), published on repo.radeon.com. A ROCm build presents the Radeon
through the same `torch.cuda` interface as an NVIDIA card, so the models, the runner and the
worker are unchanged. What changed is which PyTorch gets installed, and how the app tells the
user what it found.

Everything that can be checked without a Radeon card was checked (see the end). The GPU
kernels themselves were not: nobody has yet run a separation on a Radeon with this app.
`openstems selftest` exists so that the first person who does can report exactly what works.

## Why ROCm and not the alternatives

- **DirectML** runs on any GPU, but Microsoft's `torch-directml` stops at PyTorch 2.3.1 with
  development builds from 2024, and the models need complex STFT on the device.
- **ONNX export** would mean converting and re-validating all 17 models.
- **ZLUDA** and similar translation layers are unofficial.
- **ROCm** is AMD's supported path, uses the models as they are, and needs no model changes.

## What AMD supports

From AMD's Windows support matrix for 7.2.1: Radeon RX 9070, RX 9070 XT, RX 9060 XT,
RX 7900 XTX, RX 7700, PRO W7900 and AI PRO R9700, on Windows 11 with AMD driver 26.2.2 or
newer. AMD notes that Windows gets PyTorch only, not the whole ROCm stack. RX 6000 and older
cards and integrated graphics are not supported.

## Two dependency sets in one lockfile

`engine/pyproject.toml` has two dependency groups that conflict with each other:

- `cuda`: `torch==2.14.1` from the CUDA 13.0 index. `uv sync` installs it by default, so
  development is unchanged.
- `rocm`: `torch==2.9.1+rocm7.2.1`, `rocm`, `rocm-sdk-core` and `rocm-sdk-libraries-custom`,
  as direct links to repo.radeon.com.

`uv.lock` resolves both and records a sha256 for every AMD file. The pins for every other
package are the same in both sets; the exported NVIDIA set is byte-for-byte what it was before.

The base requirement is `torch>=2.9`, the oldest version in use. The lockfile also holds a
third resolution with neither group (plain PyTorch from PyPI); nothing installs it.

## Packaging and first run

`scripts/prepare-package.mjs` writes `requirements.txt` (NVIDIA) and `requirements-rocm.txt`
(AMD). AMD ships its small `rocm` helper as source only, so its wheel is built at packaging
time like the loaders. The three large AMD wheels are named by URL with the sha256 from the
lockfile, and uv refuses a download whose hash differs.

At first run the app asks Windows for its video adapters and recommends a build
(`app/electron/variant.ts`):

| Found | Build | Note shown |
| --- | --- | --- |
| Any NVIDIA card | NVIDIA | |
| A Radeon on AMD's list | AMD | New, not tested on this card |
| A Radeon of the same chip family (RX 7000 and 9000 desktop) that AMD does not list | AMD | May not work |
| Any other Radeon, or no usable card | NVIDIA | Runs on the CPU |

An unsupported Radeon gets the NVIDIA build on purpose. AMD's build uses OpenBLAS where the
standard build uses MKL, and on the CPU it was 15 to 20 times slower here for the RoFormer
models (279 s against 18 s for the same four seconds of audio).

The setup screen shows what was found and lets the user choose the other build. Settings shows
the installed build and can switch it, which rebuilds the Python environment. The marker file
records the build beside the app version; a marker from before this change reads as NVIDIA.
`OPENSTEMS_TORCH_VARIANT=cuda|rocm` forces the choice.

## Engine changes

- `doctor` reports the GPU backend (CUDA or ROCm, from how PyTorch was built) and gives a
  vendor-specific reason when no GPU is usable. Its GPU check now includes an STFT round trip
  compared with the CPU, since every model starts and ends with one.
- The API's system info has `gpu_backend` and `gpu_backend_version`. `cuda_available` keeps its
  name and means "a GPU works", for either vendor, as it does in PyTorch.
- A new setting, `use_gpu` (and `OPENSTEMS_DEVICE=cpu`), keeps separation on the CPU. It is the
  way through when a card or driver misbehaves. Changing it drops the warm models.
- `openstems selftest` runs each kind of operation the models use on the GPU and on the CPU
  and compares them, then separates a short built-in signal with one installed model per
  architecture on both devices. It prints the difference in dB and the time on each device,
  and exits non-zero on a mismatch. `--json` gives the same as JSON.
- `POST /v1/selftest` runs that command in its own process (the API never imports PyTorch,
  and a GPU fault must not take the API down), refuses while a job is active, and saves the
  report beside the logs. Settings has a button for it, and Export diagnostics includes
  the last report.

## What was checked, all without a Radeon card

- The AMD build installs and imports on a machine with no supported Radeon, and reports no
  GPU instead of failing.
- The engine's unit tests pass under the AMD build (167 of 167), as they do under the NVIDIA
  build.
- One model of each architecture (BS-RoFormer SW, Mel-Band RoFormer guitar, MDX23C DrumSep)
  gives the same stems under both builds on the CPU: the largest difference is -133 dB
  relative to the input (`scripts/compare_builds.py`). So the loaders, the checkpoints and
  the runner work on PyTorch 2.9.1.
- `openstems selftest` passes on the RTX 5070 Ti: every operation, and all three models
  within -70 dB of the CPU.
- The first-run install command, run with the bundled uv against `requirements-rocm.txt` in an
  empty environment, installs the set; a wrong hash is refused.
- The packaged app, on a clean profile with the AMD build forced, completes first-run setup
  and starts; Settings shows the ROCm build and says no supported Radeon was found
  (`PACKAGED_VARIANT=rocm`, `e2e/packaged.spec.ts`).
- The packaged app on a clean profile with no override picks the NVIDIA build on the
  development machine, which has an integrated Radeon beside the RTX 5070 Ti, separates a
  song as before, and passes the self-test from the Settings button.
- Switching the build from Settings works in the packaged app: a profile set up with the AMD
  build was switched to the NVIDIA build (`PACKAGED_SWITCH=cuda`), in 1.3 minutes.

## What is not known

- Whether the models run correctly, or at all, on a Radeon. AMD's notes say the Windows stack
  is partial, that training is unsupported, and that only batch size 1 is officially supported
  for language models. The presets use batch 4 for MDX23C; the runner halves the batch on an
  out-of-memory error, but another kind of failure would surface as a failed job.
- Speed and VRAM use on a Radeon.
- Whether half precision behaves; the RoFormer and MDX23C presets use it on the GPU, and the
  self-test compares it with the CPU.

## First report from a Radeon

On 2026-11-22 a user with a Radeon installed 0.2.0 and reported that it works well. The card
model, the speed and the self-test result were not recorded, so the questions above are
answered only as far as "separation runs and sounds right on at least one supported card".

## For whoever tests on a Radeon

1. Install the app; setup should offer the AMD build. Let it finish.
2. Download one model, then run a song.
3. Settings > System > GPU self-test > Run, then Export diagnostics, and send the zip. If the
   app does not get that far, run
   `"%LOCALAPPDATA%\OpenStems\engine-env\Scripts\openstems.exe" selftest` in a terminal and
   send what it prints.
