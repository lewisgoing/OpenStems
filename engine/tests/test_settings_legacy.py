"""The rename from lew-stems: settings, folders and recipes are carried over once."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openstems import settings as settings_module
from openstems.settings import load_settings, settings_file


@pytest.fixture
def profile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A Windows profile in a temp folder, with no folder chosen through the environment.
    The rename only ever happened on Windows, so these run as Windows wherever they run."""
    monkeypatch.setattr(settings_module, "_is_mac", lambda: False)
    for name in ("CONFIG", "MODELS", "OUTPUT", "CACHE"):
        monkeypatch.delenv(f"OPENSTEMS_{name}_DIR", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def old_settings(profile: Path, values: dict[str, object] | str) -> Path:
    """Write the settings file the app kept while it was called lew-stems."""
    path = profile / "Roaming" / "lew-stems" / "settings.json"
    write(path, values if isinstance(values, str) else json.dumps(values))
    return path


def test_a_fresh_profile_gets_the_new_folders(profile: Path) -> None:
    settings = load_settings()
    assert settings.models_path == profile / "Local" / "OpenStems" / "models"
    assert settings.output_path == profile / "Music" / "OpenStems"
    assert settings.logs_path == profile / "Local" / "OpenStems" / "logs"
    assert settings_file() == profile / "Roaming" / "OpenStems" / "settings.json"
    assert not settings_file().exists()


def test_the_old_settings_file_is_carried_over_once(profile: Path) -> None:
    models, outputs = "D:\\stems\\models", "D:\\stems\\out"
    old = old_settings(
        profile, {"models_dir": models, "output_dir": outputs, "default_quality": "best"}
    )

    settings = load_settings()
    assert settings.models_dir == models
    assert settings.output_dir == outputs
    assert settings.default_quality == "best"
    assert json.loads(settings_file().read_text(encoding="utf-8"))["models_dir"] == models

    # From here on the new file is the truth: a later change to the old one is not seen.
    old_settings(profile, {"default_quality": "fast"})
    assert load_settings().default_quality == "best"
    # The old file is left where it was found.
    assert old.exists()


def test_old_default_folders_that_hold_something_stay_in_use(profile: Path) -> None:
    write(profile / "Local" / "lew-stems" / "models" / "bs-roformer-sw" / "model.ckpt")
    write(profile / "Music" / "lew-stems" / "Song" / "full-song" / "manifest.json")
    (profile / "Local" / "lew-stems" / "cache").mkdir(parents=True)  # empty: not worth keeping

    settings = load_settings()
    assert settings.models_path == profile / "Local" / "lew-stems" / "models"
    assert settings.output_path == profile / "Music" / "lew-stems"
    assert settings.cache_path == profile / "Local" / "OpenStems" / "cache"
    assert settings_file().is_file()


def test_user_recipes_are_copied(profile: Path) -> None:
    mine = profile / "Roaming" / "lew-stems" / "recipes" / "mine.toml"
    write(mine, "id = 'mine'")
    load_settings()
    copied = profile / "Roaming" / "OpenStems" / "recipes" / "mine.toml"
    assert copied.read_text(encoding="utf-8") == "id = 'mine'"
    assert mine.exists()


def test_a_broken_old_settings_file_is_ignored(profile: Path) -> None:
    old_settings(profile, "{not json")
    assert load_settings().default_quality == "balanced"
    old_settings(profile, {"default_quality": "no such"})
    assert load_settings().default_quality == "balanced"


def test_existing_new_settings_win_over_the_old_ones(profile: Path) -> None:
    old_settings(profile, {"default_quality": "best"})
    write(settings_file(), json.dumps({"default_quality": "fast"}))
    assert load_settings().default_quality == "fast"


def test_a_config_folder_chosen_by_hand_has_no_past(
    profile: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old_settings(profile, {"default_quality": "best"})
    monkeypatch.setenv("OPENSTEMS_CONFIG_DIR", str(profile / "portable"))
    assert load_settings().default_quality == "balanced"
    assert not (profile / "portable" / "settings.json").exists()
