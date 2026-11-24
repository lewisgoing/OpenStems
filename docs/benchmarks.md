# Benchmarks

Run time and peak VRAM per model and quality preset on the target machine.

- GPU: NVIDIA GeForce RTX 5070 Ti (16 GB), driver 621.24, PyTorch 2.14.1+cu130, fp16 autocast.
- Song: 205 s stereo MP3 (3:25), decoded to 44.1 kHz. Times are inference only: no decode, no
  file writing. Load is the one-off time to build the model and move it to the GPU; the worker
  keeps the last model warm, so later jobs skip it.
- Peak VRAM is `torch.cuda.max_memory_allocated`. It does not grow with track length because the
  overlap-add buffers live in RAM.

- The Peak VRAM column of "Every model and preset" is each model's memory figure in the
  catalog (`memory_gb`), which decides whether a model fits a machine. These are half
  precision on CUDA. At full precision (a Mac, the CPU, GTX 900 and 10 series cards) the app
  works with an estimate, not a measurement: nothing here was measured on a Mac. The rule
  and its limits are in [`adr/0015-low-memory.md`](adr/0015-low-memory.md).

Reproduce from `engine/`: `uv run python ../scripts/benchmark.py SONG --markdown`. After a new
measurement, copy the figure into `MEMORY_GB` in `scripts/gen_catalog.py` and regenerate the
catalog.

## Presets

