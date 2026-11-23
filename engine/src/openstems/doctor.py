"""Environment check: Python, PyTorch, the GPU backend (CUDA or ROCm), GPU and FFmpeg."""

from __future__ import annotations

import io
import platform
from dataclasses import dataclass, field


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
    # "cuda" (NVIDIA) or "rocm" (AMD), by how this PyTorch was built; None for a CPU build.
    # ROCm builds answer through torch.cuda too, so `cuda_available` means "a GPU works"
    # for either vendor.
    gpu_backend: str | None = None
    gpu_backend_version: str | None = None

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
        return [
            ("Python", self.python),
            ("PyTorch", self.torch or "not installed"),
            ("GPU backend", self.backend_label),
            ("GPU available", "yes" if self.cuda_available else "NO"),
            ("GPU", self.gpu_name or "-"),
            ("VRAM", vram),
            ("FFmpeg (PyAV)", self.ffmpeg or "not installed"),
            ("FFmpeg decode", "ok" if self.ffmpeg_decode_ok else "FAILED"),
        ]


BACKEND_NAMES = {"cuda": "CUDA", "rocm": "ROCm"}

# AMD's PyTorch-on-Windows 7.2.1 support matrix.
ROCM_CARDS = (
    "Radeon RX 9070, RX 9070 XT, RX 9060 XT, RX 7900 XTX, RX 7700, PRO W7900 and AI PRO R9700"
)
ROCM_DRIVER = "26.2.2"


def torch_backend(version_module: object) -> tuple[str | None, str | None]:
    """Which GPU backend a PyTorch build targets, from ``torch.version``."""
    hip = getattr(version_module, "hip", None)
    if hip:
        return "rocm", str(hip).split("-")[0]
    cuda = getattr(version_module, "cuda", None)
    if cuda:
        return "cuda", str(cuda)
    return None, None


def no_gpu_problem(backend: str | None) -> str:
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


def check_gpu_ops(torch: object) -> None:
    """Run the kinds of op every model needs on the GPU and compare with the CPU.

    A build can report a GPU yet lack kernels for the card (a 50-series card on old CUDA
    wheels, a Radeon the ROCm build does not cover). Raises on a failure or a wrong result.
    """
    import torch as t

    x = t.ones(8, device="cuda")
    if float((x * 2).sum().item()) != 16.0:
        raise RuntimeError("wrong result from a GPU op")
    # The separation models all start and end with an STFT on the GPU.
    gen = t.Generator().manual_seed(0)
    wave = t.randn(2, 16384, generator=gen)
    window = t.hann_window(1024)
    expected = t.stft(wave, 1024, 256, window=window, return_complex=True)
    got = t.stft(wave.cuda(), 1024, 256, window=window.cuda(), return_complex=True)
    if float((got.cpu() - expected).abs().max()) > 1e-2:
        raise RuntimeError("the GPU STFT does not match the CPU STFT")
    back = t.istft(got, 1024, 256, window=window.cuda(), length=wave.shape[-1])
    if float((back.cpu() - wave).abs().max()) > 1e-3:
        raise RuntimeError("the GPU inverse STFT does not rebuild the signal")


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

    try:
        import torch

        torch_version = torch.__version__
        cuda_version = torch.version.cuda
        backend, backend_version = torch_backend(torch.version)
        cuda_available = bool(torch.cuda.is_available())
        if cuda_available:
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
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
    )
