import subprocess
import sys

import pytest

from openstems.domain import (
    DerivedStem,
    DomainError,
    Job,
    JobState,
    ModelFile,
    ModelSpec,
    OutputStem,
    PassSpec,
    Recipe,
    cache_key,
    recipe_from_dict,
    resolve_settings,
    single_model_recipe,
)
from openstems.domain.naming import render_name, safe_component, validate_template
from openstems.domain.recipe import check_against_models
from tests.conftest import fake_spec


def make(passes, outputs, derived=(), **kw) -> Recipe:
    return Recipe(
        id="r", name="R", version=1, passes=tuple(passes), outputs=tuple(outputs),
        derived=tuple(derived), **kw,
    )  # fmt: skip


def test_domain_never_imports_torch() -> None:
    code = "import sys, openstems.domain; sys.exit(1 if 'torch' in sys.modules else 0)"
    assert subprocess.run([sys.executable, "-c", code], check=False).returncode == 0


# -- model ---------------------------------------------------------------------


def test_model_file_rejects_bad_hash_and_http() -> None:
    with pytest.raises(DomainError):
        ModelFile("checkpoint", "a.ckpt", "https://x/a", "nothex", 10)
    with pytest.raises(DomainError):
        ModelFile("checkpoint", "a.ckpt", "http://x/a", "ab" * 32, 10)


def test_model_needs_exactly_one_checkpoint() -> None:
    cfg = ModelFile("config", "a.yaml", "https://x/a", "ab" * 32, 10)
    with pytest.raises(DomainError):
        ModelSpec(id="m", name="m", architecture="fake", loader="fake", files=(cfg,), stems=("a",))


def test_model_total_bytes() -> None:
    assert fake_spec("m", ("a",)).total_bytes == 1000


# -- quality -------------------------------------------------------------------


def test_presets_resolve_against_the_model_chunk() -> None:
    spec = fake_spec("m", ("a",), chunk_size=1234)
    fast, best = resolve_settings("fast", spec), resolve_settings("best", spec)
    assert fast.chunk_size == best.chunk_size == 1234
    assert fast.num_overlap < best.num_overlap
    assert best.tta and not fast.tta
    assert "batch_size" not in fast.key_dict()


def test_unknown_preset() -> None:
    with pytest.raises(DomainError):
        resolve_settings("ultra", fake_spec("m", ("a",)))


# -- recipe --------------------------------------------------------------------


def test_pass_input_must_be_mix_or_an_earlier_pass() -> None:
    with pytest.raises(DomainError, match="earlier pass"):
        make(
            [PassSpec("a", ("m",), input="b.x"), PassSpec("b", ("m",))],
            [OutputStem("x", "a.x")],
        )


def test_pass_cannot_read_itself() -> None:
    with pytest.raises(DomainError):
        make([PassSpec("a", ("m",), input="a.x")], [OutputStem("x", "a.x")])


def test_duplicate_ids_and_outputs_rejected() -> None:
    with pytest.raises(DomainError, match="duplicate pass"):
        make([PassSpec("a", ("m",)), PassSpec("a", ("m",))], [OutputStem("x", "a.x")])
    with pytest.raises(DomainError, match="duplicate output"):
        make([PassSpec("a", ("m",))], [OutputStem("x", "a.x"), OutputStem("x", "a.y")])


def test_derived_may_only_use_known_signals() -> None:
    with pytest.raises(DomainError, match="unknown signal"):
        make(
            [PassSpec("a", ("m",))],
            [OutputStem("x", "later")],
            derived=[DerivedStem("d", add=("later",)), DerivedStem("later", add=("a.x",))],
        )


def test_residual_into_must_be_an_output() -> None:
    with pytest.raises(DomainError, match="residual_into"):
        make([PassSpec("a", ("m",))], [OutputStem("x", "a.x")], residual_into="other")


def test_chained_recipe_from_toml_dict() -> None:
    recipe = recipe_from_dict(
        {
            "id": "drum-kit",
            "version": 2,
            "passes": [
                {"id": "sw", "model": "six"},
                {"id": "kit", "model": "kit", "input": "sw.drums"},
            ],
            "derived": [{"name": "nodrums", "add": ["mix"], "subtract": ["sw.drums"]}],
            "outputs": [
                {"stem": "kick", "from": "kit.kick"},
                {"stem": "drums", "from": "sw.drums"},
                {"stem": "drumless", "from": "nodrums"},
            ],
        }
    )
    assert recipe.model_ids == ("six", "kit")
    assert recipe.passes[1].input == "sw.drums"
    assert recipe.to_dict()["version"] == 2


