# 0001: Verified stack versions

Date: 2026-11-20. Status: accepted.

## Context

`PLAN.md` asks for every named library to be checked against current docs before use, and for
exact versions to be pinned in lockfiles. This records what was checked in Phase 0 and where the
plan needed correcting.

## Verified on the target machine

`uv run openstems doctor` on Windows 11, RTX 5070 Ti, driver 621.24:

| Item | Value |
| --- | --- |
| Python | 3.12.13 (uv-managed) |
| uv | 0.13.6 |
| PyTorch | 2.14.1+cu130 (CUDA 13.0), CUDA available, a GPU op runs |
| GPU | NVIDIA GeForce RTX 5070 Ti, 15.9 GB |
| FFmpeg | PyAV 19.0.2 (bundled libavcodec 63.1), FLAC encode/decode round trip ok |
| Tooling | ruff 0.17.6, pyright 1.1.414, pytest 9.2.0, typer 0.29.2 |

Exact versions are pinned in `engine/uv.lock`.

## Checked against package indexes and docs (used in later phases)

| Library | Latest seen | Notes |
| --- | --- | --- |
| bs-roformer-infer | 0.1.5 (MIT) | Python >= 3.10; needs torch >= 2.0 and rotary-embedding-torch |
| melband-roformer-infer | 0.1.5 (MIT) | pulls librosa and numba |
| mdxnet-infer | 0.1.0 (MIT) | pulls librosa |
| audio-separator | 0.48.0 (MIT) | fallback engine only |
| splifft | 0.0.9 (MIT) | still pre-1.0; re-evaluate in the Phase 1 spike |
| FastAPI / uvicorn | 0.165.0 / 0.54.0 | Phase 3 |
| Electron | 45.4.1 | 45 is the current stable line, as the plan says |
| Vite / React / TypeScript | 8.3.8 / 19.3.1 / 7.0.2 | Phase 4 |
| Playwright | 1.65.1 | Phase 4 |

## The plan's four unchecked items

- **PyAV bundling FFmpeg: confirmed.** The PyAV install docs say the binary wheels on PyPI ship
  with FFmpeg bundled for Windows, and the doctor round trip exercises it. PyAV 19 needs
  Python >= 3.12, which matches the engine.
- **Playwright driving Electron: confirmed, experimental.** `_electron.launch` is documented as
  experimental and supports Electron v21+. The `nodeCliInspect` fuse must stay enabled in test
  builds.
- **Multi-file `startDrag`: confirmed, re-check in Phase 4.** `webContents.startDrag(item)` takes
  `files` (string[]), which overrides `file`; `icon` is required. This came from a summarised
  read of the docs page, so the Phase 4 work re-reads the section before relying on it.
- **MVSEP API terms: not checked.** Cloud-only models stay unsupported (the plan's default), so
  nothing depends on it.

## Corrections to the plan

1. **PyTorch version.** The plan says "2.13 or newer from the cu130 index". The cu130 index
   currently tops out at 2.14.1 for cp312/win_amd64 (PyPI's 2.15.0 is not on cu130), so the
   engine pins `torch==2.14.1`.
2. **torchaudio is not used.** Decoding goes through PyAV, so torchaudio and its version coupling
   to torch are left out.
3. **`webUtils.getPathForFile` placement.** With context isolation on, it must be called in the
   preload script and exposed through `contextBridge`. The plan already puts it in the preload.
4. **Disk.** C: has under 30 GB free. Models and outputs are configurable, and this machine
   points `OPENSTEMS_MODELS_DIR` and `OPENSTEMS_OUTPUT_DIR` at D:.
5. **CI installs the cu130 wheel on a CPU runner.** It is a large download but keeps one
   lockfile; torch falls back to CPU there and the `gpu`-marked tests are deselected.
6. **Repo nesting.** The Dev folder is itself a git repository with every project untracked.
   `OpenStems/` has its own `.git` and is not added to the outer repository.

## Consequences

Later phases use these versions unless a newer check says otherwise; changes get their own record.
