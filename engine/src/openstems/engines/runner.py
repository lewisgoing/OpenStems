"""The shared chunked runner.

Ported from the ``demix`` function in ZFTurbo's Music-Source-Separation-Training (MIT),
which the OpenMIRLab loaders also carry as ``demix_track``. One loop gives every model
overlap-add windows, batching, autocast, test-time augmentation, a cancel token, a
progress callback and batch-size backoff on out-of-memory errors.

At batch size 1 the chunk positions, padding and windows match the loaders' own
``demix_track`` exactly, which is what the null test checks.
"""

from __future__ import annotations

import gc
from collections.abc import Callable, Sequence
from contextlib import nullcontext
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from openstems.domain.errors import Cancelled
from openstems.domain.quality import RunSettings
from openstems.engines.base import CancelToken, ProgressFn

# A model call: (batch, channels, chunk) -> (batch, stems, channels, chunk),
# or (batch, channels, chunk) for a single stem.
ModelFn = Callable[[torch.Tensor], torch.Tensor]


def _window(chunk_size: int, fade_size: int) -> torch.Tensor:
    window = torch.ones(chunk_size)
    if fade_size > 0:
        window[-fade_size:] *= torch.linspace(1, 0, fade_size)
        window[:fade_size] *= torch.linspace(0, 1, fade_size)
    return window


def _is_oom(exc: BaseException) -> bool:
    if isinstance(exc, torch.OutOfMemoryError):
        return True
    return isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower()


def demix(
    model_fn: ModelFn,
    mix: torch.Tensor,
    *,
    num_stems: int,
    chunk_size: int,
    num_overlap: int,
    batch_size: int = 1,
    device: torch.device | str = "cpu",
    autocast: bool = False,
    keep: Sequence[int] | None = None,
    progress: ProgressFn | None = None,
    cancel: CancelToken | None = None,
) -> torch.Tensor:
    """Run ``model_fn`` over ``mix`` (channels, samples) in overlapping chunks.

    Returns a CPU float32 tensor ``(len(keep) or num_stems, channels, samples)``.
    The accumulators live on the CPU so VRAM use does not grow with track length or
    stem count; ``keep`` selects which stem indices are accumulated at all.
    """
    device = torch.device(device)
    C = int(chunk_size)
    step = max(1, C // max(1, int(num_overlap)))
    # Without overlap a fade would leave zero weight at every chunk edge, so only fade
    # when a neighbouring chunk covers the faded region.
    fade_size = C // 10 if step < C else 0
    border = C - step
    channels, original_length = mix.shape
    keep_idx = list(range(num_stems)) if keep is None else list(keep)

    mix = mix.to(torch.float32)
    padded = original_length > 2 * border and border > 0
    if padded:
        mix = F.pad(mix, (border, border), mode="reflect")
    total = mix.shape[1]

    window = _window(C, fade_size)
    result = torch.zeros((len(keep_idx), channels, total), dtype=torch.float32)
    counter = torch.zeros(total, dtype=torch.float32)

    starts = list(range(0, total, step))
    amp = (
        torch.autocast(device_type="cuda") if autocast and device.type == "cuda" else nullcontext()
    )
    batch = max(1, int(batch_size))
    done = 0

    def make_part(i: int) -> tuple[torch.Tensor, int]:
        part = mix[:, i : i + C]
        length = part.shape[-1]
        if length < C:
            mode = "reflect" if length > C // 2 + 1 else "constant"
            part = F.pad(part, (0, C - length), mode=mode)
        return part, length

    def run(parts: list[torch.Tensor]) -> torch.Tensor:
        x = torch.stack(parts).to(device, non_blocking=True)
        with torch.inference_mode(), amp:
            y = model_fn(x)
        if y.dim() == 3:
            y = y.unsqueeze(1)
        return y[:, keep_idx].float().cpu()

    pos = 0
    retried_single = False
    while pos < len(starts):
        if cancel is not None:
            cancel.raise_if_cancelled()
        group = starts[pos : pos + batch]
        parts_lengths = [make_part(i) for i in group]
        try:
            out = run([p for p, _ in parts_lengths])
        except Exception as exc:
            if not _is_oom(exc) or (batch == 1 and retried_single):
                raise
            # Out of memory: free what we can, then halve the batch and retry these chunks.
            # At batch 1 there is nothing to halve, so retry once after the cleanup.
            del exc
            gc.collect()
            if device.type == "cuda":
                torch.cuda.empty_cache()
            if batch == 1:
                retried_single = True
            batch = max(1, batch // 2)
            continue

        for k, i in enumerate(group):
            length = parts_lengths[k][1]
            w = window
            if fade_size and i == 0:
                w = window.clone()
                w[:fade_size] = 1
            elif fade_size and i + C >= total:
                w = window.clone()
                w[-fade_size:] = 1
            # A model whose chunk is not a multiple of its STFT hop returns slightly
            # fewer samples than it was given; the next chunk's overlap covers the gap.
            valid = min(length, out.shape[-1])
            result[..., i : i + valid] += out[k][..., :valid] * w[:valid]
            counter[i : i + valid] += w[:valid]

        pos += len(group)
        done += len(group)
        if progress is not None:
            progress(done / len(starts))

    result /= counter.clamp_min(1e-8)
    torch.nan_to_num_(result, nan=0.0)
    if padded:
        result = result[..., border:-border]
    return result.contiguous()


def demix_tta(
    model_fn: ModelFn,
    mix: torch.Tensor,
    *,
    progress: ProgressFn | None = None,
    **kwargs: Any,
) -> torch.Tensor:
    """Test-time augmentation as in MSST: average the plain run with a channel-swapped
    run and a polarity-inverted run (each undone before averaging)."""
    variants: list[tuple[Callable[[torch.Tensor], torch.Tensor], Callable]] = [
        (lambda m: m, lambda r: r),
        (lambda m: m.flip(0), lambda r: r.flip(1)),
        (lambda m: -m, lambda r: -r),
    ]
    total: torch.Tensor | None = None
    for n, (augment, undo) in enumerate(variants):

        def sub(fraction: float, n: int = n) -> None:
            if progress is not None:
                progress((n + fraction) / len(variants))

        out = undo(demix(model_fn, augment(mix), progress=sub, **kwargs))
        total = out if total is None else total.add_(out)
    assert total is not None
    return total.div_(len(variants))


def run_model(
    model_fn: ModelFn,
    mix: np.ndarray,
    settings: RunSettings,
    *,
    stems: Sequence[str],
    device: torch.device | str,
    progress: ProgressFn | None = None,
    cancel: CancelToken | None = None,
    only: frozenset[str] | None = None,
) -> dict[str, np.ndarray]:
    """Adapter-facing entry point: numpy in, a dict of numpy stems out."""
    wanted = [i for i, name in enumerate(stems) if only is None or name in only]
    if not wanted:
        return {}
    kwargs: dict[str, Any] = dict(
        num_stems=len(stems),
        chunk_size=settings.chunk_size,
        num_overlap=settings.num_overlap,
        batch_size=settings.batch_size,
        device=device,
        autocast=settings.precision == "fp16",
        keep=wanted,
        cancel=cancel,
    )
    tensor = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32))
    try:
        if settings.tta:
            out = demix_tta(model_fn, tensor, progress=progress, **kwargs)
        else:
            out = demix(model_fn, tensor, progress=progress, **kwargs)
    except Cancelled:
        raise
    finally:
        if torch.device(device).type == "cuda":
            torch.cuda.empty_cache()
    array = out.numpy()
    return {stems[i]: np.ascontiguousarray(array[k]) for k, i in enumerate(wanted)}
