"""Environment check: Python, PyTorch, the GPU backend (CUDA, ROCm or MPS), GPU and FFmpeg."""

from __future__ import annotations

import io
import platform
import subprocess
import sys
from dataclasses import asdict, dataclass, field, fields
from typing import Any

from openstems.domain.memory import GB, MemoryPlan, plan_memory
from openstems.procutil import memory_override_bytes, physical_memory_bytes


@dataclass(frozen=True)
class DoctorReport:
    python: str
    torch: str | None
    cuda_available: bool
    cuda_version: str | None
    gpu_name: str | None
    vram_gb: float | None
    ffmpeg: str | None
    ffmpeg_decode_ok: bool
    problems: list[str] = field(default_factory=list)
    # "cuda" (NVIDIA), "rocm" (AMD) or "mps" (Apple Silicon), by how this PyTorch was built;
    # None for a CPU build. The field names are older than the second and third backend and
    # stay for the API's sake: `cuda_available` means "a GPU works" for any of them,
    # `cuda_version` is set only on an NVIDIA build, and on a Mac `vram_gb` is the machine's
    # unified memory, which the GPU shares with everything else.
    gpu_backend: str | None = None
    gpu_backend_version: str | None = None
    # Things worth knowing that are not faults, such as the STFT running on the CPU on a Mac.
    notes: list[str] = field(default_factory=list)
    # The machine's own memory, and whether the GPU runs models at full precision (a Mac,
    # a GTX 900 or 10 series card). Both feed the memory budget (`memory_plan`).
    ram_gb: float | None = None
    full_precision: bool = True

    def memory_plan(self, use_gpu: bool = True) -> MemoryPlan:
        """What one model run may use here: on the GPU when it works and is switched on,
        otherwise on the CPU. ``OPENSTEMS_MEMORY_GB`` stands in for the detected memory."""
        override = memory_override_bytes()
        if use_gpu and self.cuda_available:
            kind = "mps" if self.gpu_backend == "mps" else "cuda"
            detected = int(self.vram_gb * GB) if self.vram_gb else None
            return plan_memory(kind, detected, self.full_precision, override)
        detected = int(self.ram_gb * GB) if self.ram_gb else None
        return plan_memory("cpu", detected, True, override)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DoctorReport:
        """A report read back from JSON. Unknown keys are dropped, so a file written by
        another version still reads; a missing required one raises ``TypeError``."""
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    @property
    def ok(self) -> bool:
        return self.cuda_available and self.ffmpeg_decode_ok

    @property
    def backend_label(self) -> str:
        if self.gpu_backend is None:
            return "none (CPU build)"
        name = BACKEND_NAMES.get(self.gpu_backend, self.gpu_backend)
        return f"{name} {self.gpu_backend_version or ''}".strip()

    def lines(self) -> list[tuple[str, str]]:
        vram = f"{self.vram_gb:.1f} GB" if self.vram_gb is not None else "-"
        plan = self.memory_plan()
        budget = "-"
        if plan.budget_bytes is not None:
            budget = f"{plan.budget_bytes / GB:.1f} GB"
            if plan.overridden:
                budget += f" (OPENSTEMS_MEMORY_GB={(plan.memory_bytes or 0) / GB:g})"
        return [
            ("Python", self.python),
            ("PyTorch", self.torch or "not installed"),
            ("GPU backend", self.backend_label),
            ("GPU available", "yes" if self.cuda_available else "NO"),
            ("GPU", self.gpu_name or "-"),
            ("Memory (shared)" if self.gpu_backend == "mps" else "VRAM", vram),
            ("Memory for one model", budget),
            ("FFmpeg (PyAV)", self.ffmpeg or "not installed"),
            ("FFmpeg decode", "ok" if self.ffmpeg_decode_ok else "FAILED"),
        ]


BACKEND_NAMES = {"cuda": "CUDA", "rocm": "ROCm", "mps": "MPS"}
# The oldest macOS the Mac build supports (PyTorch's own wheel needs it too).
MIN_MACOS = 14

# AMD's PyTorch-on-Windows 7.2.1 support matrix.
ROCM_CARDS = (
    "Radeon RX 9070, RX 9070 XT, RX 9060 XT, RX 7900 XTX, RX 7700, PRO W7900 and AI PRO R9700"
)
ROCM_DRIVER = "26.2.2"