| Model | Preset | Overlap | TTA | Batch | Load (s) | Run (s) | x real time | Peak VRAM (GB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bs-roformer-sw | fast | 2 | no | 1 | 1.8 | 13.6 | 15.1 | 2.32 |
| bs-roformer-sw | balanced | 4 | no | 1 | 1.8 | 25.7 | 8.0 | 2.32 |
| bs-roformer-sw | best | 8 | yes | 1 | 1.8 | 154.5 | 1.3 | 2.32 |
| bs-roformer-leap-xe-vocals | fast | 2 | no | 1 | 1.0 | 23.9 | 8.6 | 3.80 |
| bs-roformer-leap-xe-vocals | balanced | 4 | no | 1 | 1.0 | 49.6 | 4.1 | 3.80 |
| bs-roformer-leap-xe-vocals | best | 8 | yes | 1 | 1.0 | 300.9 | 0.7 | 3.80 |

Fast is one pass of overlapping halves (the loaders' own default). Balanced doubles the overlap.
Best uses overlap 8 plus test-time augmentation (three runs: plain, channels swapped, polarity
inverted), which costs about twelve times Fast.

## Every model and preset

A 57 s song this time, so the whole catalog fits in one run. Short songs carry more fixed
overhead per chunk, which is why SW reads 10.5x real time here against 15.1x on the 205 s song.

| Model | Preset | Overlap | TTA | Batch | Load (s) | Run (s) | x real time | Peak VRAM (GB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bs-roformer-sw | fast | 2 | no | 1 | 3.1 | 5.4 | 10.5 | 2.32 |
| bs-roformer-sw | balanced | 4 | no | 1 | 3.1 | 8.7 | 6.5 | 2.32 |
| bs-roformer-sw | best | 8 | yes | 1 | 3.1 | 54.2 | 1.0 | 2.32 |
| bs-roformer-leap-xe-vocals | fast | 2 | no | 1 | 0.9 | 8.4 | 6.7 | 3.80 |
| bs-roformer-leap-xe-vocals | balanced | 4 | no | 1 | 0.9 | 18.6 | 3.0 | 3.80 |
| bs-roformer-leap-xe-vocals | best | 8 | yes | 1 | 0.9 | 114.8 | 0.5 | 3.80 |
| bs-roformer-leap-xe-instrumental | fast | 2 | no | 1 | 0.9 | 8.3 | 6.8 | 3.80 |
| bs-roformer-leap-xe-instrumental | balanced | 4 | no | 1 | 0.9 | 18.6 | 3.0 | 3.80 |
| bs-roformer-leap-xe-instrumental | best | 8 | yes | 1 | 0.9 | 115.0 | 0.5 | 3.80 |
| bs-roformer-hyperace-v2-vocals | fast | 2 | no | 1 | 1.0 | 6.7 | 8.4 | 2.96 |
| bs-roformer-hyperace-v2-vocals | balanced | 4 | no | 1 | 1.0 | 11.5 | 4.9 | 2.96 |
| bs-roformer-hyperace-v2-vocals | best | 8 | yes | 1 | 1.0 | 69.3 | 0.8 | 2.96 |
| bs-roformer-hyperace-v2-instrumental | fast | 2 | no | 1 | 1.1 | 5.2 | 10.8 | 2.96 |
| bs-roformer-hyperace-v2-instrumental | balanced | 4 | no | 1 | 1.1 | 11.0 | 5.1 | 2.96 |
| bs-roformer-hyperace-v2-instrumental | best | 8 | yes | 1 | 1.1 | 68.9 | 0.8 | 2.96 |
| bs-roformer-karaoke-becruily | fast | 2 | no | 1 | 0.6 | 4.4 | 12.9 | 2.66 |
| bs-roformer-karaoke-becruily | balanced | 4 | no | 1 | 0.6 | 9.7 | 5.8 | 2.66 |
| bs-roformer-karaoke-becruily | best | 8 | yes | 1 | 0.6 | 59.8 | 0.9 | 2.66 |
| bs-roformer-karaoke-anvuew | fast | 2 | no | 1 | 0.7 | 3.8 | 14.9 | 2.00 |
| bs-roformer-karaoke-anvuew | balanced | 4 | no | 1 | 0.7 | 8.3 | 6.8 | 2.00 |
| bs-roformer-karaoke-anvuew | best | 8 | yes | 1 | 0.7 | 52.1 | 1.1 | 2.00 |
| bs-roformer-dereverb-anvuew | fast | 2 | no | 1 | 0.7 | 3.5 | 15.9 | 1.47 |
| bs-roformer-dereverb-anvuew | balanced | 4 | no | 1 | 0.7 | 7.3 | 7.7 | 1.47 |
| bs-roformer-dereverb-anvuew | best | 8 | yes | 1 | 0.7 | 44.6 | 1.3 | 1.47 |
| bs-roformer-mega-53 | fast | 2 | no | 1 | 7.6 | 8.8 | 6.4 | 9.50 |
| bs-roformer-mega-53 | balanced | 4 | no | 1 | 7.6 | 18.0 | 3.1 | 9.50 |
| bs-roformer-mega-53 | best | 8 | yes | 1 | 7.6 | 111.6 | 0.5 | 9.50 |
| mel-roformer-vocals-becruily | fast | 2 | no | 1 | 3.1 | 2.9 | 19.5 | 1.51 |
| mel-roformer-vocals-becruily | balanced | 4 | no | 1 | 3.1 | 5.6 | 10.1 | 1.51 |
| mel-roformer-vocals-becruily | best | 8 | yes | 1 | 3.1 | 34.0 | 1.7 | 1.51 |
| mel-roformer-instrumental-becruily | fast | 2 | no | 1 | 2.6 | 2.8 | 19.9 | 1.51 |
| mel-roformer-instrumental-becruily | balanced | 4 | no | 1 | 2.6 | 5.6 | 10.1 | 1.51 |
| mel-roformer-instrumental-becruily | best | 8 | yes | 1 | 2.6 | 33.9 | 1.7 | 1.51 |
| mel-roformer-deux-becruily | fast | 2 | no | 1 | 1.7 | 4.7 | 12.0 | 1.77 |
| mel-roformer-deux-becruily | balanced | 4 | no | 1 | 1.7 | 10.1 | 5.6 | 1.77 |
| mel-roformer-deux-becruily | best | 8 | yes | 1 | 1.7 | 62.2 | 0.9 | 1.77 |
| mel-roformer-kim-vocals | fast | 2 | no | 1 | 2.6 | 2.9 | 19.7 | 1.51 |
| mel-roformer-kim-vocals | balanced | 4 | no | 1 | 2.6 | 5.6 | 10.1 | 1.51 |
| mel-roformer-kim-vocals | best | 8 | yes | 1 | 2.6 | 34.0 | 1.7 | 1.51 |
| mel-roformer-dereverb-anvuew | fast | 2 | no | 1 | 2.6 | 2.8 | 20.1 | 1.51 |
| mel-roformer-dereverb-anvuew | balanced | 4 | no | 1 | 2.6 | 5.6 | 10.1 | 1.51 |
| mel-roformer-dereverb-anvuew | best | 8 | yes | 1 | 2.6 | 34.3 | 1.6 | 1.51 |
| mel-roformer-denoise-debleed-gabox | fast | 2 | no | 1 | 2.6 | 3.0 | 19.0 | 1.74 |
| mel-roformer-denoise-debleed-gabox | balanced | 4 | no | 1 | 2.6 | 6.0 | 9.5 | 1.74 |
| mel-roformer-denoise-debleed-gabox | best | 8 | yes | 1 | 2.6 | 37.2 | 1.5 | 1.74 |
| mel-roformer-guitar-becruily | fast | 2 | no | 1 | 0.2 | 1.6 | 34.3 | 0.90 |
| mel-roformer-guitar-becruily | balanced | 4 | no | 1 | 0.2 | 3.4 | 16.7 | 0.90 |
| mel-roformer-guitar-becruily | best | 8 | yes | 1 | 0.2 | 20.9 | 2.7 | 0.90 |
| mdx23c-drumsep | fast | 2 | no | 4 | 1.3 | 0.8 | 69.7 | 1.09 |
| mdx23c-drumsep | balanced | 4 | no | 4 | 1.3 | 1.3 | 42.1 | 1.09 |
| mdx23c-drumsep | best | 8 | yes | 4 | 1.3 | 8.0 | 7.1 | 1.09 |

Notes:

- Mel-Band RoFormers are the fastest full-size models (about 20x real time at Fast).
- The 53-stem model needs 9.5 GB of VRAM and fits the 16 GB card. Only the ticked stems are
  kept in RAM.
- DrumSep runs on the drums stem at 70x real time, so `drum-kit` costs little more than
  `full-song`.

## Batch size (Fast preset)

| Model | Batch | Run (s) | x real time | Peak VRAM (GB) |
| --- | --- | --- | --- | --- |
| bs-roformer-sw | 1 | 13.7 | 15.0 | 2.32 |
| bs-roformer-sw | 2 | 12.1 | 16.9 | 3.94 |
| bs-roformer-sw | 4 | 11.7 | 17.5 | 7.19 |
| bs-roformer-leap-xe-vocals | 1 | 23.9 | 8.6 | 3.80 |
| bs-roformer-leap-xe-vocals | 2 | 24.1 | 8.5 | 7.32 |
| bs-roformer-leap-xe-vocals | 4 | 41.6 | 4.9 | 14.34 |

Batching buys at most 15% on SW and nothing on Leap Xe, while VRAM doubles with each step, so the
RoFormer presets run one chunk at a time. If a batch does not fit, the runner halves it and
retries.

## Null test

`uv run python ../scripts/null_test.py SONG`: the shared runner against the loader library's own
chunked inference at the same chunk and overlap, 45 s of audio (12 s for the 53-stem model).

| Model | Worst stem | Requirement |
| --- | --- | --- |
| bs-roformer-sw | -132.7 dB (piano) | below -40 dB |
| bs-roformer-leap-xe-vocals | -145.7 dB | below -40 dB |
| bs-roformer-hyperace-v2-vocals | -140.1 dB | below -40 dB |
| bs-roformer-karaoke-becruily | -145.5 dB | below -40 dB |
| bs-roformer-karaoke-anvuew | -137.9 dB | below -40 dB |
| bs-roformer-dereverb-anvuew | -191.1 dB | below -40 dB |
| bs-roformer-mega-53 | -157.5 dB (tuba) | below -40 dB |
| mel-roformer-vocals-becruily | -133.3 dB | below -40 dB |
| mel-roformer-deux-becruily | -160.5 dB (vocals) | below -40 dB |
| mel-roformer-kim-vocals | -111.2 dB | below -40 dB |
| mel-roformer-dereverb-anvuew | -118.2 dB | below -40 dB |
| mel-roformer-guitar-becruily | -185.8 dB | below -40 dB |
| mdx23c-drumsep | -157.0 dB (ride) | below -40 dB |

The four models not listed (Leap Xe instrumental, HyperACE v2 instrumental, becruily
instrumental, Gabox denoise) returned near silence on the test excerpt and null at the float
floor (-221 dB).

## Mac: GitHub's runner only

Measured on a `macos-15` runner (virtual Apple M1, 7 GB, MPS, full precision) by
`scripts/mac_check.sh` on 2026-11-23, with a 192 s synthetic song. Not a benchmark of a real
Mac: the GPU is virtual and the memory small. `docs/adr/0014-macos.md` has the details.

| Model or recipe | Preset | Run (s) | x real time | GPU vs CPU |
| --- | --- | --- | --- | --- |
| bs-roformer-sw (self-test, 6 s signal) | the self-test's | 34.7 (CPU 82.5) | 0.17 | -127.2 dB |
| full-song | fast | 1136 | 0.17 | |

No real Mac has been timed yet. `bash scripts/mac_check.sh SONG` on one writes the figures.
