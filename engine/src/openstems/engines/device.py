"""What differs between the GPU backends: which one is there, and how its memory is handled.

NVIDIA (CUDA) and AMD (ROCm) builds both answer through ``torch.cuda``. Apple Silicon answers
through ``torch.mps`` and the device is called "mps". Everything else in the engine asks here
instead of branching on the vendor.
"""

from __future__ import annotations

import torch

from openstems.domain.memory import MemoryPlan, plan_memory
from openstems.procutil import memory_override_bytes, physical_memory_bytes

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
    is the answer to both. On the CPU it is Python's ``MemoryError`` or a ``RuntimeError``
    from the allocator: "not enough memory: you tried to allocate ...".
    """
    if isinstance(exc, (torch.OutOfMemoryError, MemoryError)):
        return True
    if not isinstance(exc, RuntimeError):
        return False
    text = str(exc).lower()
    if "out of memory" in text or "not enough memory" in text:
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


def detected_memory_bytes(device: torch.device | str) -> int | None:
    """The memory a model on this device lives in: the card's own on CUDA and ROCm, the
    machine's on a Mac (the GPU shares it) and on the CPU."""
    if torch.device(device).type == "cuda":
        try:
            return int(torch.cuda.get_device_properties(device).total_memory)
        except Exception:
            return None
    return physical_memory_bytes()


def memory_plan(device: torch.device | str) -> MemoryPlan:
    """What one model run may use on this device and at which precision it runs there.
    ``OPENSTEMS_MEMORY_GB`` stands in for the detected memory."""
    from openstems.engines.runner import use_half_precision

    kind = torch.device(device).type
    return plan_memory(
        kind if kind in GPU_TYPES else "cpu",
        detected_memory_bytes(device),
        full_precision=not use_half_precision(device),
        override_bytes=memory_override_bytes(),
    )
