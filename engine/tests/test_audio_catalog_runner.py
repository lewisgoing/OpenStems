"""Audio I/O, the catalog and store, the downloader and the chunked runner (CPU)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest
import torch

from openstems.audio.decode import DecodeError, decode, probe, resample
from openstems.audio.write import compute_peaks, read_audio, write_audio
from openstems.catalog.catalog import builtin_models, load_catalog
from openstems.catalog.download import DownloadError, download_file
from openstems.catalog.store import ModelNotInstalled, ModelStore
from openstems.domain.errors import Cancelled
from openstems.domain.model import ModelFile, ModelSpec
from openstems.domain.quality import RunSettings
from openstems.engines.base import CancelToken
from openstems.engines.runner import demix, run_model
from openstems.recipes import load_recipes
from tests.conftest import RATE, tone

# -- audio ---------------------------------------------------------------------


def test_float_wav_round_trip_is_exact(tmp_path: Path) -> None:
    audio = tone(0.5)
    write_audio(tmp_path / "a.wav", audio, RATE, "wav32f")
    assert np.array_equal(decode(tmp_path / "a.wav"), audio)
    back, rate = read_audio(tmp_path / "a.wav")
    assert rate == RATE and np.array_equal(back, audio)


@pytest.mark.parametrize(("fmt", "ext"), [("wav24", ".wav"), ("flac", ".flac"), ("mp3", ".mp3")])
def test_other_formats_write_and_decode(tmp_path: Path, fmt: str, ext: str) -> None:
    audio = tone(0.5)
    path = tmp_path / f"a{ext}"
    write_audio(path, audio, RATE, fmt)
    back = decode(path)
    assert back.shape[0] == 2
    if fmt != "mp3":
        assert back.shape == audio.shape
        assert np.max(np.abs(back - audio)) < 1e-4
    assert probe(path).sample_rate == RATE


def test_mono_and_other_rates_become_44k_stereo(tmp_path: Path) -> None:
    import soundfile as sf

    mono = tone(0.5)[0]
    sf.write(str(tmp_path / "m.wav"), mono, 48000, subtype="FLOAT")
    out = decode(tmp_path / "m.wav")
    assert out.shape[0] == 2 and abs(out.shape[1] - len(mono) * 44100 / 48000) < 64
    np.testing.assert_allclose(out[0], out[1])


def test_decode_errors(tmp_path: Path) -> None:
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"not audio at all")
    with pytest.raises(DecodeError):
        decode(bad)
    with pytest.raises(DecodeError):
        probe(tmp_path / "missing.wav")


def test_resample_round_trip_length() -> None:
    audio = tone(0.5)
    up = resample(audio, 44100, 48000)
    assert abs(up.shape[1] - audio.shape[1] * 48000 / 44100) < 64


def test_peaks_shape() -> None:
    peaks = compute_peaks(tone(2.0), RATE)
    assert peaks["length"] * 2 == len(peaks["data"])
    assert peaks["samples"] == 2 * RATE
    data = peaks["data"]
    assert all(lo <= hi for lo, hi in zip(data[0::2], data[1::2], strict=True))
    assert compute_peaks(np.zeros((2, 0), dtype=np.float32), RATE)["length"] == 0


# -- catalog and store ---------------------------------------------------------


def test_builtin_catalog_and_recipes_are_consistent() -> None:
    catalog = load_catalog()
    assert "bs-roformer-sw" in catalog
    sw = catalog.get("bs-roformer-sw")
    assert set(sw.stems) == {"vocals", "drums", "bass", "guitar", "piano", "other"}
    for spec in builtin_models().values():
        assert spec.checkpoint.url.startswith("https://"), spec.id
    recipes = load_recipes(catalog)  # raises if a recipe names a stem its model lacks
    assert [o.name for o in recipes["full-song"].outputs] == [
        "vocals", "drums", "bass", "guitar", "piano", "other",
    ]  # fmt: skip


def real_spec(tmp_path: Path, payload: bytes = b"weights" * 100) -> tuple[ModelSpec, bytes]:
    file = ModelFile(
        "checkpoint", "m.ckpt", "https://example.com/m.ckpt",
        hashlib.sha256(payload).hexdigest(), len(payload),
    )  # fmt: skip
    spec = ModelSpec(
        id="m", name="m", architecture="fake", loader="fake", files=(file,), stems=("a",)
    )
    return spec, payload


def test_store_status_verify_and_require(tmp_path: Path) -> None:
    spec, payload = real_spec(tmp_path)
    store = ModelStore(tmp_path / "models")
    assert store.status(spec) == "missing"
    with pytest.raises(ModelNotInstalled):
        store.require(spec)

    path = store.checkpoint_path(spec)
    path.parent.mkdir(parents=True)
    path.write_bytes(payload)
    assert store.status(spec) == "unverified"
    store.require(spec)  # verifies once and writes the marker
    assert store.status(spec) == "installed"

    path.write_bytes(payload[:-1] + b"X")  # same size, different bytes
    assert store.status(spec) != "installed"  # mtime changed: marker no longer trusted
    assert store.verify(spec) and store.status(spec) == "unverified"
    with pytest.raises(ModelNotInstalled):
        store.require(spec)

    assert store.delete(spec) and store.status(spec) == "missing"


def serve_bytes(payload: bytes, *, ignore_range: bool = False) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        rng = request.headers.get("range")
        if rng and not ignore_range:
            start = int(rng.removeprefix("bytes=").split("-")[0])
            return httpx.Response(206, content=payload[start:])
        return httpx.Response(200, content=payload)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_download_verifies_and_renames(tmp_path: Path) -> None:
    spec, payload = real_spec(tmp_path)
    dest = tmp_path / "m.ckpt"
    seen: list[int] = []
    download_file(spec.checkpoint, dest, seen.append, client=serve_bytes(payload))
    assert dest.read_bytes() == payload and sum(seen) == len(payload)
    assert not dest.with_name("m.ckpt.part").exists()


@pytest.mark.parametrize("ignore_range", [False, True])
def test_download_resumes_a_partial_file(tmp_path: Path, ignore_range: bool) -> None:
    spec, payload = real_spec(tmp_path)
    dest = tmp_path / "m.ckpt"
    dest.with_name("m.ckpt.part").write_bytes(payload[:300])
    download_file(spec.checkpoint, dest, client=serve_bytes(payload, ignore_range=ignore_range))
    assert dest.read_bytes() == payload


def test_download_rejects_a_wrong_hash(tmp_path: Path) -> None:
    spec, payload = real_spec(tmp_path)
    dest = tmp_path / "m.ckpt"
    with pytest.raises(DownloadError, match="sha256 mismatch"):
        download_file(spec.checkpoint, dest, client=serve_bytes(payload[::-1]))
    assert not dest.exists() and not dest.with_name("m.ckpt.part").exists()


def test_download_can_be_cancelled(tmp_path: Path) -> None:
    spec, payload = real_spec(tmp_path)
    with pytest.raises(Cancelled):
        download_file(
            spec.checkpoint, tmp_path / "m.ckpt", should_cancel=lambda: True,
            client=serve_bytes(payload),
        )  # fmt: skip


def test_marker_is_json(tmp_path: Path) -> None:
    spec, payload = real_spec(tmp_path)
    store = ModelStore(tmp_path / "models")
    path = store.checkpoint_path(spec)
    path.parent.mkdir(parents=True)
    path.write_bytes(payload)
    assert store.verify(spec) == []
    marker = json.loads((path.parent / ".verified.json").read_text("utf-8"))
    assert marker["m.ckpt"]["sha256"] == spec.checkpoint.sha256


# -- the chunked runner --------------------------------------------------------


def identity_two_stems(x: torch.Tensor) -> torch.Tensor:
    """A 'model' whose stems are 0.25x and 0.75x of its input: overlap-add must rebuild them."""
    return torch.stack([x * 0.25, x * 0.75], dim=1)


@pytest.mark.parametrize("samples", [100, 999, 4000, 12345])
@pytest.mark.parametrize("overlap", [1, 2, 4])
@pytest.mark.parametrize("batch", [1, 3])
def test_overlap_add_rebuilds_the_signal(samples: int, overlap: int, batch: int) -> None:
    mix = torch.from_numpy(
        np.random.default_rng(1).standard_normal((2, samples)).astype(np.float32)
    )
    out = demix(
        identity_two_stems, mix, num_stems=2, chunk_size=1000, num_overlap=overlap, batch_size=batch
    )
    assert out.shape == (2, 2, samples)
    torch.testing.assert_close(out[0], mix * 0.25, atol=1e-5, rtol=1e-4)
    torch.testing.assert_close(out[1], mix * 0.75, atol=1e-5, rtol=1e-4)


def test_batched_output_matches_unbatched() -> None:
    mix = torch.from_numpy(np.random.default_rng(2).standard_normal((2, 9000)).astype(np.float32))
    kwargs: dict[str, Any] = dict(num_stems=2, chunk_size=1000, num_overlap=4)
    a = demix(identity_two_stems, mix, batch_size=1, **kwargs)
    b = demix(identity_two_stems, mix, batch_size=5, **kwargs)
    torch.testing.assert_close(a, b, atol=1e-6, rtol=1e-5)


def test_short_model_output_is_tolerated() -> None:
    mix = torch.ones((2, 5000))
    out = demix(lambda x: x[..., :-7], mix, num_stems=1, chunk_size=1000, num_overlap=2)
    assert out.shape == (1, 2, 5000)
    torch.testing.assert_close(out[0], mix, atol=1e-5, rtol=1e-4)


def test_keep_selects_stems_and_progress_is_monotonic() -> None:
    mix = torch.ones((2, 5000))
    seen: list[float] = []
    out = demix(
        identity_two_stems, mix, num_stems=2, chunk_size=1000, num_overlap=2, keep=[1],
        progress=seen.append,
    )  # fmt: skip
    assert out.shape == (1, 2, 5000)
    assert seen == sorted(seen) and seen[-1] == 1.0


def test_cancel_stops_the_loop() -> None:
    cancel = CancelToken()
    calls = 0

    def model(x: torch.Tensor) -> torch.Tensor:
        nonlocal calls
        calls += 1
        if calls == 2:
            cancel.cancel()
        return x

    with pytest.raises(Cancelled):
        demix(
            model,
            torch.ones((2, 50000)),
            num_stems=1,
            chunk_size=1000,
            num_overlap=2,
            cancel=cancel,
        )
    assert calls == 2


def test_out_of_memory_halves_the_batch() -> None:
    sizes: list[int] = []

    def model(x: torch.Tensor) -> torch.Tensor:
        sizes.append(x.shape[0])
        if x.shape[0] > 2:
            raise torch.OutOfMemoryError("CUDA out of memory")
        return x

    mix = torch.ones((2, 20000))
    out = demix(model, mix, num_stems=1, chunk_size=1000, num_overlap=2, batch_size=8)
    torch.testing.assert_close(out[0], mix, atol=1e-5, rtol=1e-4)
    assert sizes[:3] == [8, 4, 2] and max(sizes[2:]) == 2


def test_out_of_memory_at_batch_one_is_retried_once() -> None:
    calls = 0

    def model(x: torch.Tensor) -> torch.Tensor:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise torch.OutOfMemoryError("CUDA out of memory")
        return x

    mix = torch.ones((2, 3000))
    out = demix(model, mix, num_stems=1, chunk_size=1000, num_overlap=2)
    torch.testing.assert_close(out[0], mix, atol=1e-5, rtol=1e-4)


def test_out_of_memory_at_batch_one_is_raised() -> None:
    def model(x: torch.Tensor) -> torch.Tensor:
        raise torch.OutOfMemoryError("CUDA out of memory")

    with pytest.raises(torch.OutOfMemoryError):
        demix(model, torch.ones((2, 3000)), num_stems=1, chunk_size=1000, num_overlap=2)


def test_tta_averages_back_to_the_same_answer_for_a_linear_model() -> None:
    mix = np.random.default_rng(3).standard_normal((2, 6000)).astype(np.float32)
    plain = RunSettings(1000, 2, 2, tta=False, precision="fp32")
    tta = RunSettings(1000, 2, 2, tta=True, precision="fp32")
    seen: list[float] = []
    a = run_model(identity_two_stems, mix, plain, stems=("a", "b"), device="cpu")
    b = run_model(
        identity_two_stems, mix, tta, stems=("a", "b"), device="cpu", progress=seen.append
    )
    np.testing.assert_allclose(a["a"], b["a"], atol=1e-5)
    assert seen == sorted(seen) and seen[-1] == 1.0
    only = run_model(
        identity_two_stems, mix, plain, stems=("a", "b"), device="cpu", only=frozenset({"b"})
    )
    assert list(only) == ["b"]
