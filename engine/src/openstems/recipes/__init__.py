"""Built-in recipe TOML files and the loader for built-in and user recipes."""

from __future__ import annotations

import tomllib
from importlib import resources
from pathlib import Path

from openstems.catalog.catalog import Catalog
from openstems.domain.errors import DomainError
from openstems.domain.recipe import Recipe, check_against_models, recipe_from_dict

# Display order of the built-in recipes.
ORDER = (
    "full-song",
    "full-song-best-vocals",
    "vocals-instrumental",
    "acapella-clean",
    "drum-kit",
    "melody",
    "drumless",
    "cleanup-dereverb",
    "cleanup-denoise",
    "mega-53",
)


def _sort_key(recipe: Recipe) -> tuple[int, str]:
    return (ORDER.index(recipe.id) if recipe.id in ORDER else len(ORDER), recipe.id)


def builtin_recipes() -> dict[str, Recipe]:
    found: dict[str, Recipe] = {}
    for entry in resources.files("openstems.recipes").iterdir():
        if entry.name.endswith(".toml"):
            recipe = recipe_from_dict(tomllib.loads(entry.read_text("utf-8")), builtin=True)
            found[recipe.id] = recipe
    return found


def user_recipes(folder: Path) -> tuple[dict[str, Recipe], dict[str, str]]:
    """User recipes from the config folder. Returns (recipes, errors by file name)."""
    found: dict[str, Recipe] = {}
    errors: dict[str, str] = {}
    if not folder.is_dir():
        return found, errors
    for path in sorted(folder.glob("*.toml")):
        try:
            recipe = recipe_from_dict(tomllib.loads(path.read_text("utf-8")), builtin=False)
            found[recipe.id] = recipe
        except (DomainError, tomllib.TOMLDecodeError, OSError, TypeError) as exc:
            errors[path.name] = str(exc)
    return found, errors


def load_recipes(
    catalog: Catalog | None = None, user_folder: Path | None = None
) -> dict[str, Recipe]:
    """Built-in recipes plus user recipes (a user recipe cannot shadow a built-in one).

    With a catalog, every recipe is checked against the stems its models emit; user
    recipes that fail are skipped, built-in ones raise.
    """
    recipes = builtin_recipes()
    if catalog is not None:
        for recipe in recipes.values():
            check_against_models(recipe, catalog.stems_of)
    if user_folder is not None:
        extra, _ = user_recipes(user_folder)
        for rid, recipe in extra.items():
            if rid in recipes:
                continue
            if catalog is not None:
                try:
                    check_against_models(recipe, catalog.stems_of)
                except DomainError:
                    continue
            recipes[rid] = recipe
    return dict(sorted(recipes.items(), key=lambda kv: _sort_key(kv[1])))
