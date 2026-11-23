# 0002: Engine adapter and the shared runner

Date: 2026-11-20. Status: accepted (the plan's default, confirmed by the Phase 1 spike).

## Context

`PLAN.md` left the Engine adapter open until a Phase 1 spike: the OpenMIRLab loaders plus a
shared chunked runner (default), splifft, or python-audio-separator. The adapter had to load SW
and Leap Xe on the 5070 Ti, allow chunk-level progress and cancel, and match the library's own
output.

## Decision

Keep the default: **model classes from the OpenMIRLab loaders, inference by our own runner**
(`engines/runner.py`, ported from MSST's `demix`).

- The loaders only build the `torch.nn.Module` (`get_model_from_config`). Chunking, windows,
  batching, autocast, test-time augmentation, cancel, progress and out-of-memory backoff are
  ours, in one loop shared by every architecture.
- splifft is still 0.0.x and python-audio-separator has no progress or cancel hook, so neither
  was adopted. The Engine port (`engines/base.py`) keeps both possible later.

## What the spike found

1. **Both models load and run on the 5070 Ti** with `weights_only=True`.
2. **Null test** (`scripts/null_test.py`, 60 s of audio, same chunk and overlap, batch 1): the
   runner differs from the library's `demix_track` by -133 dB or less on every SW stem and
   -146 dB on Leap Xe vocals. The requirement was below -40 dB.
3. **The PyPI release is behind.** `bs-roformer-infer` 0.1.5 on PyPI lists 10 models and has
   neither Leap Xe nor the 53-stem model. The GitHub main branch (0.1.6) has both, so the
   engine depends on the git repository pinned to a commit
   (`e3ad851fb24333ae36ae4bfd5ec327dbbf764bea`). `uv.lock` records it.
4. **Leap Xe's config chunk does not fit its own model.** The config says
   `chunk_size: 881559`, which is not a multiple of the 512-sample STFT hop, so the model
   returns 881152 samples and the library's own `demix_track` fails on a full chunk. The
   catalog uses 881152 (the same chunk rounded down to the hop), and the runner also tolerates
   a model that returns slightly fewer samples than it was given.
5. **Batching barely helps the RoFormers.** On a 205 s song SW runs in 13.7 s at batch 1 and
   11.7 s at batch 4 while peak VRAM goes from 2.3 GB to 7.2 GB; Leap Xe gets slower at batch 4
   because it nears the 16 GB limit. RoFormer presets therefore use batch 1.
6. **No overlap means no fade.** MSST's window fades to zero at both chunk edges, which leaves
   zero weight at the seams when `num_overlap` is 1. The runner drops the fade in that case.
   The presets never use it.

## Other Phase 1 choices

- **Output default** (open decision): kept at WAV 32-bit float, 44.1 kHz.
- **Accumulators live on the CPU.** The library keeps the result buffers on the GPU; ours stay
  in RAM so VRAM does not grow with track length or stem count (this matters for the 53-stem
  model).
- **No partial files.** Stems, peaks and the manifest are written to a temp folder next to the
  target and moved into place at the end. A cancel, Ctrl+C, Ctrl+Break or a failure removes the
  temp folder.
- **Verification marker.** A model counts as installed only after a full sha256 pass. The
  result is remembered in `.verified.json` (per file: hash, size, modification time), so a
  700 MB checkpoint is not re-hashed on every run. `openstems models verify` always re-hashes.
- **Peaks** live in a `.peaks` subfolder of each result so the stem folder stays clean.

## Consequences

Phase 2 adds the Mel-Band and MDX23C adapters behind the same port and reuses the runner
unchanged. When the loaders publish a release that includes these models, the git pin can go
back to a version pin.
