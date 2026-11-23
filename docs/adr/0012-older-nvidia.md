# 0012: A build for older NVIDIA cards

Date: 2026-11-22. Status: accepted as a preview. **Not yet run on such a card.**

## Decision

A third PyTorch build joins the two from ADR 0007: PyTorch 2.14.1 for CUDA 12.6. It is for
the NVIDIA generations that PyTorch's CUDA 13 build left out: Maxwell, Pascal and Volta, which
is the GTX 750 Ti, the GTX 900 and 10 series, the GT 1030, the Titan X, Xp and V, and the
Quadro M and P cards.

| Build | PyTorch | Cards |
| --- | --- | --- |
| `cuda` | 2.14.1 for CUDA 13.0 | GTX 16 series, RTX 20 series and later, the 50 series included |
| `cu126` | 2.14.1 for CUDA 12.6 | GTX 750 Ti, GTX 900 and 10 series, Titan X/Xp/V, Quadro M and P |
| `rocm` | AMD's 2.9.1 | the Radeons AMD supports |

Neither NVIDIA build covers every card: CUDA 12.6 cannot run a 50-series card, and CUDA 13
has no kernels for the older ones. The cards from the GTX 16 and RTX 20 series up to the 40
series run on both and get the standard build.

## Why it is the same PyTorch version

PyTorch publishes 2.14.1 for both CUDA versions, so the models, loaders and every other pin
are identical: the two requirement sets differ in the PyTorch wheel only. PyTorch has said
that 2.14 is the last release with CUDA 12.6 wheels. When the standard build moves past 2.14,
this build stays where it is, the way AMD's build sits on 2.9.1.

## How a card gets its build

- **At first run** the app reads the adapter names (`electron/variant.ts`, `nvidiaOlder`).
  An older NVIDIA card gets this build; with two NVIDIA cards, a current one decides. The
  setup screen names what it found and offers all three builds.
- **In Settings**, the engine build is now a list of the three builds, each with the cards it
  is for. Picking another asks before it rebuilds the environment.
- **A card the installed build cannot run** is no longer a failed job. The engine compares
  the card's compute capability with what the build was compiled for
  (`engines/torch_common.arch_supported`); when they do not match it runs on the CPU, and
  `doctor` and Settings say which build to switch to. This covers both directions: an old
  card on the standard build, and a 50-series card on this one.

## Half precision

The presets run in half precision on the GPU. That is a speed-up on cards built for it, Volta
and later. On Maxwell and Pascal it works but is many times slower than full precision, so on
those cards the runner uses full precision instead (`engines/runner.fast_half_precision`).
Full precision needs more graphics memory: expect roughly twice the figures in
`docs/benchmarks.md`, so a 4 GB card will be tight for the larger models.

## Checked, all without such a card

- The two existing requirement sets are unchanged by the new group; the new set differs from
  the standard one in the PyTorch wheel only.
- Engine tests for which build runs which card (GTX 980, GTX 1060, Titan V, GTX 1660, RTX
  3060, RTX 4070, RTX 5070 Ti), the half-precision rule and the doctor's message. The
  standard build's real architecture list was read from PyTorch on the development machine.
- App tests for recognising older cards by name and for the three-way build list.
- The packaged app with this build forced on a clean profile: setup installs it (1.5 minutes),
  and on the RTX 5070 Ti it reports "This PyTorch build (CUDA 12.6) does not support NVIDIA
  GeForce RTX 5070 Ti" with the build to switch to, and runs on the CPU.
- A separation with that environment (on the CPU) writes six stems.

## What is not known

- Whether the models run correctly, and how fast, on a GTX 900 or 10 series card.
- How much graphics memory full precision needs on those cards.
- Whether every older card is recognised by name. A card that is not gets the standard build,
  runs on the CPU, and is told to switch.
- The oldest NVIDIA driver that works. CUDA 12.6 needs the 560 series or newer.

## For whoever tests on such a card

Install, let setup finish (it should offer "NVIDIA (older)"), download a model, run a song,
then use Settings > Export diagnostics and send the zip.
