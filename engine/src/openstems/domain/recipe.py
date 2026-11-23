"""Recipes: a named, ordered set of passes plus derived stems and outputs.

A recipe works like a mixer insert chain. Each pass is one model run whose input is the
mix or a stem from an earlier pass. Derived stems are sums and differences of other
signals. Outputs name which signals become files.

Signal references: ``mix``, ``<pass>.<stem>``, or the name of a derived stem.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from openstems.domain.errors import DomainError

MIX = "mix"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]*$")


@dataclass(frozen=True)
class PassSpec:
    """One model run. Several models make it an ensemble: their outputs are averaged."""

    id: str
    models: tuple[str, ...]
    input: str = MIX
    stems: tuple[str, ...] = ()  # optional subset to keep; empty keeps everything

    @property
    def is_ensemble(self) -> bool:
        return len(self.models) > 1


@dataclass(frozen=True)
class DerivedStem:
    """A stem computed by sum and difference, sample-exact."""

    name: str
    add: tuple[str, ...]
    subtract: tuple[str, ...] = ()


@dataclass(frozen=True)
class OutputStem:
    """A file to write: its stem name and the signal it comes from."""

    name: str
    source: str


@dataclass(frozen=True)
class Recipe:
    id: str
    name: str
    version: int
    passes: tuple[PassSpec, ...]
    outputs: tuple[OutputStem, ...]
    derived: tuple[DerivedStem, ...] = ()
    use_case: str = ""
    description: str = ""
    residual_into: str | None = None  # output stem that absorbs the residual in sum-to-mix
    experimental: bool = False
    builtin: bool = True
    selectable_outputs: bool = False  # the user ticks which outputs to write (mega-53)
    choices: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        validate_recipe(self)

    @property
    def model_ids(self) -> tuple[str, ...]:
        seen: list[str] = []
        for p in self.passes:
            for m in p.models:
                if m not in seen:
                    seen.append(m)
        return tuple(seen)

    def to_dict(self) -> dict[str, Any]:
        """Canonical, JSON-ready form. Used for the manifest and the cache key."""
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "use_case": self.use_case,
            "passes": [
                {
                    "id": p.id,
                    "models": list(p.models),
                    "input": p.input,
                    "stems": list(p.stems),
                }
                for p in self.passes
            ],
            "derived": [
                {"name": d.name, "add": list(d.add), "subtract": list(d.subtract)}
                for d in self.derived
            ],
            "outputs": [{"stem": o.name, "from": o.source} for o in self.outputs],
            "residual_into": self.residual_into,
        }

    def with_outputs(self, names: list[str]) -> Recipe:
        """A copy that writes only the named outputs (for selectable recipes)."""
        wanted = [o for o in self.outputs if o.name in names]
        missing = set(names) - {o.name for o in wanted}
        if missing:
            raise DomainError(f"{self.id}: no such outputs: {sorted(missing)}")
        if not wanted:
            raise DomainError(f"{self.id}: pick at least one output stem")
        return Recipe(
            id=self.id,
            name=self.name,
            version=self.version,
            passes=self.passes,
            outputs=tuple(wanted),
            derived=self.derived,
            use_case=self.use_case,
            description=self.description,
            residual_into=self.residual_into if self.residual_into in names else None,
            experimental=self.experimental,
            builtin=self.builtin,
            selectable_outputs=self.selectable_outputs,
        )


def split_ref(ref: str) -> tuple[str, str] | None:
    """``pass.stem`` -> (pass, stem); ``mix`` or a derived name -> None."""
    if "." in ref:
        pass_id, stem = ref.split(".", 1)
        return pass_id, stem
    return None


def validate_recipe(recipe: Recipe) -> None:
    rid = recipe.id
    if not _ID_RE.match(rid):
        raise DomainError(f"recipe id {rid!r} must be lowercase letters, digits, - or _")
    if recipe.version < 1:
        raise DomainError(f"{rid}: version must be >= 1")
    if not recipe.passes:
        raise DomainError(f"{rid}: a recipe needs at least one pass")
    if not recipe.outputs:
        raise DomainError(f"{rid}: a recipe needs at least one output")

    pass_ids: list[str] = []
    for p in recipe.passes:
        if not _ID_RE.match(p.id) or p.id == MIX:
            raise DomainError(f"{rid}: bad pass id {p.id!r}")
        if p.id in pass_ids:
            raise DomainError(f"{rid}: duplicate pass id {p.id!r}")
        if not p.models:
            raise DomainError(f"{rid}: pass {p.id!r} names no model")
        if p.input != MIX:
            ref = split_ref(p.input)
            # A pass may only read the mix or a stem of an earlier pass: no cycles.
            if ref is None or ref[0] not in pass_ids:
                raise DomainError(
                    f"{rid}: pass {p.id!r} input {p.input!r} must be 'mix' or a stem "
                    "of an earlier pass"
                )
        pass_ids.append(p.id)

    derived_names: list[str] = []

    def check_ref(ref: str, where: str) -> None:
        if ref == MIX:
            return
        parts = split_ref(ref)
        if parts is not None:
            if parts[0] not in pass_ids:
                raise DomainError(f"{rid}: {where} references unknown pass {parts[0]!r}")
            return
        if ref not in derived_names:
            raise DomainError(f"{rid}: {where} references unknown signal {ref!r}")

    for d in recipe.derived:
        if not _STEM_RE.match(d.name) or d.name == MIX or "." in d.name:
            raise DomainError(f"{rid}: bad derived stem name {d.name!r}")
        if d.name in derived_names:
            raise DomainError(f"{rid}: duplicate derived stem {d.name!r}")
        if not d.add:
            raise DomainError(f"{rid}: derived stem {d.name!r} adds nothing")
        for ref in (*d.add, *d.subtract):
            check_ref(ref, f"derived stem {d.name!r}")
        derived_names.append(d.name)

    out_names: list[str] = []
    for o in recipe.outputs:
        if not _STEM_RE.match(o.name):
            raise DomainError(f"{rid}: bad output stem name {o.name!r}")
        if o.name in out_names:
            raise DomainError(f"{rid}: duplicate output stem {o.name!r}")
        check_ref(o.source, f"output {o.name!r}")
        out_names.append(o.name)

    if recipe.residual_into is not None and recipe.residual_into not in out_names:
        raise DomainError(f"{rid}: residual_into {recipe.residual_into!r} is not an output")


def check_against_models(recipe: Recipe, stems_of: Callable[[str], tuple[str, ...]]) -> None:
    """Check every ``pass.stem`` reference against the stems its models emit."""
    emitted: dict[str, set[str]] = {}
    for p in recipe.passes:
        sets = [set(stems_of(m)) for m in p.models]
        common = set.intersection(*sets)
        if p.is_ensemble and not common:
            raise DomainError(f"{recipe.id}: ensemble pass {p.id!r} models share no stem")
        if p.stems:
            unknown = set(p.stems) - common
            if unknown:
                raise DomainError(f"{recipe.id}: pass {p.id!r} keeps unknown stems {unknown}")
            common = set(p.stems)
        emitted[p.id] = common

    refs: list[str] = [p.input for p in recipe.passes]
    for d in recipe.derived:
        refs += [*d.add, *d.subtract]
    refs += [o.source for o in recipe.outputs]
    for ref in refs:
        parts = split_ref(ref)
        if parts and parts[1] not in emitted[parts[0]]:
            raise DomainError(
                f"{recipe.id}: {ref!r}: pass {parts[0]!r} does not emit {parts[1]!r} "
                f"(emits {sorted(emitted[parts[0]])})"
            )


def recipe_from_dict(data: Mapping[str, Any], *, builtin: bool = True) -> Recipe:
    """Build a recipe from parsed TOML."""
    try:
        passes = []
        for raw in data["passes"]:
            models = raw.get("models") or ([raw["model"]] if "model" in raw else [])
            passes.append(
                PassSpec(
                    id=raw["id"],
                    models=tuple(models),
                    input=raw.get("input", MIX),
                    stems=tuple(raw.get("stems", ())),
                )
            )
        derived = tuple(
            DerivedStem(
                name=raw["name"],
                add=tuple(raw.get("add", ())),
                subtract=tuple(raw.get("subtract", ())),
            )
            for raw in data.get("derived", ())
        )
        outputs = tuple(OutputStem(name=raw["stem"], source=raw["from"]) for raw in data["outputs"])
        return Recipe(
            id=data["id"],
            name=data.get("name", data["id"]),
            version=int(data.get("version", 1)),
            passes=tuple(passes),
            outputs=outputs,
            derived=derived,
            use_case=data.get("use_case", ""),
            description=data.get("description", ""),
            residual_into=data.get("residual_into"),
            experimental=bool(data.get("experimental", False)),
            builtin=builtin,
            selectable_outputs=bool(data.get("selectable_outputs", False)),
        )
    except KeyError as exc:
        raise DomainError(f"recipe is missing field {exc.args[0]!r}") from exc


def single_model_recipe(model_id: str, stems: tuple[str, ...], name: str = "") -> Recipe:
    """A one-pass recipe generated on the fly for a single-model run."""
    safe = re.sub(r"[^a-z0-9_-]+", "-", model_id.lower()).strip("-") or "model"
    return Recipe(
        id=f"model-{safe}",
        name=name or model_id,
        version=1,
        passes=(PassSpec(id="m", models=(model_id,)),),
        outputs=tuple(OutputStem(name=s, source=f"m.{s}") for s in stems),
        use_case="single-model",
        description=f"Single model run: {model_id}",
        builtin=False,
    )