def torch_backend(version_module: object, mps_built: bool = False) -> tuple[str | None, str | None]:
    """Which GPU backend a PyTorch build targets, from ``torch.version`` and, for a Mac
    build, ``torch.backends.mps.is_built()``. MPS has no version of its own: it is part of
    macOS, so the macOS version stands in."""
    hip = getattr(version_module, "hip", None)
    if hip:
        return "rocm", str(hip).split("-")[0]
    cuda = getattr(version_module, "cuda", None)
    if cuda:
        return "cuda", str(cuda)
    if mps_built:
        release = macos_release()
        return "mps", f"macOS {release}" if release else None
    return None, None


def mps_built(torch: object) -> bool:
    """Whether this PyTorch was built with the Apple GPU backend."""
    try:
        return bool(torch.backends.mps.is_built())  # type: ignore[attr-defined]
    except Exception:
        return False


def macos_release() -> str:
    """The macOS version, such as "14.5"; empty when it cannot be read."""
    try:
        return platform.mac_ver()[0]
    except Exception:
        return ""


def _sysctl(name: str) -> str:
    try:
        done = subprocess.run(
            ["/usr/sbin/sysctl", "-n", name],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return done.stdout.strip() if done.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def mac_gpu_name() -> str:
    """The chip, which on Apple Silicon is also the GPU: "Apple M2 Pro". Falls back to
    what Python knows, then to a plain name."""
    name = _sysctl("machdep.cpu.brand_string") if sys.platform == "darwin" else ""
    if not name:
        try:
            name = platform.processor() or ""
        except Exception:
            name = ""
    name = name.strip()
    if not name or name in ("arm", "arm64", "i386"):
        return "Apple GPU"
    return name


def mac_problem(machine: str, release: str) -> str:
    """Why the Apple GPU cannot be used on this Mac."""
    cpu_note = "Separation runs on the CPU, which is much slower."
    if machine and machine not in ("arm64", "aarch64"):
        return (
            "This Mac has an Intel processor. OpenStems needs a Mac with Apple Silicon "
            f"(M1 or later): PyTorch has no GPU support for Intel Macs. {cpu_note}"
        )
    major = release.split(".")[0] if release else ""
    if major.isdigit() and int(major) < MIN_MACOS:
        return (
            f"This Mac runs macOS {release}. The Apple GPU needs macOS {MIN_MACOS} or later: "
            f"update macOS. {cpu_note}"
        )
    return (
        "The Apple GPU (MPS) is not available to PyTorch on this Mac. "
        f"It needs Apple Silicon and macOS {MIN_MACOS} or later. {cpu_note}"
    )


def no_gpu_problem(backend: str | None) -> str:
    if backend == "mps" or (backend is None and sys.platform == "darwin"):
        return mac_problem(platform.machine(), macos_release())
    if backend == "rocm":
        return (
            "This is the AMD build of PyTorch, but it found no supported Radeon GPU. "
            f"Supported: {ROCM_CARDS}, with AMD driver {ROCM_DRIVER} or newer. "
            "Separation runs on the CPU, which is much slower."
        )
    if backend == "cuda":
        return (
            "CUDA is not available to PyTorch: no NVIDIA GPU was found, or its driver is too "
            "old. Separation runs on the CPU, which is much slower."
        )
    return "This PyTorch build has no GPU support. Separation runs on the CPU."


def unsupported_card_problem(name: str, capability: tuple[int, int], cuda: str | None) -> str:
    """The card is there, but this PyTorch build was not compiled for it."""
    major, minor = capability
    if major < 7:
        fix = "Switch the engine build to 'NVIDIA (older)' in Settings > System."
    else:
        fix = "Switch the engine build to 'NVIDIA' in Settings > System."
    return (
        f"This PyTorch build (CUDA {cuda or 'unknown'}) does not support {name} "
        f"(compute capability {major}.{minor}). {fix} "
        "Until then separation runs on the CPU, which is much slower."
    )


def check_gpu_ops(torch: object, device: str = "cuda") -> None:
    """Run the kinds of op every model needs on the GPU and compare with the CPU.

    A build can report a GPU yet lack kernels for the card (a 50-series card on old CUDA
    wheels, a Radeon the ROCm build does not cover). Raises on a failure or a wrong result.
    ``device`` is "cuda" for NVIDIA and AMD, "mps" for a Mac.
    """
    import torch as t

    from openstems.engines.stft_fallback import check_stft

    x = t.ones(8, device=device)
    if float((x * 2).sum().item()) != 16.0:
        raise RuntimeError("wrong result from a GPU op")
    # The separation models all start and end with an STFT on the GPU.
    check_stft(device)


def check_ffmpeg_decode() -> tuple[str | None, bool, str | None]:
    """Encode a short tone to FLAC in memory and decode it back through PyAV."""
    try:
        import av
        import numpy as np
    except ImportError as exc:
        return None, False, f"PyAV import failed: {exc}"

    version = (
        f"PyAV {av.__version__}, libavcodec {'.'.join(map(str, av.library_versions['libavcodec']))}"
    )
    try:
        rate = 44100
        t = np.arange(rate // 10, dtype=np.float32) / rate
        tone = (0.25 * np.sin(2 * np.pi * 440.0 * t) * 32767).astype(np.int16)
        stereo = np.stack([tone, tone])  # planar: (channels, samples)

        buf = io.BytesIO()
        with av.open(buf, mode="w", format="flac") as out:
            stream = out.add_stream("flac", rate=rate)
            stream.layout = "stereo"  # type: ignore[attr-defined]
            stream.format = "s16"  # type: ignore[attr-defined]
            frame = av.AudioFrame.from_ndarray(
                np.ascontiguousarray(stereo.T.reshape(1, -1)), format="s16", layout="stereo"
            )
            frame.sample_rate = rate
            for packet in stream.encode(frame):  # type: ignore[attr-defined]
                out.mux(packet)
            for packet in stream.encode(None):  # type: ignore[attr-defined]
                out.mux(packet)

        buf.seek(0)
        decoded = 0
        with av.open(buf, mode="r") as inp:
            for frame in inp.decode(audio=0):
                decoded += frame.samples
        if decoded != tone.shape[0]:
            return version, False, f"decoded {decoded} samples, expected {tone.shape[0]}"
        return version, True, None
    except Exception as exc:
        return version, False, f"FFmpeg round trip failed: {exc!r}"


def run_doctor() -> DoctorReport:
    problems: list[str] = []
    torch_version: str | None = None
    cuda_available = False
    cuda_version: str | None = None
    gpu_name: str | None = None
    vram_gb: float | None = None
    backend: str | None = None
    backend_version: str | None = None
    notes: list[str] = []
    full_precision = True
    ram = physical_memory_bytes()

    try:
        import torch

        torch_version = torch.__version__
        cuda_version = torch.version.cuda
        backend, backend_version = torch_backend(torch.version, mps_built(torch))
        cuda_available = bool(torch.cuda.is_available())
        from openstems.engines.device import mps_available
        from openstems.engines.torch_common import card_supported

        if backend == "mps":
            cuda_available = mps_available()
            if cuda_available:
                gpu_name = mac_gpu_name()
                vram_gb = ram / 1024**3 if ram else None
                try:
                    check_mps(torch, notes)
                except Exception as exc:
                    cuda_available = False
                    problems.append(
                        f"The Apple GPU is reported but a GPU op failed: {exc!r}. "
                        "Turn off 'Use the GPU' in Settings to run on the CPU."
                    )
            else:
                problems.append(no_gpu_problem(backend))
        elif cuda_available and backend == "cuda" and not card_supported():
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
            cuda_available = False
            problems.append(
                unsupported_card_problem(
                    gpu_name, torch.cuda.get_device_capability(0), cuda_version
                )
            )
        elif cuda_available:
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
            from openstems.engines.runner import use_half_precision

            full_precision = not use_half_precision("cuda")
            try:
                check_gpu_ops(torch)
            except Exception as exc:
                cuda_available = False
                problems.append(
                    f"The GPU is reported but a GPU op failed: {exc!r}. "
                    "Turn off 'Use the GPU' in Settings to run on the CPU."
                )
        else:
            problems.append(no_gpu_problem(backend))
    except ImportError as exc:
        problems.append(f"PyTorch import failed: {exc}")

    ffmpeg, decode_ok, ffmpeg_problem = check_ffmpeg_decode()
    if ffmpeg_problem:
        problems.append(ffmpeg_problem)

    return DoctorReport(
        python=f"{platform.python_version()} ({platform.system()} {platform.machine()})",
        torch=torch_version,
        cuda_available=cuda_available,
        cuda_version=cuda_version,
        gpu_name=gpu_name,
        vram_gb=vram_gb,
        ffmpeg=ffmpeg,
        ffmpeg_decode_ok=decode_ok,
        problems=problems,
        gpu_backend=backend,
        gpu_backend_version=backend_version,
        notes=notes,
        ram_gb=ram / 1024**3 if ram else None,
        full_precision=full_precision,
    )


def check_mps(torch: object, notes: list[str]) -> None:
    """The GPU check for a Mac. A broken STFT is not a fault there: the engine moves that
    one step to the CPU (``engines/stft_fallback.py``) and the report says so. Anything
    else that fails is raised, as on the other backends."""
    from openstems.engines.stft_fallback import ensure_stft

    note = ensure_stft("mps")
    if note:
        notes.append(note)
    check_gpu_ops(torch, "mps")  # with the patch in, the STFT part passes on the CPU
