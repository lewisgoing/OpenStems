"""A safety net for the STFT on Apple's GPU.

Every model starts with ``torch.stft`` and ends with ``torch.istft`` on its own device, and
the RoFormer loaders have no way round them. The MPS backend's FFT has a history of wrong
results and missing cases. So on "mps" the engine checks both against the CPU once per
process, before the first model runs. If they raise or do not match, ``torch.stft`` and
``torch.istft`` are replaced for the rest of the process by versions that do the transform on
the CPU for MPS inputs and move the result back. The network itself stays on the GPU.

Nothing here runs on Windows: the check and the patch are only reached for an "mps" device.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

import torch

log = logging.getLogger(__name__)

Applies = Callable[[torch.Tensor], bool]

_lock = threading.Lock()
# (torch.stft, torch.functional.stft, torch.istft) as they were before the patch.
_originals: tuple[Any, Any, Any] | None = None
# None until the check ran; then why the patch went in, or "" when native is fine.
_reason: str | None = None


def check_stft(device: torch.device | str) -> None:
    """An STFT round trip on ``device``, compared with the CPU. Raises on a failure or a
    wrong result. The sizes are small; the models use the same call shape."""
    gen = torch.Generator().manual_seed(0)
    wave = torch.randn(2, 16384, generator=gen)
    window = torch.hann_window(1024)
    on_device = window.to(device)
    expected = torch.stft(wave, 1024, 256, window=window, return_complex=True)
    got = torch.stft(wave.to(device), 1024, 256, window=on_device, return_complex=True)
    if got.shape != expected.shape or float((got.cpu() - expected).abs().max()) > 1e-2:
        raise RuntimeError("the GPU STFT does not match the CPU STFT")
    back = torch.istft(got, 1024, 256, window=on_device, length=wave.shape[-1])
    if back.shape != wave.shape or float((back.cpu() - wave).abs().max()) > 1e-3:
        raise RuntimeError("the GPU inverse STFT does not rebuild the signal")


def _on_mps(tensor: torch.Tensor) -> bool:
    return tensor.device.type == "mps"


def on_cpu(original: Callable[..., Any], applies: Applies = _on_mps) -> Callable[..., Any]:
    """Wrap ``torch.stft`` or ``torch.istft``: when ``applies(input)``, run it on the CPU and
    move the result to the input's device. Any other input goes straight through."""

    def moved(value: Any) -> Any:
        return value.cpu() if isinstance(value, torch.Tensor) else value

    def wrapper(input: torch.Tensor, *args: Any, **kwargs: Any) -> Any:
        if not isinstance(input, torch.Tensor) or not applies(input):
            return original(input, *args, **kwargs)
        out = original(
            input.cpu(),
            *(moved(a) for a in args),  # the window may be passed by position
            **{key: moved(value) for key, value in kwargs.items()},
        )
        return out.to(input.device)

    wrapper.__name__ = getattr(original, "__name__", "stft")
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original  # type: ignore[attr-defined]
    return wrapper


def installed() -> bool:
    return _originals is not None


def install(applies: Applies = _on_mps) -> None:
    """Replace ``torch.stft`` and ``torch.istft`` for the whole process. Safe to call twice."""
    global _originals
    with _lock:
        if _originals is not None:
            return
        _originals = (torch.stft, torch.functional.stft, torch.istft)
        stft = on_cpu(torch.stft, applies)
        torch.stft = stft
        # The same function under its second name, which ``Tensor.stft`` does not use but
        # other code may.
        torch.functional.stft = stft
        torch.istft = on_cpu(torch.istft, applies)


def uninstall() -> None:
    """Put the real functions back and forget the check (for tests)."""
    global _originals, _reason
    with _lock:
        if _originals is not None:
            torch.stft, torch.functional.stft, torch.istft = _originals
            _originals = None
        _reason = None


def ensure_stft(
    device: torch.device | str, check: Callable[[Any], None] | None = None
) -> str | None:
    """Make sure the STFT can be trusted on ``device`` before a model runs there.

    Only "mps" is checked: CUDA and ROCm are left as they always were. The check runs once
    per process. Returns None when the native STFT is used, or a sentence for the user when
    the CPU does it instead. ``check`` stands in for ``check_stft`` in tests.
    """
    global _reason
    if torch.device(device).type != "mps":
        return None
    with _lock:
        known = _reason
    if known is None:
        try:
            (check or check_stft)(device)
            known = ""
        except Exception as exc:
            install()
            known = f"{type(exc).__name__}: {exc}"
            log.warning(
                "The STFT on the Apple GPU failed its check (%s). "
                "It runs on the CPU from now on; the models stay on the GPU.",
                known,
            )
        with _lock:
            _reason = known
    return fallback_note()


def fallback_note() -> str | None:
    """The sentence the doctor shows when the patch is in, else None."""
    if not installed():
        return None
    return (
        "The STFT on the Apple GPU did not match the CPU"
        f"{f' ({_reason})' if _reason else ''}, so that step runs on the CPU. "
        "The models still run on the GPU."
    )
