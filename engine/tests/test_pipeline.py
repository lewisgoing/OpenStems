"""The pipeline with the FakeEngine: no GPU, no model files."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import pytest

from openstems.audio.decode import decode
from openstems.audio.write import read_audio
from openstems.domain import (
    Cancelled,
    DerivedStem,
    DomainError,
    OutputStem,
    PassSpec,
    Recipe,
)
from openstems.engines.base import CancelToken
from openstems.engines.fake import fake_gains
from openstems.pipeline.run import Pipeline, Progress, RunOptions

SIX = ("bass", "drums", "other", "vocals", "guitar", "piano")


def full_song() -> Recipe:
    return Recipe(
        id="full-song",
        name="Full song",
        version=1,
        passes=(PassSpec("sw", ("six",)),),
        outputs=tuple(OutputStem(s, f"sw.{s}") for s in SIX),
        residual_into="other",
    )


def stems_of(result) -> dict[str, np.ndarray]:
    return {s.name: read_audio(Path(result.directory) / s.file)[0] for s in result.stems}


def db(x: np.ndarray, ref: np.ndarray) -> float:
    return 20 * np.log10(
        max(float(np.sqrt(np.mean(x**2))), 1e-12) / float(np.sqrt(np.mean(ref**2)))
    )


def test_full_song_writes_six_aligned_stems_and_a_manifest(pipeline, song, tmp_path) -> None:
    events: list[Progress] = []
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(), events.append)

    out = Path(result.directory)
    assert out == tmp_path / "out" / "Test Song" / "full-song"
    assert sorted(p.name for p in out.glob("*.wav")) == sorted(f"Test Song - {s}.wav" for s in SIX)
    mix = decode(song)
    for name, audio in stems_of(result).items():
        assert audio.shape == mix.shape, name  # exactly the decoded source's sample count

    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert manifest["complete"] is True
    assert manifest["source"]["sha256"] and manifest["source"]["decoded_samples"] == mix.shape[1]
    assert manifest["recipe"]["id"] == "full-song"
    vocals = next(s for s in manifest["stems"] if s["name"] == "vocals")
    assert vocals["models"][0]["id"] == "six" and vocals["models"][0]["sha256"]
    assert vocals["models"][0]["settings"]["num_overlap"] == 4
    assert (out / vocals["peaks"]).is_file()

    fractions = [e.fraction for e in events]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    assert {e.stage for e in events} >= {"preparing", "running", "writing", "done"}


def test_stems_leave_a_residual_without_sum_to_mix(pipeline, song, tmp_path) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out")
    total = sum(stems_of(result).values())
    assert db(decode(song) - total, decode(song)) > -40


def test_sum_to_mix_folds_the_residual_into_other(pipeline, song, tmp_path) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(sum_to_mix=True))
    mix = decode(song)
    total = sum(stems_of(result).values())
    assert db(mix - total, mix) < -60


def test_second_run_returns_from_the_cache(pipeline, song, tmp_path) -> None:
    first = pipeline.run(song, full_song(), tmp_path / "out")
    loads = pipeline.host.loads
    second = pipeline.run(song, full_song(), tmp_path / "out")
    assert not first.cached and second.cached
    assert pipeline.host.loads == loads
    assert [s.file for s in second.stems] == [s.file for s in first.stems]


def test_cache_misses_when_settings_or_files_change(pipeline, song, tmp_path) -> None:
    out = tmp_path / "out"
    first = pipeline.run(song, full_song(), out)
    assert not pipeline.run(song, full_song(), out, RunOptions(quality="best")).cached
    assert pipeline.run(song, full_song(), out, RunOptions(quality="best")).cached
    (Path(first.directory) / first.stems[0].file).unlink()
    assert not pipeline.run(song, full_song(), out, RunOptions(quality="best")).cached
    assert not pipeline.run(song, full_song(), out, RunOptions(quality="best", force=True)).cached


def test_chained_pass_reads_an_earlier_stem(pipeline, song, tmp_path) -> None:
    recipe = Recipe(
        id="drum-kit",
        name="Drum kit",
        version=1,
        passes=(PassSpec("sw", ("six",)), PassSpec("kit", ("kit",), input="sw.drums")),
        outputs=(OutputStem("kick", "kit.kick"), OutputStem("drums", "sw.drums")),
    )
    out = stems_of(pipeline.run(song, recipe, tmp_path / "out"))
    mix = decode(song)
    drums_gain = fake_gains(6)[1]
    kick_gain = fake_gains(6)[0]
    np.testing.assert_allclose(out["drums"], mix * np.float32(drums_gain), rtol=1e-6)
    np.testing.assert_allclose(
        out["kick"], mix * np.float32(drums_gain) * np.float32(kick_gain), rtol=1e-5
    )


def test_derived_stem_is_sample_exact(pipeline, song, tmp_path) -> None:
    recipe = Recipe(
        id="melody",
        name="Melody",
        version=1,
        passes=(PassSpec("sw", ("six",)),),
        derived=(
            DerivedStem("melody", add=("sw.other", "sw.guitar", "sw.piano")),
            DerivedStem("drumless", add=("mix",), subtract=("sw.drums",)),
        ),
        outputs=(
            OutputStem("melody", "melody"),
            OutputStem("guitar", "sw.guitar"),
            OutputStem("piano", "sw.piano"),
            OutputStem("other", "sw.other"),
            OutputStem("drums", "sw.drums"),
            OutputStem("drumless", "drumless"),
        ),
    )
    out = stems_of(pipeline.run(song, recipe, tmp_path / "out"))
    assert np.array_equal(out["melody"], out["other"] + out["guitar"] + out["piano"])
    assert np.array_equal(out["drumless"], decode(song) - out["drums"])


def test_ensemble_averages_the_models(pipeline, song, tmp_path) -> None:
    recipe = Recipe(
        id="ens",
        name="Ensemble",
        version=1,
        passes=(PassSpec("v", ("vox", "vox2")),),
        outputs=(OutputStem("vocals", "v.vocals"),),
    )
    result = pipeline.run(song, recipe, tmp_path / "out")
    out = stems_of(result)["vocals"]
    np.testing.assert_allclose(out, decode(song) * np.float32(fake_gains(1)[0]), rtol=1e-6)
    assert [m["id"] for m in result.manifest["passes"]["v"]["models"]] == ["vox", "vox2"]


def test_selected_outputs_only(pipeline, song, tmp_path) -> None:
    result = pipeline.run(
        song, full_song(), tmp_path / "out", RunOptions(outputs=["vocals", "bass"])
    )
    assert sorted(s.name for s in result.stems) == ["bass", "vocals"]


def test_cancel_leaves_no_partial_files(catalog, store, song, tmp_path) -> None:
    pipeline = Pipeline(catalog, store)
    cancel = CancelToken()

    def on_progress(p: Progress) -> None:
        if p.stage == "running" and p.fraction > 0.3:
            cancel.cancel()

    with pytest.raises(Cancelled):
        pipeline.run(song, full_song(), tmp_path / "out", RunOptions(), on_progress, cancel)
    assert not list((tmp_path / "out").rglob("*.wav"))
    assert not list((tmp_path / "out").rglob("*.tmp-*"))


def test_cancel_during_writing_removes_the_temp_folder(pipeline, song, tmp_path) -> None:
    cancel = CancelToken()

    def on_progress(p: Progress) -> None:
        if p.stage == "writing" and "vocals" in p.message:
            cancel.cancel()

    with pytest.raises(Cancelled):
        pipeline.run(song, full_song(), tmp_path / "out", RunOptions(), on_progress, cancel)
    leftovers = [p for p in (tmp_path / "out").rglob("*") if p.is_file()]
    assert leftovers == []


def test_rerun_replaces_only_its_own_files(pipeline, song, tmp_path) -> None:
    first = pipeline.run(song, full_song(), tmp_path / "out")
    keep = Path(first.directory) / "my notes.txt"
    keep.write_text("mine", "utf-8")
    pipeline.run(song, full_song(), tmp_path / "out", RunOptions(outputs=["vocals"], force=True))
    assert keep.read_text("utf-8") == "mine"
    assert [p.name for p in Path(first.directory).glob("*.wav")] == ["Test Song - vocals.wav"]


def test_non_ascii_and_spaces_in_paths(pipeline, tmp_path) -> None:
    from openstems.audio.write import write_audio
    from tests.conftest import RATE, tone

    source = tmp_path / "ünï cödé 日本語" / 'Señor "Ω" – 夜.wav'.replace('"', "'")
    source.parent.mkdir()
    write_audio(source, tone(0.5), RATE)
    result = pipeline.run(source, full_song(), tmp_path / "öut put")
    assert Path(result.directory).parent.name == "Señor 'Ω' – 夜"
    assert all((Path(result.directory) / s.file).is_file() for s in result.stems)


def test_missing_file_and_missing_model(catalog, song, tmp_path) -> None:
    from openstems.catalog.store import ModelNotInstalled, ModelStore

    pipeline = Pipeline(catalog, ModelStore(tmp_path / "models", fake=True))
    with pytest.raises(DomainError):
        pipeline.run(tmp_path / "nope.wav", full_song(), tmp_path / "out")
    real = Pipeline(catalog, ModelStore(tmp_path / "models"))
    with pytest.raises(ModelNotInstalled):
        real.run(song, full_song(), tmp_path / "out")


def test_model_host_keeps_the_last_model_warm(pipeline, song, tmp_path) -> None:
    pipeline.run(song, full_song(), tmp_path / "a")
    pipeline.run(song, full_song(), tmp_path / "b")
    assert pipeline.host.loads == 1
    assert pipeline.host.loaded_ids == ["six"]


def test_progress_from_another_thread_can_cancel(catalog, store, song, tmp_path) -> None:
    from openstems.engines.fake import FakeEngine

    pipeline = Pipeline(catalog, store)
    cancel = CancelToken()
    started = threading.Event()
    errors: list[BaseException] = []

    import openstems.engines.host as host

    original = host.engine_for
    host.engine_for = lambda spec: FakeEngine(delay=0.05)
    try:

        def work() -> None:
            try:
                pipeline.run(
                    song, full_song(), tmp_path / "out", RunOptions(),
                    lambda p: started.set() if p.stage == "running" else None, cancel,
                )  # fmt: skip
            except BaseException as exc:
                errors.append(exc)

        thread = threading.Thread(target=work)
        thread.start()
        assert started.wait(5)
        cancel.cancel()
        thread.join(5)
    finally:
        host.engine_for = original
    assert not thread.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], Cancelled)


def test_out_of_memory_drops_other_warm_models_and_retries(catalog, store, song, tmp_path) -> None:
    import openstems.engines.host as host
    from openstems.engines.fake import FakeEngine, FakeLoadedModel

    class OutOfMemoryError(RuntimeError):
        pass

    failures = {"left": 1}

    class Flaky(FakeLoadedModel):
        def separate(self, *args, **kwargs):
            if self.spec.id == "kit" and failures["left"]:
                failures["left"] -= 1
                raise OutOfMemoryError("CUDA out of memory")
            return super().separate(*args, **kwargs)

    class FlakyEngine(FakeEngine):
        def load(self, spec, store, device=None):
            return Flaky(spec, 0.0)

    original = host.engine_for
    host.engine_for = lambda spec: FlakyEngine()
    try:
        pipeline = Pipeline(catalog, store)
        recipe = Recipe(
            id="drum-kit",
            name="Drum kit",
            version=1,
            passes=(PassSpec("sw", ("six",)), PassSpec("kit", ("kit",), input="sw.drums")),
            outputs=(OutputStem("kick", "kit.kick"),),
        )
        result = pipeline.run(song, recipe, tmp_path / "out")
    finally:
        host.engine_for = original
    assert [s.name for s in result.stems] == ["kick"]
    assert pipeline.host.loaded_ids == ["kit"]  # the other warm model was dropped
    assert pipeline.host.loads == 3
