"""Every built-in recipe against the real catalog, run with the FakeEngine."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from openstems.audio.decode import decode
from openstems.audio.write import read_audio
from openstems.catalog.catalog import load_catalog
from openstems.catalog.custom import import_model, read_config
from openstems.catalog.store import ModelStore
from openstems.domain.errors import DomainError
from openstems.pipeline.run import Pipeline, RunOptions
from openstems.recipes import builtin_recipes, load_recipes, user_recipes

PLAN_RECIPES = {
    "full-song": ["vocals", "drums", "bass", "guitar", "piano", "other"],
    "full-song-best-vocals": ["vocals", "drums", "bass", "guitar", "piano", "other"],
    "vocals-instrumental": ["vocals", "instrumental"],
    "acapella-clean": ["dry vocals", "lead", "backing"],
    "drum-kit": ["kick", "snare", "toms", "hh", "ride", "crash", "drums"],
    "melody": ["melody", "guitar", "piano", "other"],
    "drumless": ["drumless"],
    "cleanup-dereverb": ["dry"],
    "cleanup-denoise": ["clean"],
}


@pytest.fixture
def real_catalog_pipeline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Pipeline:
    monkeypatch.setenv("OPENSTEMS_ENGINE", "fake")  # real catalog, FakeEngine
    return Pipeline(load_catalog(), ModelStore(tmp_path / "models", fake=True))


def test_every_plan_recipe_exists_with_its_stems() -> None:
    recipes = load_recipes(load_catalog())
    for recipe_id, stems in PLAN_RECIPES.items():
        assert [o.name for o in recipes[recipe_id].outputs] == stems, recipe_id
    assert len(recipes["mega-53"].outputs) == 53
    assert recipes["mega-53"].experimental and recipes["mega-53"].selectable_outputs
    assert next(iter(recipes)) == "full-song"


def test_seed_set_covers_every_standard_recipe() -> None:
    catalog = load_catalog()
    seed = {m.id for m in catalog.seed()}
    for recipe in builtin_recipes().values():
        if not recipe.experimental:
            assert set(recipe.model_ids) <= seed, recipe.id


def test_catalog_entries_are_complete() -> None:
    for spec in load_catalog():
        assert spec.license, spec.id
        assert spec.checkpoint.url.startswith("https://") and spec.config is not None, spec.id
        assert spec.architecture in ("bs_roformer", "mel_band_roformer", "mdx23c")
        assert spec.chunk_size > 0 and spec.num_overlap >= 2
        assert all(f.size > 0 and len(f.sha256) == 64 for f in spec.files)


@pytest.mark.parametrize("recipe_id", [*PLAN_RECIPES, "full-song-best-vocals-alt"])
def test_recipe_runs_and_stays_aligned(
    recipe_id: str, real_catalog_pipeline: Pipeline, song: Path, tmp_path: Path
) -> None:
    recipe = load_recipes(load_catalog())[recipe_id]
    result = real_catalog_pipeline.run(song, recipe, tmp_path / "out", RunOptions(quality="fast"))
    mix = decode(song)
    stems = {s.name: read_audio(Path(result.directory) / s.file)[0] for s in result.stems}
    assert list(stems) == [o.name for o in recipe.outputs]
    for name, audio in stems.items():
        assert audio.shape == mix.shape, name
    if recipe_id == "melody":
        assert np.array_equal(stems["melody"], stems["other"] + stems["guitar"] + stems["piano"])
    if recipe_id == "drumless":
        drums = real_catalog_pipeline.run(
            song, load_recipes(load_catalog())["drum-kit"], tmp_path / "out"
        )
        full = read_audio(Path(drums.directory) / "Test Song - drums.wav")[0]
        assert np.array_equal(stems["drumless"], mix - full)


def test_mega_53_writes_only_the_ticked_stems(
    real_catalog_pipeline: Pipeline, song: Path, tmp_path: Path
) -> None:
    recipe = load_recipes(load_catalog())["mega-53"]
    options = RunOptions(quality="fast", outputs=["saxophone", "lead-vocal"])
    result = real_catalog_pipeline.run(song, recipe, tmp_path / "out", options)
    assert sorted(s.name for s in result.stems) == ["lead-vocal", "saxophone"]


def test_user_recipes_load_and_bad_ones_are_reported(tmp_path: Path) -> None:
    folder = tmp_path / "recipes"
    folder.mkdir()
    (folder / "mine.toml").write_text(
        'id = "my-vocals"\nversion = 1\n[[passes]]\nid = "v"\n'
        'model = "bs-roformer-leap-xe-vocals"\n[[outputs]]\nstem = "vox"\nfrom = "v.vocals"\n',
        "utf-8",
    )
    (folder / "broken.toml").write_text('id = "x"\n[[passes]]\nid = "v"\n', "utf-8")
    (folder / "wrong-stem.toml").write_text(
        'id = "wrong"\n[[passes]]\nid = "v"\nmodel = "bs-roformer-leap-xe-vocals"\n'
        '[[outputs]]\nstem = "x"\nfrom = "v.flute"\n',
        "utf-8",
    )
    (folder / "full-song.toml").write_text(
        'id = "full-song"\n[[passes]]\nid = "v"\nmodel = "bs-roformer-leap-xe-vocals"\n'
        '[[outputs]]\nstem = "x"\nfrom = "v.vocals"\n',
        "utf-8",
    )
    found, errors = user_recipes(folder)
    assert "my-vocals" in found and not found["my-vocals"].builtin
    assert "broken.toml" in errors
    recipes = load_recipes(load_catalog(), folder)
    assert "my-vocals" in recipes and "wrong" not in recipes
    assert recipes["full-song"].builtin  # a user file cannot shadow a built-in recipe


CONFIG = """
audio: {chunk_size: 1000, hop_length: 441}
model: {dim: 8, stft_hop_length: 300}
training: {instruments: [Vocals, Other], target_instrument: null}
inference: {num_overlap: 4}
"""


def test_import_custom_model(tmp_path: Path) -> None:
    checkpoint = tmp_path / "My Model v2.ckpt"
    checkpoint.write_bytes(b"\x00" * 2048)
    config = tmp_path / "cfg.yaml"
    config.write_text(CONFIG, "utf-8")
    models = tmp_path / "models"

    assert read_config(config, "bs_roformer") == (("vocals", "other"), 900, 4)
    assert read_config(config, "mdx23c") == (("vocals", "other"), 882, 4)

    spec = import_model(models, checkpoint, config, "bs_roformer")
    assert spec.id == "custom-my-model-v2" and spec.custom and spec.stems == ("vocals", "other")
    catalog = load_catalog(models)
    assert "custom-my-model-v2" in catalog
    store = ModelStore(models)
    assert store.status(catalog.get(spec.id)) == "installed"
    assert store.checkpoint_path(spec).parent == models / "custom" / spec.id

    with pytest.raises(DomainError, match="already exists"):
        import_model(models, checkpoint, config, "bs_roformer")
    with pytest.raises(DomainError):
        import_model(models, checkpoint, config, "demucs")
    with pytest.raises(DomainError):
        import_model(models, tmp_path / "missing.ckpt", config, "bs_roformer")
    bad = tmp_path / "bad.yaml"
    bad.write_text("just: text", "utf-8")
    with pytest.raises(DomainError):
        import_model(models, checkpoint, bad, "bs_roformer", model_id="other")
    assert not (models / "custom" / "custom-other").exists()

    assert store.delete(catalog.get(spec.id))
    assert "custom-my-model-v2" not in load_catalog(models)
