"""GPU tests: need CUDA, downloaded models and a song. Run with ``uv run pytest -m gpu``.

Set ``OPENSTEMS_TEST_SONG`` to an audio file and ``OPENSTEMS_REAL_MODELS_DIR`` to the models
folder (the autouse fixture in conftest points the default at an empty temp folder).
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

pytestmark = pytest.mark.gpu


@pytest.fixture
def real_runtime(monkeypatch: pytest.MonkeyPatch):
    models = os.environ.get("OPENSTEMS_REAL_MODELS_DIR")
    song = os.environ.get("OPENSTEMS_TEST_SONG")
    if not models or not song:
        pytest.skip("set OPENSTEMS_REAL_MODELS_DIR and OPENSTEMS_TEST_SONG")
    monkeypatch.setenv("OPENSTEMS_MODELS_DIR", models)
    from openstems.runtime import build_runtime

    return build_runtime(), Path(song)


def test_full_song_on_the_gpu(real_runtime, tmp_path: Path) -> None:
    from openstems.audio.decode import decode
    from openstems.audio.write import read_audio
    from openstems.pipeline.run import RunOptions

    rt, song = real_runtime
    options = RunOptions(quality="fast", sum_to_mix=True)
    result = rt.pipeline.run(song, rt.recipe("full-song"), tmp_path, options)
    mix = decode(song)
    total = np.zeros_like(mix, dtype=np.float64)
    assert len(result.stems) == 6
    for stem in result.stems:
        audio, _ = read_audio(Path(result.directory) / stem.file)
        assert audio.shape == mix.shape
        total += audio
    residual = np.sqrt(np.mean((mix - total) ** 2)) / np.sqrt(np.mean(mix.astype(np.float64) ** 2))
    assert 20 * np.log10(max(residual, 1e-12)) < -60
    assert rt.pipeline.run(song, rt.recipe("full-song"), tmp_path, options).cached
