"""What differs between the GPU backends: which one is there, and how its memory is handled.

NVIDIA (CUDA) and AMD (ROCm) builds both answer through ``torch.cuda``. Apple Silicon answers
through ``torch.mps`` and the device is called "mps". Everything else in the engine asks here
instead of branching on the vendor.
"""

from __future__ import annotations

import torch

GPU_TYPES = ("cuda", "mps")


def mps_available() -> bool:
    """Whether this PyTorch can run on the Apple GPU. False on every Windows build."""
    try:
        return bool(torch.backends.mps.is_available())
    except Exception:
        return False


def gpu_device_name() -> str | None:
    """The device a GPU build runs on, whatever the settings say: "cuda", "mps" or None.
    The doctor and the self-test use it; separation asks ``torch_common.pick_device``."""
    if torch.cuda.is_available():
        return "cuda"
    if mps_available():
        return "mps"
    return None


def is_gpu(device: torch.device | str) -> bool:
    return torch.device(device).type in GPU_TYPES


def empty_cache(device: torch.device | str) -> None:
    """Hand cached GPU memory back. Nothing to do on the CPU."""
    kind = torch.device(device).type
    if kind == "cuda":
        torch.cuda.empty_cache()
    elif kind == "mps":
        torch.mps.empty_cache()


def synchronize(device: torch.device | str) -> None:
    """Wait for the GPU to finish what it was given, so a timing is honest."""
    kind = torch.device(device).type
    if kind == "cuda":
        torch.cuda.synchronize()
    elif kind == "mps":
        torch.mps.synchronize()


def is_oom(exc: BaseException, device: torch.device | str = "cpu") -> bool:
    """Whether an error means the device ran out of memory.

    CUDA raises ``torch.OutOfMemoryError``. MPS raises a plain ``RuntimeError``: "MPS backend
    out of memory (MPS allocated: ...)", or "Invalid buffer size: ..." when one buffer is
    larger than Metal allows (the wording in PyTorch's ``MPSAllocator.mm``). A smaller batch
    is the answer to both.
    """
    if isinstance(exc, torch.OutOfMemoryError):
        return True
    if not isinstance(exc, RuntimeError):
        return False
    text = str(exc).lower()
    if "out of memory" in text:
        return True
    return torch.device(device).type == "mps" and "invalid buffer size" in text


def used_memory_bytes(device: torch.device | str) -> int:
    """GPU memory in use by this process, for the benchmark. On CUDA the peak since the last
    ``reset_peak_memory``; MPS keeps no peak, so there it is what the Metal driver holds now
    (cached blocks included, which makes it close to the peak right after a run)."""
    kind = torch.device(device).type
    if kind == "cuda":
        return int(torch.cuda.max_memory_allocated())
    if kind == "mps":
        return int(torch.mps.driver_allocated_memory())
    return 0


def reset_peak_memory(device: torch.device | str) -> None:
    kind = torch.device(device).type
    if kind == "cuda":
        torch.cuda.reset_peak_memory_stats()
    elif kind == "mps":
        torch.mps.empty_cache()
