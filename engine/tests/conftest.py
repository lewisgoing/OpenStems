"""Shared fixtures: a fake catalog, short synthetic audio, an isolated config folder."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

from openstems.audio.write import write_audio
from openstems.catalog.catalog import Catalog
from openstems.catalog.store import ModelStore
from openstems.domain.model import ModelFile, ModelSpec
from openstems.engines.host import ModelHost
from openstems.pipeline.run import Pipeline

RATE = 44100


def fake_spec(model_id: str, stems: tuple[str, ...], chunk_size: int = 22050) -> ModelSpec:
    return ModelSpec(
        id=model_id,
        name=model_id,
        architecture="fake",
        loader="fake",
        files=(
            ModelFile("checkpoint", f"{model_id}.ckpt", "https://example.com/x", "ab" * 32, 1000),
        ),
        stems=stems,
        chunk_size=chunk_size,
        num_overlap=2,
        seed=True,
    )


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Never touch the real settings, models or outputs from a test."""
    monkeypatch.setenv("OPENSTEMS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("OPENSTEMS_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("OPENSTEMS_OUTPUT_DIR", str(tmp_path / "outputs"))
    monkeypatch.setenv("OPENSTEMS_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.delenv("OPENSTEMS_ENGINE", raising=False)
    monkeypatch.delenv("OPENSTEMS_FAKE_DELAY", raising=False)
    # The machine's real memory must not decide a test: nothing pretends, nothing runs out.
    monkeypatch.delenv("OPENSTEMS_MEMORY_GB", raising=False)
    monkeypatch.delenv("OPENSTEMS_FAKE_OOM", raising=False)
    if sys.platform == "darwin":
        # The unit tests run on the CPU. A Mac that reports its GPU would otherwise have the
        # doctor run real operations on it; the tests about a Mac switch it back on themselves.
        import torch

        monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)


@pytest.fixture
def catalog() -> Catalog:
    return Catalog(
        {
            "six": fake_spec("six", ("bass", "drums", "other", "vocals", "guitar", "piano")),
            "vox": fake_spec("vox", ("vocals",)),
            "vox2": fake_spec("vox2", ("vocals",)),
            "kit": fake_spec("kit", ("kick", "snare", "toms", "hh", "ride", "crash")),
        }
    )


@pytest.fixture
def store(tmp_path: Path) -> ModelStore:
    return ModelStore(tmp_path / "models", fake=True)


@pytest.fixture
def pipeline(catalog: Catalog, store: ModelStore) -> Pipeline:
    return Pipeline(catalog, store, ModelHost(store))


def tone(seconds: float = 1.0, freq: float = 220.0) -> np.ndarray:
    """Deterministic stereo test signal: two tones plus a little seeded noise."""
    n = int(seconds * RATE)
    t = np.arange(n, dtype=np.float64) / RATE
    rng = np.random.default_rng(7)
    left = 0.4 * np.sin(2 * np.pi * freq * t) + 0.05 * rng.standard_normal(n)
    right = 0.3 * np.sin(2 * np.pi * freq * 1.5 * t) + 0.05 * rng.standard_normal(n)
    return np.stack([left, right]).astype(np.float32)


@pytest.fixture
def song(tmp_path: Path) -> Path:
    """A short float WAV; decoding it returns exactly the samples written."""
    path = tmp_path / "in" / "Test Song.wav"
    path.parent.mkdir()
    write_audio(path, tone(1.5), RATE, "wav32f")
    return path
