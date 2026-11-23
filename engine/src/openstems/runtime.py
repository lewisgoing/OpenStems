"""Wire settings, catalog, store, recipes and pipeline together for the entry points."""

from __future__ import annotations

from dataclasses import dataclass

from openstems.catalog.catalog import Catalog, load_catalog
from openstems.catalog.store import ModelStore
from openstems.domain.errors import DomainError
from openstems.domain.recipe import Recipe, single_model_recipe
from openstems.engines.host import ModelHost, fake_mode
from openstems.pipeline.extras import MIDI_STEMS
from openstems.pipeline.run import Pipeline, RunOptions
from openstems.recipes import load_recipes
from openstems.settings import Settings, load_settings


@dataclass
class Runtime:
    settings: Settings
    catalog: Catalog
    store: ModelStore
    recipes: dict[str, Recipe]
    pipeline: Pipeline

    def recipe(self, recipe_id: str | None = None, model_id: str | None = None) -> Recipe:
        """A named recipe, or a one-pass recipe generated for a single model."""
        if model_id:
            spec = self.catalog.get(model_id)
            return single_model_recipe(spec.id, spec.stems, spec.name)
        rid = recipe_id or self.settings.default_recipe
        if rid.startswith("model-"):
            for spec in self.catalog:
                candidate = single_model_recipe(spec.id, spec.stems, spec.name)
                if candidate.id == rid:
                    return candidate
        try:
            return self.recipes[rid]
        except KeyError:
            raise DomainError(
                f"unknown recipe {rid!r}; available: {', '.join(self.recipes)}"
            ) from None

    def options(self, **overrides: object) -> RunOptions:
        s = self.settings
        base = RunOptions(
            quality=s.default_quality,
            sum_to_mix=s.sum_to_mix,
            output_format=s.output_format,
            naming_template=s.naming_template,
            match_source_rate=s.match_source_rate,
            trim_silence=s.trim_silence,
            normalize=s.normalize,
            detect_tempo_key=s.detect_tempo_key,
            tempo_sync=s.tempo_sync,
            midi_stems=list(MIDI_STEMS) if s.write_midi else [],
        )
        for key, value in overrides.items():
            if value is not None:
                setattr(base, key, value)
        return base

    def reload(self) -> None:
        """Pick up settings changes (folders) and newly imported custom models."""
        fresh = build_runtime()
        if fresh.settings.use_gpu != self.settings.use_gpu:
            self.pipeline.host.clear()  # warm models sit on the device they were loaded on
        self.settings = fresh.settings
        self.catalog = fresh.catalog
        self.recipes = fresh.recipes
        if fresh.store.root != self.store.root:
            self.pipeline.host.clear()
            self.store = fresh.store
            self.pipeline = fresh.pipeline
        else:
            self.pipeline.catalog = fresh.catalog


def build_runtime(settings: Settings | None = None) -> Runtime:
    settings = settings or load_settings()
    catalog = load_catalog(settings.models_path)
    store = ModelStore(settings.models_path, fake=fake_mode())
    recipes = load_recipes(catalog, settings.recipes_path)
    host = ModelHost(store, settings.vram_budget_bytes)
    return Runtime(settings, catalog, store, recipes, Pipeline(catalog, store, host))
