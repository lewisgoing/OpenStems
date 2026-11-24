"""Run a recipe on a track: passes, input wiring, derived stems, sum-to-mix, manifest."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np

from openstems import __version__
from openstems.audio import decode as audio_decode
from openstems.audio.write import extension, write_audio, write_peaks
from openstems.catalog.catalog import Catalog
from openstems.catalog.store import ModelStore
from openstems.domain.errors import Cancelled, DomainError, OutOfMemory
from openstems.domain.grid import SongPart, clean_selection, part_downbeat
from openstems.domain.memory import CPU_NOTE
from openstems.domain.model import ModelSpec
from openstems.domain.naming import DEFAULT_TEMPLATE, render_name, safe_component
from openstems.domain.quality import RunSettings, resolve_settings
from openstems.domain.recipe import MIX, Recipe, check_against_models, split_ref
from openstems.domain.stem import (
    MANIFEST_NAME,
    MANIFEST_SCHEMA,
    Stem,
    StemSet,
    Track,
    cache_key,
)
from openstems.domain.tempo import tempo_notes
from openstems.engines.base import CancelToken
from openstems.engines.host import ModelHost

PEAKS_DIR = ".peaks"
SAMPLE_RATE = 44100


@dataclass
class RunOptions:
    quality: str = "balanced"
    sum_to_mix: bool = False
    output_format: str = "wav32f"
    naming_template: str = DEFAULT_TEMPLATE
    match_source_rate: bool = False
    outputs: list[str] | None = None  # subset of output stems (selectable recipes)
    trim_silence: bool = False
    normalize: bool = False
    detect_tempo_key: bool = False
    tempo_sync: bool = False
    # The user's own tempo, key and bar 1 (seconds into the song) for this song, in place
    # of what detection finds. Not part of the cache key: a cached result is re-tagged, not
    # separated again.
    bpm: float | None = None
    key: str | None = None
    downbeat: float | None = None
    midi_stems: list[str] = field(default_factory=list)
    force: bool = False
    # A part of the song to separate alone, as a song of its own: a job's `range` while the
    # separate_selection setting is on (`Runtime.options`). None: the whole song.
    part: SongPart | None = None

    def key_dict(self) -> dict[str, Any]:
        return {
            "format": self.output_format,
            "template": self.naming_template,
            "match_source_rate": self.match_source_rate,
            "trim_silence": self.trim_silence,
            "normalize": self.normalize,
            "tempo_key": self.detect_tempo_key,
            "midi": sorted(self.midi_stems),
            # Only when on, so the cache key of every earlier run stays what it was.
            **({"tempo_sync": True} if self.tempo_sync else {}),
            # Only for a part, so every other run keeps its key: the frames separated.
            **({"range": list(self.part.frames(SAMPLE_RATE))} if self.part else {}),
        }


@dataclass(frozen=True)
class Progress:
    stage: str  # preparing | running | writing | done
    fraction: float  # overall, 0..1
    message: str = ""


ProgressCallback = Callable[[Progress], None]

# Share of the overall bar given to each stage.
_PREP = 0.05
_WRITE = 0.05


def hash_file(path: Path, cancel: CancelToken | None = None) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while block := handle.read(4 * 1024 * 1024):
            if cancel is not None:
                cancel.raise_if_cancelled()
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def output_dir_for(output_root: Path, track_name: str, recipe_id: str) -> Path:
    return output_root / safe_component(track_name) / safe_component(recipe_id)


def read_manifest(directory: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((directory / MANIFEST_NAME).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("schema") == MANIFEST_SCHEMA else None


def stem_set_from_manifest(directory: Path, manifest: dict[str, Any]) -> StemSet | None:
    """Rebuild a StemSet from a manifest; ``None`` unless it is complete and every file exists."""
    if not manifest.get("complete"):
        return None
    stems: list[Stem] = []
    for raw in manifest.get("stems", []):
        if not (directory / raw["file"]).is_file():
            return None
        stems.append(
            Stem(
                name=raw["name"],
                file=raw["file"],
                samples=raw["samples"],
                sample_rate=raw["sample_rate"],
                source=raw.get("source", ""),
                pass_id=raw.get("pass"),
                models=tuple(raw.get("models", ())),
                settings=raw.get("settings"),
                peaks=raw.get("peaks"),
                midi=raw.get("midi"),
                offset=raw.get("offset", 0),
                group=raw.get("group", ""),
            )
        )
    return StemSet(directory=str(directory), manifest=manifest, stems=stems)


class Pipeline:
    def __init__(self, catalog: Catalog, store: ModelStore, host: ModelHost | None = None) -> None:
        self.catalog = catalog
        self.store = store
        self.host = host or ModelHost(store)

    # -- planning -------------------------------------------------------------

    def plan(
        self, recipe: Recipe, options: RunOptions
    ) -> tuple[Recipe, dict[str, RunSettings], dict[str, str]]:
        """Resolve outputs, per-model settings and model hashes. Raises if a model is missing."""
        if options.outputs is not None:
            recipe = recipe.with_outputs(options.outputs)
        check_against_models(recipe, self.catalog.stems_of)
        settings: dict[str, RunSettings] = {}
        hashes: dict[str, str] = {}
        for model_id in recipe.model_ids:
            spec = self.catalog.get(model_id)
            self.store.require(spec)
            settings[model_id] = resolve_settings(options.quality, spec)
            hashes[model_id] = spec.checkpoint.sha256
        return recipe, settings, hashes

    def key_for(
        self,
        track_hash: str,
        recipe: Recipe,
        settings: dict[str, RunSettings],
        hashes: dict[str, str],
        options: RunOptions,
    ) -> str:
        return cache_key(
            track_hash,
            recipe.to_dict(),
            {
                "quality": options.quality,
                "sum_to_mix": options.sum_to_mix,
                "models": {m: s.key_dict() for m, s in settings.items()},
            },
            hashes,
            options.key_dict(),
        )

    # -- run ------------------------------------------------------------------

    @staticmethod
    def _retagged(out_dir: Path, cached: StemSet, options: RunOptions) -> StemSet:
        """A cached result with the tempo, key and bar 1 this run was given, if any."""
        from openstems.pipeline.retag import set_analysis

        given = (("bpm", options.bpm), ("key", options.key), ("downbeat", options.downbeat))
        changes = {k: v for k, v in given if v is not None}
        if not changes:
            return cached
        return stem_set_from_manifest(out_dir, set_analysis(out_dir, changes)) or cached

    def run(
        self,
        track_path: str | Path,
        recipe: Recipe,
        output_root: str | Path,
        options: RunOptions | None = None,
        progress: ProgressCallback | None = None,
        cancel: CancelToken | None = None,
    ) -> StemSet:
        options = options or RunOptions()
        cancel = cancel or CancelToken()
        source = Path(track_path)
        if not source.is_file():
            raise DomainError(f"no such file: {source}")

        def report(stage: str, fraction: float, message: str = "") -> None:
            if progress is not None:
                progress(Progress(stage, max(0.0, min(1.0, fraction)), message))

        report("preparing", 0.0, "Hashing")
        recipe, settings, hashes = self.plan(recipe, options)
        digest, size = hash_file(source, cancel)
        part = options.part
        track = Track(
            path=str(source.resolve()),
            content_hash=digest,
            size=size,
            part=part.label if part is not None else "",
        )
        if part is not None and options.downbeat is not None:
            # Bar 1 as the part has it, before the cache is looked at: a cached part takes it.
            options = replace(
                options, downbeat=part_downbeat(options.downbeat, part.start, options.bpm)
            )
        key = self.key_for(digest, recipe, settings, hashes, options)
        out_dir = output_dir_for(Path(output_root), track.name, recipe.id)

        if not options.force:
            existing = read_manifest(out_dir)
            if existing is not None and existing.get("cache_key") == key:
                cached = stem_set_from_manifest(out_dir, existing)
                if cached is not None:
                    cached = self._retagged(out_dir, cached, options)
                    cached.cached = True
                    report("done", 1.0, "From cache")
                    return cached

        report("preparing", 0.01, "Decoding")
        info = audio_decode.probe(source)
        mix = audio_decode.decode(
            source,
            SAMPLE_RATE,
            progress=lambda f: report("preparing", 0.01 + f * (_PREP - 0.01), "Decoding"),
            should_cancel=lambda: cancel.cancelled,
        )
        if part is not None:
            mix, part = _cut(mix, part)
            options = replace(options, part=part)  # where it was cut, for the manifest
        samples = mix.shape[1]

        signals, provenance, notes = self._run_passes(recipe, settings, mix, report, cancel)
        outputs = self._collect_outputs(recipe, signals, mix, options)
        for name, audio in outputs.items():
            if audio.shape != mix.shape:
                raise DomainError(
                    f"stem {name!r} has shape {audio.shape}, expected {mix.shape}: alignment broken"
                )
        del signals

        report("writing", 1.0 - _WRITE, "Writing stems")
        extras = self._post_process(track, mix, outputs, options, report, cancel)
        notes = [*notes, *tempo_notes(options.tempo_sync, options.output_format, extras.get("bpm"))]
        stem_set = self._write(
            track,
            info,
            recipe,
            settings,
            hashes,
            provenance,
            outputs,
            samples,
            key,
            out_dir,
            options,
            extras,
            notes,
            report,
            cancel,
        )
        report("done", 1.0, "Done")
        return stem_set

    def _run_passes(
        self,
        recipe: Recipe,
        settings: dict[str, RunSettings],
        mix: np.ndarray,
        report: Callable[[str, float, str], None],
        cancel: CancelToken,
    ) -> tuple[dict[str, np.ndarray], dict[str, dict[str, Any]], list[str]]:
        """Run every pass in order. Returns the signals, the provenance of each pass and
        the notes: what did not go as planned, such as a model that ran on the CPU."""
        on_cpu: set[str] = set()  # models that did not fit on the GPU in this run
        try:
            signals, provenance = self._passes(recipe, settings, mix, report, cancel, on_cpu)
        finally:
            # The CPU was for this job only: the next one tries the GPU again.
            for model_id in on_cpu:
                self.host.evict(model_id)
        notes = [f"{self.catalog.get(m).name} {CPU_NOTE}" for m in recipe.model_ids if m in on_cpu]
        return signals, provenance, notes

    def _passes(
        self,
        recipe: Recipe,
        settings: dict[str, RunSettings],
        mix: np.ndarray,
        report: Callable[[str, float, str], None],
        cancel: CancelToken,
        on_cpu: set[str],
    ) -> tuple[dict[str, np.ndarray], dict[str, dict[str, Any]]]:
        needed = _needed_stems(recipe)
        signals: dict[str, np.ndarray] = {MIX: mix}
        provenance: dict[str, dict[str, Any]] = {}
        runs = sum(len(p.models) for p in recipe.passes)
        span = 1.0 - _PREP - _WRITE
        done_runs = 0

        for p in recipe.passes:
            cancel.raise_if_cancelled()
            source = signals[p.input]
            keep = frozenset(needed.get(p.id, ()))
            sums: dict[str, np.ndarray] = {}
            for model_id in p.models:
                spec = self.catalog.get(model_id)
                label = f"{spec.name}" if len(recipe.passes) == 1 else f"{p.id}: {spec.name}"
                base = _PREP + span * done_runs / runs
                report("running", base, f"Loading {spec.name}")

                def on_progress(
                    f: float, base: float = base, label: str = label, model_id: str = model_id
                ) -> None:
                    suffix = " (on the CPU)" if model_id in on_cpu else ""
                    report("running", base + span * f / runs, label + suffix)

                def moved_to_cpu(base: float = base, name: str = spec.name) -> None:
                    report("running", base, f"Not enough GPU memory: {name} runs on the CPU")

                out = self._separate(
                    spec, source, settings[model_id], on_progress, cancel, keep, on_cpu,
                    moved_to_cpu,
                )  # fmt: skip
                for stem, audio in out.items():
                    if stem in sums:
                        sums[stem] += audio
                    else:
                        sums[stem] = audio
                done_runs += 1
            if p.is_ensemble:
                # Ensemble: a plain waveform average of the models' outputs.
                scale = np.float32(1.0 / len(p.models))
                for audio in sums.values():
                    audio *= scale
            for stem, audio in sums.items():
                signals[f"{p.id}.{stem}"] = audio
            provenance[p.id] = {
                "input": p.input,
                "models": [
                    {
                        "id": m,
                        "sha256": self.catalog.get(m).checkpoint.sha256,
                        "settings": settings[m].as_dict(),
                        **({"device": "cpu"} if m in on_cpu else {}),
                    }
                    for m in p.models
                ],
            }
        return signals, provenance

    def _separate(
        self,
        spec: ModelSpec,
        source: np.ndarray,
        settings: RunSettings,
        on_progress: Callable[[float], None],
        cancel: CancelToken,
        keep: frozenset[str],
        on_cpu: set[str],
        moved_to_cpu: Callable[[], None],
    ) -> dict[str, np.ndarray]:
        """Run one model. When memory runs out, loading or running, the run degrades
        instead of failing: the runner has already tried smaller batches, so first every
        other warm model is dropped and the model tried again, then it runs on the CPU for
        this job. ``on_cpu`` collects the models that ended up there. A machine that runs
        on the CPU anyway has only the first of those steps: no move, and no note."""
        if spec.id not in on_cpu:
            for attempt in range(2):
                loaded = None
                try:
                    loaded = self.host.get(spec)
                    return loaded.separate(source, settings, on_progress, cancel, keep)
                except Exception as exc:
                    if not _out_of_memory(exc):
                        raise
                    # Other warm models may be holding the memory: worth one more try.
                    retry = not attempt and any(m != spec.id for m in self.host.loaded_ids)
                    # A failed load leaves no model to ask where it ran.
                    cpu_already = (
                        self.host.loads_on_cpu(spec) if loaded is None else _runs_on_cpu(loaded)
                    )
                    if cpu_already and not retry:
                        raise DomainError(_NO_MEMORY.format(name=spec.name)) from exc
                del loaded
                if not retry:
                    break
                self.host.release()
            on_cpu.add(spec.id)
            moved_to_cpu()
            # Nothing may stay on the GPU: on a Mac the CPU run draws on the same memory.
            self.host.release()
        try:
            return self.host.get(spec, device="cpu").separate(
                source, settings, on_progress, cancel, keep
            )
        except Exception as exc:
            if not _out_of_memory(exc):
                raise
            raise DomainError(_NO_MEMORY.format(name=spec.name)) from exc

    def _collect_outputs(
        self,
        recipe: Recipe,
        signals: dict[str, np.ndarray],
        mix: np.ndarray,
        options: RunOptions,
    ) -> dict[str, np.ndarray]:
        for d in recipe.derived:
            # Sample-exact: plain float32 adds and subtracts in the order written.
            total = signals[d.add[0]].copy()
            for ref in d.add[1:]:
                total += signals[ref]
            for ref in d.subtract:
                total -= signals[ref]
            signals[d.name] = total

        outputs = {o.name: signals[o.source] for o in recipe.outputs}
        if options.sum_to_mix and recipe.residual_into in outputs:
            # Fold what the stems do not account for into one stem, so they sum to the mix.
            residual = mix.astype(np.float64)
            for audio in outputs.values():
                residual -= audio
            target = recipe.residual_into
            outputs[target] = (outputs[target].astype(np.float64) + residual).astype(np.float32)
        return outputs

    def _post_process(
        self,
        track: Track,
        mix: np.ndarray,
        outputs: dict[str, np.ndarray],
        options: RunOptions,
        report: Callable[[str, float, str], None],
        cancel: CancelToken,
    ) -> dict[str, Any]:
        """Hook for optional producer features. The defaults change nothing."""
        from openstems.pipeline.extras import post_process

        return post_process(track, mix, outputs, options, cancel, SAMPLE_RATE)

    def _write(
        self,
        track: Track,
        info: audio_decode.AudioInfo,
        recipe: Recipe,
        settings: dict[str, RunSettings],
        hashes: dict[str, str],
        provenance: dict[str, dict[str, Any]],
        outputs: dict[str, np.ndarray],
        samples: int,
        key: str,
        out_dir: Path,
        options: RunOptions,
        extras: dict[str, Any],
        notes: list[str],
        report: Callable[[str, float, str], None],
        cancel: CancelToken,
    ) -> StemSet:
        """Write everything to a temp folder, then move it into place. A cancel or a
        failure removes the temp folder, so no partial files are ever left behind."""
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        _remove_stale_temp(out_dir)
        tmp = out_dir.parent / f".{out_dir.name}.tmp-{uuid.uuid4().hex[:8]}"
        tmp.mkdir()
        (tmp / PEAKS_DIR).mkdir()
        ext = extension(options.output_format)
        out_rate = SAMPLE_RATE
        if options.match_source_rate and info.sample_rate and info.sample_rate != SAMPLE_RATE:
            out_rate = info.sample_rate
        tokens = {
            "track": track.name,
            "recipe": recipe.id,
            "bpm": str(extras.get("bpm") or ""),
            "key": str(extras.get("key") or ""),
        }
        try:
            stems: list[Stem] = []
            used: set[str] = set()
            for n, out in enumerate(recipe.outputs):
                cancel.raise_if_cancelled()
                audio = outputs[out.name]
                parts = split_ref(out.source)
                prov = provenance.get(parts[0]) if parts else None
                base = render_name(options.naming_template, stem=out.name, **tokens)
                if base.lower() in used:
                    base = f"{base} ({n + 1})"
                used.add(base.lower())
                file_name = base + ext
                peaks_name = f"{PEAKS_DIR}/{safe_component(out.name)}.json"
                trimmed = extras.get("trim", {}).get(out.name)
                final = audio if trimmed is None else trimmed
                # Peaks describe the file as written, at the rate the app plays it back.
                write_peaks(tmp / peaks_name, final, SAMPLE_RATE)
                if out_rate != SAMPLE_RATE:
                    wanted = round(final.shape[1] * out_rate / SAMPLE_RATE)
                    final = _fit_length(audio_decode.resample(final, SAMPLE_RATE, out_rate), wanted)
                bpm = extras.get("bpm") if options.tempo_sync else None
                write_audio(tmp / file_name, final, out_rate, options.output_format, bpm)
                midi_name = None
                midi_writer = extras.get("midi", {}).get(out.name)
                if midi_writer is not None:
                    midi_name = base + ".mid"
                    midi_writer(tmp / midi_name)
                stems.append(
                    Stem(
                        name=out.name,
                        file=file_name,
                        samples=int(final.shape[1]),
                        sample_rate=out_rate,
                        source=out.source,
                        pass_id=parts[0] if parts else None,
                        models=tuple(prov["models"]) if prov else (),
                        settings={"input": prov["input"]} if prov else None,
                        peaks=peaks_name,
                        midi=midi_name,
                        offset=int(extras.get("offsets", {}).get(out.name, 0)),
                        group=out.group,
                    )
                )
                report(
                    "writing",
                    1.0 - _WRITE + _WRITE * (n + 1) / len(recipe.outputs),
                    f"Writing {out.name}",
                )

            manifest: dict[str, Any] = {
                "schema": MANIFEST_SCHEMA,
                "app": {"name": "OpenStems", "version": __version__},
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "cache_key": key,
                "complete": True,
                "source": {
                    "path": track.path,
                    "name": track.name,
                    "sha256": track.content_hash,
                    "bytes": track.size,
                    "sample_rate": info.sample_rate,
                    "channels": info.channels,
                    "codec": info.codec,
                    "decoded_samples": samples,
                    "decoded_sample_rate": SAMPLE_RATE,
                    "duration": round(samples / SAMPLE_RATE, 6),
                    # The part of the file these stems are, when only a part of it was
                    # separated: their timeline starts at its start. The samples and the
                    # duration above are the part's.
                    **({"range": options.part.to_dict()} if options.part else {}),
                },
                "analysis": {
                    "bpm": extras.get("bpm"),
                    "key": extras.get("key"),
                    # Where bar 1 starts, in seconds into the song: the beat grid's anchor.
                    "downbeat": _seconds(extras.get("downbeat")),
                    # What detection found, when the user's figures replaced it.
                    **({"detected": extras["detected"]} if extras.get("detected") else {}),
                },
                "recipe": recipe.to_dict(),
                "quality": options.quality,
                "options": {"sum_to_mix": options.sum_to_mix, **options.key_dict()},
                "passes": provenance,
                "derived": [
                    {"name": d.name, "add": list(d.add), "subtract": list(d.subtract)}
                    for d in recipe.derived
                ],
                "stems": [s.to_dict() for s in stems],
                # What did not go as planned, in plain words. Empty for an ordinary run.
                "notes": notes,
            }
            (tmp / MANIFEST_NAME).write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            cancel.raise_if_cancelled()
            _replace_dir(tmp, out_dir)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        return StemSet(directory=str(out_dir), manifest=manifest, stems=stems)


_NO_MEMORY = (
    "{name}: not enough memory to run this model, even on the CPU. "
    "Close other apps and try again, or choose a smaller model."
)


def _out_of_memory(exc: BaseException) -> bool:
    """Whether a load or a run failed for lack of memory, on any device."""
    if isinstance(exc, (OutOfMemory, MemoryError)):
        return True
    # Imported here: the API process reads manifests through this module without torch.
    from openstems.engines.device import is_oom

    # "mps" lets the Apple GPU's "Invalid buffer size" count as well. A failed load has no
    # model to ask for its device, and no other device words an error that way.
    return is_oom(exc, "mps")


def _runs_on_cpu(loaded: object) -> bool:
    return str(getattr(loaded, "device", "")).startswith("cpu")


def _seconds(value: float | None) -> float | None:
    """A time for the manifest, to a tenth of a millisecond."""
    return None if value is None else round(float(value), 4)


def _needed_stems(recipe: Recipe) -> dict[str, set[str]]:
    """Which stems of each pass are referenced anywhere. Others are never computed."""
    refs: list[str] = [p.input for p in recipe.passes]
    for d in recipe.derived:
        refs += [*d.add, *d.subtract]
    refs += [o.source for o in recipe.outputs]
    # Derived stems that nothing outputs still need their inputs only if they are used,
    # but keeping them all is harmless: recipes are small.
    needed: dict[str, set[str]] = {}
    for ref in refs:
        parts = split_ref(ref)
        if parts:
            needed.setdefault(parts[0], set()).add(parts[1])
    return needed


def _cut(mix: np.ndarray, part: SongPart) -> tuple[np.ndarray, SongPart]:
    """The part of a decoded song to separate alone, and where it was cut: kept inside the
    song as it decoded, and cut sample-exact at the engine's rate from the frames a clip of
    the same selection is cut from (`SongPart.frames`). A copy, so the whole song is freed."""
    try:
        start, end = clean_selection(part.start, part.end, mix.shape[1] / SAMPLE_RATE)
    except DomainError:
        raise DomainError(f"the part to separate ({part.label}) is not in the song") from None
    cut = SongPart(start, end, part.label)
    first, frames = cut.frames(SAMPLE_RATE)
    return _fit_length(np.ascontiguousarray(mix[:, first : first + frames]), frames), cut


def _fit_length(audio: np.ndarray, samples: int) -> np.ndarray:
    """Trim or zero-pad to an exact length (a resampler can be off by a few samples)."""
    if audio.shape[1] == samples:
        return audio
    if audio.shape[1] > samples:
        return np.ascontiguousarray(audio[:, :samples])
    pad = np.zeros((audio.shape[0], samples - audio.shape[1]), dtype=audio.dtype)
    return np.concatenate([audio, pad], axis=1)


def _remove_stale_temp(out_dir: Path, max_age: float = 600.0) -> None:
    """Remove our own temp folders left by a run that was killed outright."""
    now = time.time()
    for stale in out_dir.parent.glob(f".{out_dir.name}.tmp-*"):
        try:
            if stale.is_dir() and now - stale.stat().st_mtime > max_age:
                shutil.rmtree(stale, ignore_errors=True)
        except OSError:
            continue


def _replace_dir(tmp: Path, out_dir: Path) -> None:
    """Swap a finished temp folder into place. An existing result of ours is replaced:
    only files named by its manifest (and its peaks) are removed, never anything else."""
    if out_dir.exists():
        old = read_manifest(out_dir)
        if old is not None:
            for raw in old.get("stems", []):
                for name in (raw.get("file"), raw.get("midi")):
                    if name:
                        (out_dir / name).unlink(missing_ok=True)
        (out_dir / MANIFEST_NAME).unlink(missing_ok=True)
        shutil.rmtree(out_dir / PEAKS_DIR, ignore_errors=True)
        for item in tmp.iterdir():
            target = out_dir / item.name
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            os.replace(item, target)
        tmp.rmdir()
    else:
        os.replace(tmp, out_dir)


__all__ = [
    "Cancelled",
    "Pipeline",
    "Progress",
    "RunOptions",
    "hash_file",
    "output_dir_for",
    "read_manifest",
    "stem_set_from_manifest",
]
