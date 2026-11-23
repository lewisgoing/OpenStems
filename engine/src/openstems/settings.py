"""User settings: folders, output format and naming. Stored as JSON in the config folder."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from openstems.domain.naming import DEFAULT_TEMPLATE

APP_NAME = "OpenStems"
# What the app was called before 0.2.0. Its folders are read once, to carry things over.
LEGACY_NAME = "lew-stems"
OUTPUT_FORMATS = ("wav32f", "wav24", "flac", "mp3")


def _local_appdata() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")


def _roaming_appdata() -> Path:
    return Path(os.environ.get("APPDATA") or Path.home() / ".config")


def config_dir() -> Path:
    return Path(os.environ.get("OPENSTEMS_CONFIG_DIR") or _roaming_appdata() / APP_NAME)


@dataclass
class Settings:
    models_dir: str = field(default_factory=lambda: str(_local_appdata() / APP_NAME / "models"))
    output_dir: str = field(default_factory=lambda: str(Path.home() / "Music" / APP_NAME))
    cache_dir: str = field(default_factory=lambda: str(_local_appdata() / APP_NAME / "cache"))
    output_format: str = "wav32f"
    match_source_rate: bool = False
    naming_template: str = DEFAULT_TEMPLATE
    default_recipe: str = "full-song"
    default_quality: str = "balanced"
    sum_to_mix: bool = False
    trim_silence: bool = False
    normalize: bool = False
    detect_tempo_key: bool = True
    write_midi: bool = False
    watch_folder: str = ""
    watch_enabled: bool = False
    vram_budget_gb: float = 12.0
    # Off: run on the CPU even when a GPU is present (the way out when a card or
    # driver misbehaves). OPENSTEMS_DEVICE=cpu does the same for one process.
    use_gpu: bool = True
    # Off (the default): files added to the queue wait there until the user presses Start.
    # On: each one starts as soon as the GPU is free. The watch folder always starts its
    # files, since nobody is there to press anything. OPENSTEMS_AUTO_START=1 or 0 overrides.
    auto_start: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def models_path(self) -> Path:
        return Path(self.models_dir)

    @property
    def output_path(self) -> Path:
        return Path(self.output_dir)

    @property
    def cache_path(self) -> Path:
        return Path(self.cache_dir)

    @property
    def recipes_path(self) -> Path:
        return config_dir() / "recipes"

    @property
    def logs_path(self) -> Path:
        return _local_appdata() / APP_NAME / "logs"


_ENV = {
    "models_dir": "OPENSTEMS_MODELS_DIR",
    "output_dir": "OPENSTEMS_OUTPUT_DIR",
    "cache_dir": "OPENSTEMS_CACHE_DIR",
}


def settings_file() -> Path:
    return config_dir() / "settings.json"


def validate(values: dict[str, Any]) -> dict[str, Any]:
    """Keep known keys with the right types; raise on bad values."""
    from openstems.domain.errors import DomainError
    from openstems.domain.naming import validate_template
    from openstems.domain.quality import PRESET_NAMES

    known = {f.name: f for f in fields(Settings)}
    out: dict[str, Any] = {}
    defaults = Settings()
    for key, value in values.items():
        if key not in known:
            continue
        expected = type(getattr(defaults, key))
        if expected is float and isinstance(value, int) and not isinstance(value, bool):
            value = float(value)
        if not isinstance(value, expected):
            raise DomainError(f"setting {key!r} must be {expected.__name__}")
        out[key] = value
    if "output_format" in out and out["output_format"] not in OUTPUT_FORMATS:
        raise DomainError(f"output_format must be one of {OUTPUT_FORMATS}")
    if "default_quality" in out and out["default_quality"] not in PRESET_NAMES:
        raise DomainError(f"default_quality must be one of {PRESET_NAMES}")
    if "naming_template" in out:
        validate_template(out["naming_template"])
    for key in ("models_dir", "output_dir", "cache_dir"):
        if key in out and not out[key].strip():
            raise DomainError(f"{key} must not be empty")
    return out


def _has_files(folder: Path) -> bool:
    try:
        return folder.is_dir() and any(folder.iterdir())
    except OSError:
        return False


def adopt_legacy_settings() -> dict[str, Any]:
    """The first run as OpenStems: carry over what the app had under its old name.

    The old settings file is read and saved under the new name. Folders that were never
    chosen lived under the old name too; the ones that hold anything stay in use, so no model
    is downloaded twice and no output goes missing. User recipes are copied. Nothing is moved
    or deleted, and it happens once: afterwards the new settings file exists.
    """
    if os.environ.get("OPENSTEMS_CONFIG_DIR"):
        return {}  # a config folder chosen by hand (tests, a portable setup) has no past
    legacy_config = _roaming_appdata() / LEGACY_NAME
    values: dict[str, Any] = {}
    try:
        raw = json.loads((legacy_config / "settings.json").read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            values = validate(raw)
    except (ValueError, OSError):
        values = {}
    legacy_folders = {
        "models_dir": _local_appdata() / LEGACY_NAME / "models",
        "output_dir": Path.home() / "Music" / LEGACY_NAME,
        "cache_dir": _local_appdata() / LEGACY_NAME / "cache",
    }
    for key, folder in legacy_folders.items():
        if key not in values and _has_files(folder):
            values[key] = str(folder)
    try:
        recipes = legacy_config / "recipes"
        if recipes.is_dir() and not (config_dir() / "recipes").exists():
            shutil.copytree(recipes, config_dir() / "recipes")
        if values:
            save_settings(Settings(**values))
    except OSError:
        pass  # the API and the worker may both get here; the other one saved it
    return values


def load_settings() -> Settings:
    """Defaults, then the settings file, then environment overrides."""
    values: dict[str, Any] = {}
    path = settings_file()
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                values = validate(raw)
        except (ValueError, OSError):
            values = {}
    else:
        values = adopt_legacy_settings()
    settings = Settings(**values)
    for key, env in _ENV.items():
        if os.environ.get(env):
            setattr(settings, key, os.environ[env])
    auto_start = os.environ.get("OPENSTEMS_AUTO_START", "").strip().lower()
    if auto_start:
        settings.auto_start = auto_start in ("1", "true", "yes", "on")
    return settings


def save_settings(settings: Settings) -> None:
    path = settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def update_settings(changes: dict[str, Any]) -> Settings:
    current = load_settings().to_dict()
    current.update(validate(changes))
    settings = Settings(**current)
    save_settings(settings)
    return settings
