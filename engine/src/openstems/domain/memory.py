"""How much memory a model run needs, how much a machine has for it, and whether it fits.

Pure numbers: no torch, no I/O. Detection of the machine lives in ``engines/device.py``,
``procutil.py`` and ``doctor.py``; they hand their findings to `plan_memory`.

The figures:

- A catalog model carries ``memory_gb``: the peak GPU memory of one run at batch 1 with
  half precision (fp16 autocast) on CUDA, measured (docs/benchmarks.md).
- A model with no measurement (a custom one) gets an estimate: the checkpoint's size plus
  the largest activation memory measured for its architecture.
- At full precision (the Apple GPU, the CPU, GTX 900 and 10 series cards) the activations
  are taken to need twice as much. The weights do not change: autocast leaves them at full
  precision. Twice is the upper bound, not a measurement: it is an estimate until the models
  are measured on a Mac.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from openstems.domain.model import ModelSpec

GB = 1024**3

FITS = "fits"
TIGHT = "tight"
NO = "no"
_RANK = {FITS: 0, TIGHT: 1, NO: 2}

# Activations at full precision against half precision. Conservative: the upper bound.
FULL_PRECISION_FACTOR = 2.0
# A run that needs more than this share of the budget is "tight": within 15 percent of it.
TIGHT_SHARE = 0.85
# Memory the GPU shares with the whole machine (a Mac): leave this much for the system and
# the app, then use this share of the rest. 8 GB gives 4.5 GB, 16 GB gives 10.5 GB.
SHARED_RESERVE_BYTES = 2 * GB
SHARED_SHARE = 0.75
# On the CPU the model shares memory with everything, the decoded song included: half.
CPU_SHARE = 0.5
# Below this budget a machine is small: one warm model at most, released sooner.
SMALL_BUDGET_BYTES = 8 * GB
# The largest activation memory measured per architecture at half precision, in GB
# (docs/benchmarks.md, the 53-stem model left out). The estimate for unmeasured models.
ACTIVATIONS_GB = {"bs_roformer": 3.6, "mel_band_roformer": 1.4, "mdx23c": 0.7, "fake": 0.0}

CPU_NOTE = "ran on the CPU: not enough GPU memory"


def half_precision_bytes(spec: ModelSpec) -> int:
    """What one run needs at half precision: the measured figure, or the estimate."""
    if spec.memory_gb is not None:
        return int(spec.memory_gb * GB)
    allowance = ACTIVATIONS_GB.get(spec.architecture, max(ACTIVATIONS_GB.values()))
    return spec.checkpoint.size + int(allowance * GB)


def run_memory_bytes(spec: ModelSpec, full_precision: bool) -> int:
    """What one run of a model needs at batch 1, at the precision the machine runs at."""
    half = half_precision_bytes(spec)
    if not full_precision:
        return half
    weights = min(spec.checkpoint.size, half)
    return weights + int((half - weights) * FULL_PRECISION_FACTOR)


def memory_is_estimated(spec: ModelSpec, full_precision: bool) -> bool:
    """False only for a measured model on a machine that runs it the way it was measured."""
    return spec.memory_gb is None or full_precision


def run_budget_bytes(kind: str, memory_bytes: int | None) -> int | None:
    """The memory one model run may use. ``kind`` says where the model runs: "cuda" (a
    graphics card, NVIDIA or AMD: all of its memory), "mps" (a Mac, where the GPU shares
    the machine's memory) or "cpu". None when the machine's memory is not known."""
    if not memory_bytes or memory_bytes <= 0:
        return None
    if kind == "cuda":
        return int(memory_bytes)
    if kind == "mps":
        return max(0, int((memory_bytes - SHARED_RESERVE_BYTES) * SHARED_SHARE))
    return int(memory_bytes * CPU_SHARE)


def fit(need_bytes: int, budget_bytes: int | None) -> str:
    """ "fits", "tight" (it fits, with less than 15 percent to spare) or "no". A machine
    whose memory is not known is given the benefit of the doubt."""
    if budget_bytes is None or need_bytes <= budget_bytes * TIGHT_SHARE:
        return FITS
    return TIGHT if need_bytes <= budget_bytes else NO


def is_small(budget_bytes: int | None) -> bool:
    return budget_bytes is not None and budget_bytes < SMALL_BUDGET_BYTES


@dataclass(frozen=True)
class MemoryPlan:
    """A machine's memory, as far as one model run is concerned."""

    kind: str  # "cuda", "mps" or "cpu": where models run
    memory_bytes: int | None  # the card's memory, or the machine's: what the budget is cut from
    budget_bytes: int | None
    full_precision: bool
    overridden: bool = False  # OPENSTEMS_MEMORY_GB stood in for the detected memory

    @property
    def small(self) -> bool:
        return is_small(self.budget_bytes)

    def need(self, spec: ModelSpec) -> int:
        return run_memory_bytes(spec, self.full_precision)

    def fit(self, spec: ModelSpec) -> str:
        return fit(self.need(spec), self.budget_bytes)

    def largest(self, specs: Iterable[ModelSpec]) -> ModelSpec | None:
        """The model that decides whether a recipe fits. Models run one at a time, so a
        recipe is as large as its largest model."""
        return max(specs, key=self.need, default=None)


def plan_memory(
    kind: str,
    detected_bytes: int | None,
    full_precision: bool,
    override_bytes: int | None = None,
) -> MemoryPlan:
    """The plan for a machine. ``override_bytes`` (OPENSTEMS_MEMORY_GB) replaces what was
    detected, so a large machine can act as a small one."""
    memory = override_bytes or detected_bytes
    return MemoryPlan(
        kind=kind,
        memory_bytes=memory,
        budget_bytes=run_budget_bytes(kind, memory),
        full_precision=full_precision,
        overridden=bool(override_bytes),
    )


UNKNOWN = MemoryPlan("cpu", None, None, True)


def recommended_ids(models: Sequence[ModelSpec], plan: MemoryPlan) -> list[str]:
    """The models offered for the first download: the catalog's seed set, cut to what the
    machine can run. A seed model that does not fit gives its place to the first model for
    the same use that does (one that fits before one that is tight), or to nothing. On a
    machine where everything fits this is the seed set."""
    chosen: list[str] = []
    for spec in models:
        if not spec.seed:
            continue
        pick: ModelSpec | None = spec
        if plan.fit(spec) == NO:
            stand_ins = [
                m
                for m in models
                if not (m.seed or m.experimental or m.custom)
                and set(m.use_cases) & set(spec.use_cases)
                and plan.fit(m) != NO
            ]
            pick = min(stand_ins, key=lambda m: _RANK[plan.fit(m)], default=None)
        if pick is not None and pick.id not in chosen:
            chosen.append(pick.id)
    return chosen