def test_check_against_models_catches_unknown_stems(catalog) -> None:
    good = make([PassSpec("a", ("six",))], [OutputStem("v", "a.vocals")])
    check_against_models(good, catalog.stems_of)
    bad = make([PassSpec("a", ("six",))], [OutputStem("v", "a.flute")])
    with pytest.raises(DomainError, match="does not emit"):
        check_against_models(bad, catalog.stems_of)


def test_ensemble_models_must_share_stems(catalog) -> None:
    bad = make([PassSpec("a", ("vox", "kit"))], [OutputStem("v", "a.vocals")])
    with pytest.raises(DomainError, match="share no stem"):
        check_against_models(bad, catalog.stems_of)


def test_single_model_recipe() -> None:
    recipe = single_model_recipe("BS Model.X", ("vocals", "other"))
    assert recipe.id == "model-bs-model-x"
    assert [o.name for o in recipe.outputs] == ["vocals", "other"]


def test_with_outputs_subsets_and_drops_residual() -> None:
    recipe = make(
        [PassSpec("a", ("m",))],
        [OutputStem("x", "a.x"), OutputStem("other", "a.o")],
        residual_into="other",
    )
    sub = recipe.with_outputs(["x"])
    assert [o.name for o in sub.outputs] == ["x"]
    assert sub.residual_into is None
    with pytest.raises(DomainError):
        recipe.with_outputs(["nope"])


# -- job -----------------------------------------------------------------------


def test_job_happy_path() -> None:
    job = Job(track_path="a.wav", recipe_id="full-song")
    for state in (JobState.PREPARING, JobState.RUNNING, JobState.WRITING, JobState.DONE):
        job.advance(state)
    assert job.is_terminal and job.progress == 1.0 and job.finished_at


def test_job_rejects_illegal_transitions() -> None:
    job = Job(track_path="a.wav", recipe_id="r")
    with pytest.raises(DomainError):
        job.advance(JobState.WRITING)
    job.advance(JobState.CANCELLED)
    with pytest.raises(DomainError):
        job.advance(JobState.RUNNING)


def test_failed_job_can_be_retried() -> None:
    job = Job(track_path="a.wav", recipe_id="r")
    job.advance(JobState.PREPARING)
    job.advance(JobState.FAILED, error="boom")
    assert job.error == "boom"
    job.advance(JobState.QUEUED)
    assert job.error is None and job.progress == 0.0


# -- naming --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('AC/DC: "Back" <in> Black?', "AC_DC_ _Back_ _in_ Black_"),
        ("trailing dots... ", "trailing dots"),
        ("CON", "_CON"),
        ("nul.wav", "_nul.wav"),
        ("", "untitled"),
        ("日本語の曲 – ünïcödé", "日本語の曲 – ünïcödé"),
    ],
)
def test_safe_component(raw: str, expected: str) -> None:
    assert safe_component(raw) == expected


def test_safe_component_limits_length() -> None:
    assert len(safe_component("x" * 500)) == 120


def test_render_name_drops_empty_tokens() -> None:
    assert render_name("{track} - {stem}", track="Song", stem="vocals") == "Song - vocals"
    assert render_name("{track} - {bpm} - {stem}", track="Song", stem="bass", bpm="") == (
        "Song - bass"
    )
    assert render_name(
        "{bpm} {key} {track} - {stem}", track="S", stem="v", bpm="120", key="Am"
    ) == ("120 Am S - v")


def test_validate_template() -> None:
    validate_template("{track} - {stem}")
    with pytest.raises(DomainError):
        validate_template("{track}")
    with pytest.raises(DomainError):
        validate_template("{stem} {nope}")


# -- cache key -----------------------------------------------------------------


def test_cache_key_is_stable_and_sensitive() -> None:
    args = ("hash", {"id": "r", "version": 1}, {"quality": "fast"}, {"m": "sha"}, {"format": "wav"})
    assert cache_key(*args) == cache_key(*args)
    assert cache_key("other", *args[1:]) != cache_key(*args)
    assert cache_key(args[0], {"id": "r", "version": 2}, *args[2:]) != cache_key(*args)
    assert cache_key(*args[:2], {"quality": "best"}, *args[3:]) != cache_key(*args)
