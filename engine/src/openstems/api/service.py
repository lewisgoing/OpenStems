"""Everything the API routes need, in one object: runtime, index, queue, downloads."""

from __future__ import annotations

import contextlib
import json
import math
import os
import platform
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from openstems import __version__
from openstems.api.db import Index
from openstems.api.downloads import DownloadManager
from openstems.api.events import EventBus
from openstems.api.jobs import STARTED, JobManager
from openstems.api.links import LinkManager
from openstems.api.watcher import FolderWatcher
from openstems.audio.decode import probe
from openstems.cli_inputs import expand_inputs
from openstems.doctor import DoctorReport
from openstems.domain.errors import DomainError
from openstems.domain.grid import clean_selection, make_grid
from openstems.domain.memory import GB, MemoryPlan, memory_is_estimated, recommended_ids
from openstems.domain.naming import clean_name, safe_component
from openstems.domain.recipe import Recipe, single_model_recipe
from openstems.domain.stem import StemSet, Track
from openstems.engines.host import fake_mode, memory_plan
from openstems.links import Fetched, check_url
from openstems.procutil import physical_memory_bytes
from openstems.runtime import Runtime, build_runtime
from openstems.settings import config_dir, gpu_allowed, update_settings

SELFTEST_FILE = "selftest.json"
# The doctor's last report, kept in the cache folder between starts.
MACHINE_FILE = "machine.json"
# Songs fetched from links are kept here, inside the output folder: the user chose that
# drive for large files, and the watch folder never looks into it.
LINKS_DIR = "_links"
# Songs as the app plays and draws them before separation, in the cache folder.
PREVIEWS_DIR = "previews"
ACTIVE_STATES = ("queued", "preparing", "running", "writing")
RUNNING_STATES = ("preparing", "running", "writing")
RENAME_BUSY = "this song is being separated: rename it when it is done"


def _cli_json(args: list[str], timeout: float) -> tuple[dict[str, Any] | None, list[str]]:
    """Run one of the engine's own commands in a process of its own and read the JSON it
    prints. The API process never imports torch: what needs the GPU is asked this way.
    Returns the report, or None and why there is none."""
    command = [sys.executable, "-m", "openstems.cli", *args, "--json"]
    try:
        done = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env={**os.environ, "PYTHONUTF8": "1", "NO_COLOR": "1"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, [f"did not finish in {timeout:.0f} s."]
    except OSError as exc:
        return None, [f"could not start: {exc}"]
    start = done.stdout.find("{")
    try:
        report = json.loads(done.stdout[start:]) if start >= 0 else None
    except ValueError:
        report = None
    if not isinstance(report, dict):
        tail = (done.stderr or done.stdout).strip().splitlines()[-6:]
        return None, [f"crashed (exit code {done.returncode}).", *tail]
    return report, []


def run_selftest_process(timeout: float = 1800.0) -> dict[str, Any]:
    """The self-test's JSON report. It exits 1 on a mismatch and still prints the report."""
    report, why = _cli_json(["selftest"], timeout)
    if report is None:
        return {"ok": False, "problems": [f"The self-test {why[0]}", *why[1:]]}
    return report


def run_doctor_process(timeout: float = 120.0) -> DoctorReport:
    """The doctor's report, from a process of its own: it imports torch and touches the
    GPU, which the API process must not do, or it would hold GPU memory next to the worker
    for as long as the app runs. A check that fails is a report with that one problem and
    the CPU's budget."""
    data, why = _cli_json(["doctor"], timeout)
    if data is not None:
        try:
            return DoctorReport.from_dict(data)
        except TypeError as exc:
            why = [f"gave an unexpected report: {exc}"]
    ram = physical_memory_bytes()
    return DoctorReport(
        python=platform.python_version(),
        torch=None,
        cuda_available=False,
        cuda_version=None,
        gpu_name=None,
        vram_gb=None,
        ffmpeg=None,
        ffmpeg_decode_ok=True,  # not known: the one problem below says what is
        problems=[f"The system check {why[0]}", *why[1:]],
        ram_gb=ram / GB if ram else None,
    )


def _gb(size: int | None) -> float | None:
    return None if size is None else round(size / GB, 2)


def _path_key(path: str) -> str:
    """A path as it compares: absolute, normalized, and without case on Windows."""
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def _song_name(path: str, part: str, title: str | None) -> str:
    """The name a song's folder and stems go by: the user's name for it or else its
    file's, and the label of the part when only a part of it was separated."""
    return Track(path=path, content_hash="", size=0, part=part, title=title or "").name


def _folders_of(job: dict[str, Any]) -> set[str]:
    """The song folders a job that is running may be writing to, by name and without
    case: the whole song's, and its part's when it has one chosen."""
    title = job["options"].get("name")
    part = str((job["options"].get("range") or {}).get("label") or "")
    names = {_song_name(job["track_path"], "", title)}
    if part:
        names.add(_song_name(job["track_path"], part, title))
    return {safe_component(name).lower() for name in names}


def _job_stems(where: str, result: StemSet) -> list[dict[str, Any]]:
    """The stems of the stem folder ``where`` as a job lists them."""
    from openstems.pipeline.levels import mark_empty
    from openstems.pipeline.run import SAMPLE_RATE

    return mark_empty(
        [
            {
                "name": s.name,
                "file": s.file,
                "path": os.path.join(where, s.file),
                "peaks": os.path.join(where, s.peaks) if s.peaks else None,
                "midi": os.path.join(where, s.midi) if s.midi else None,
                "notes": os.path.join(where, s.notes) if s.notes else None,
                "offset": s.offset,
                "start": s.offset / SAMPLE_RATE,
                "samples": s.samples,
                "sample_rate": s.sample_rate,
                "group": s.group or None,
                "peak": s.peak,
                "hidden": s.hidden,
            }
            for s in result.stems
        ]
    )


class Service:
    def __init__(self) -> None:
        self.bus = EventBus()
        self.runtime: Runtime = build_runtime()
        self.index = Index(self.runtime.settings.cache_path / "index.sqlite")
        self.jobs = JobManager(self.index, self.bus)
        self.downloads = DownloadManager(self.bus)
        self.links = LinkManager(self.bus, self._links_root, self._queue_fetched)
        self.watcher = FolderWatcher(self._queue_watched)
        self._doctor: DoctorReport | None = None  # what the doctor found on this machine
        self._examined = False  # the doctor ran since this process started
        self._system_lock = threading.Lock()
        self._rename_lock = threading.Lock()  # one rename on the disk at a time
        # One lock per clip folder and per preview: two requests that arrive together
        # must not write the same file twice.
        self._locks: dict[tuple[str, str], threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        self.index.prune_missing()
        self.index.mark_empty_stems()
        self.jobs.start()
        self._configure_watcher()
        self.watcher.start()
        if not fake_mode():
            self._doctor = self._read_machine()
            threading.Thread(target=self._refresh_machine, name="machine", daemon=True).start()

    def _configure_watcher(self) -> None:
        settings = self.runtime.settings
        self.watcher.configure(
            settings.watch_folder, settings.watch_enabled, exclude=settings.output_path
        )

    def _queue_watched(self, path: Path) -> None:
        """A new file in the watch folder: queue it with the default recipe and quality."""
        settings = self.runtime.settings
        try:
            # Nobody is there to press Start for a watched file: it always runs.
            self.create_job(
                str(path), settings.default_recipe, None, settings.default_quality, {}, start=True
            )
        except DomainError as exc:
            self.bus.publish("notice", level="error", message=f"Watch folder: {path.name}: {exc}")

    def stop(self) -> None:
        self.watcher.stop()
        self.links.stop()
        self.downloads.stop()
        self.jobs.stop()
        self.index.close()

    def reload(self) -> None:
        self.runtime = build_runtime()

    # -- system ---------------------------------------------------------------

    def _report(self) -> DoctorReport:
        """What the doctor found on this machine. It runs once, in its own process, and
        two requests that arrive together must not both start it."""
        with self._system_lock:
            if self._doctor is None:
                self._doctor = self._examine()
            return self._doctor

    def _examine(self) -> DoctorReport:
        report = run_doctor_process()
        self._examined = True
        if report.torch is not None:  # a check that did not finish is not worth keeping
            self._write_machine(report)
        return report

    def _machine_file(self) -> Path:
        return self.runtime.settings.cache_path / MACHINE_FILE

    def _read_machine(self) -> DoctorReport | None:
        """The report an earlier start of this version left behind, so the app does not
        wait for the doctor every time it starts."""
        try:
            data = json.loads(self._machine_file().read_text(encoding="utf-8"))
            if data.get("version") != __version__:
                return None
            return DoctorReport.from_dict(data["report"])
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return None

    def _write_machine(self, report: DoctorReport) -> None:
        try:
            path = self._machine_file()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"version": __version__, "report": report.to_dict()}, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _refresh_machine(self) -> None:
        """Look at the machine again at each start, off the request path: a card, a driver
        or the engine build may have changed since the kept report was written. On a first
        start nothing is kept, and the first requests wait here for the doctor."""
        with self._system_lock:
            known = self._doctor
            if known is None:
                self._doctor = self._examine()
                return
            if self._examined:
                return
        report = run_doctor_process()
        self._examined = True
        if report.torch is None or report == known:
            return
        with self._system_lock:
            self._doctor = report
        self._write_machine(report)
        # The budget, and with it every fit, may have changed.
        self.bus.publish("worker.status", **self.jobs.worker_status)
        self.bus.publish("models.changed", id=None)

    def memory(self) -> MemoryPlan:
        """What one model run may use on this machine, as the settings stand now."""
        if fake_mode():
            return memory_plan(fake=True)
        return self._report().memory_plan(use_gpu=gpu_allowed())

    def system(self) -> dict[str, Any]:
        plan = self.memory()
        return {
            "version": __version__,
            **self._inspect(),
            "memory_gb": _gb(plan.memory_bytes),
            "memory_budget_gb": _gb(plan.budget_bytes),
            "memory_kind": plan.kind,
            "memory_overridden": plan.overridden,
            "fake_engine": fake_mode(),
            "worker": self.jobs.worker_status,
            "config_dir": str(config_dir()),
            "logs_dir": str(self.runtime.settings.logs_path),
        }

    def _inspect(self) -> dict[str, Any]:
        if fake_mode():
            return {
                "python": platform.python_version(),
                "torch": None,
                "cuda_available": False,
                "cuda_version": None,
                "gpu_backend": None,
                "gpu_backend_version": None,
                "gpu_name": "FakeEngine (no GPU)",
                "vram_gb": None,
                "ffmpeg": None,
                "ffmpeg_decode_ok": True,
                "problems": [],
                "notes": [],
            }
        r = self._report()
        return {
            "python": r.python,
            "torch": r.torch,
            "cuda_available": r.cuda_available,
            "cuda_version": r.cuda_version,
            "gpu_backend": r.gpu_backend,
            "gpu_backend_version": r.gpu_backend_version,
            "gpu_name": r.gpu_name,
            "vram_gb": r.vram_gb,
            "ffmpeg": r.ffmpeg,
            "ffmpeg_decode_ok": r.ffmpeg_decode_ok,
            "problems": r.problems,
            "notes": r.notes,
        }

    # -- tracks ---------------------------------------------------------------

    def register_tracks(self, paths: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for path in expand_inputs([Path(p) for p in paths]):
            entry: dict[str, Any] = {"path": str(path), "name": path.stem, "ok": True}
            try:
                if not path.is_file():
                    raise DomainError("no such file")
                info = probe(path)
                entry.update(info.to_dict(), bytes=path.stat().st_size)
                entry.pop("bit_rate", None)
                self.index.save_track(str(path), path.stem, {**info.to_dict()})
            except (DomainError, OSError) as exc:
                entry.update(ok=False, error=str(exc))
            out.append(entry)
        return out

    # -- recipes --------------------------------------------------------------

    def recipe_info(
        self, recipe: Recipe, single_model: bool = False, plan: MemoryPlan | None = None
    ) -> dict[str, Any]:
        catalog, store = self.runtime.catalog, self.runtime.store
        plan = plan or self.memory()
        missing = [m for m in recipe.model_ids if not store.is_installed(catalog.get(m))]
        # Models run one at a time: the largest one decides whether the recipe fits.
        largest = plan.largest(catalog.get(m) for m in recipe.model_ids)
        return {
            "id": recipe.id,
            "name": recipe.name,
            "use_case": recipe.use_case,
            "description": recipe.description,
            "version": recipe.version,
            "builtin": recipe.builtin,
            "experimental": recipe.experimental,
            "selectable_outputs": recipe.selectable_outputs,
            "single_model": single_model,
            "outputs": [o.name for o in recipe.outputs],
            "output_groups": recipe.groups,
            "models": list(recipe.model_ids),
            "passes": [
                {"id": p.id, "models": list(p.models), "input": p.input} for p in recipe.passes
            ],
            "missing_models": missing,
            "download_bytes": sum(catalog.get(m).total_bytes for m in missing),
            "supports_sum_to_mix": recipe.residual_into is not None,
            "fit": plan.fit(largest) if largest else "fits",
            "fit_model": largest.id if largest else None,
            "memory_gb": _gb(plan.need(largest)) if largest else 0.0,
        }

    def recipes(self) -> list[dict[str, Any]]:
        plan = self.memory()
        return [self.recipe_info(r, plan=plan) for r in self.runtime.recipes.values()]

    def resolve_recipe(self, recipe_id: str | None, model_id: str | None) -> Recipe:
        return self.runtime.recipe(recipe_id, model_id)

    # -- models ---------------------------------------------------------------

    def model_info(
        self,
        model_id: str,
        plan: MemoryPlan | None = None,
        recommended: list[str] | None = None,
    ) -> dict[str, Any]:
        spec = self.runtime.catalog.get(model_id)
        plan = plan or self.memory()
        if recommended is None:
            recommended = recommended_ids(list(self.runtime.catalog), plan)
        used_by = [r.id for r in self.runtime.recipes.values() if model_id in r.model_ids]
        return {
            "id": spec.id,
            "name": spec.name,
            "architecture": spec.architecture,
            "loader": spec.loader,
            "license": spec.license,
            "stems": list(spec.stems),
            "use_cases": list(spec.use_cases),
            "bytes": spec.total_bytes,
            "status": self.runtime.store.status(spec),
            "seed": spec.seed,
            "experimental": spec.experimental,
            "custom": spec.custom,
            "notes": spec.notes,
            "used_by": used_by,
            "download": self.downloads.state(spec.id),
            "memory_gb": _gb(plan.need(spec)),
            "memory_estimated": memory_is_estimated(spec, plan.full_precision),
            "fit": plan.fit(spec),
            "recommended": spec.id in recommended,
        }

    def models(self) -> dict[str, Any]:
        plan = self.memory()
        recommended = recommended_ids(list(self.runtime.catalog), plan)
        infos = [self.model_info(spec.id, plan, recommended) for spec in self.runtime.catalog]
        return {
            "models": infos,
            "models_dir": str(self.runtime.store.root),
            "installed_bytes": sum(m["bytes"] for m in infos if m["status"] == "installed"),
        }

    def delete_model(self, model_id: str) -> None:
        spec = self.runtime.catalog.get(model_id)
        self.downloads.cancel(model_id)
        self.downloads.wait(model_id, 5)
        self.jobs.supervisor.evict(model_id)
        self.runtime.store.delete(spec)
        if spec.custom:
            self.reload()
        self.bus.publish("models.changed", id=model_id)

    # -- jobs -----------------------------------------------------------------

    def create_job(
        self,
        path: str,
        recipe_id: str | None,
        model_id: str | None,
        quality: str | None,
        options: dict[str, Any],
        start: bool | None = None,
    ) -> dict[str, Any]:
        """Queue one file. ``start`` says whether it runs as soon as the GPU is free or
        waits for the user's Start; left out, the ``auto_start`` setting decides."""
        if not os.path.isfile(path):
            raise DomainError(f"no such file: {path}")
        recipe, opts = self._checked(recipe_id, model_id, quality, options)
        if start is None:
            start = self.runtime.settings.auto_start
        if "name" not in opts:
            # A song the user named keeps its name when it is separated again.
            given = self._given_name(path)
            if given is not None:
                opts["name"] = given
        return self.jobs.create(
            path,
            recipe.id,
            recipe.name,
            quality or self.runtime.settings.default_quality,
            opts,
            hold=not start,
        )

    def _checked(
        self,
        recipe_id: str | None,
        model_id: str | None,
        quality: str | None,
        options: dict[str, Any],
    ) -> tuple[Recipe, dict[str, Any]]:
        """The recipe and the options of a request, validated now so a bad request fails
        here, not later in the queue."""
        recipe = self.resolve_recipe(recipe_id, model_id)
        opts = {k: v for k, v in options.items() if v is not None}
        if "range" in opts:
            # Checked against the song's length and named in one place: set_job_range.
            raise DomainError("a part of a song is chosen once the song is in the queue")
        from openstems.pipeline.retag import clean_changes

        opts.update(clean_changes(opts))  # a tempo or key typed by the user
        if "name" in opts:
            opts["name"] = clean_name(opts["name"])
            if opts["name"] is None:
                del opts["name"]
        self.runtime.pipeline.plan(recipe, self.runtime.options(quality=quality, **opts))
        return recipe, opts

    # -- links ----------------------------------------------------------------

    def _links_root(self) -> Path:
        return self.runtime.settings.output_path / LINKS_DIR

    def add_link(
        self,
        url: str,
        recipe_id: str | None,
        model_id: str | None,
        quality: str | None,
        options: dict[str, Any],
        start: bool | None = None,
    ) -> dict[str, Any]:
        """Fetch the song behind a link, then queue it like a dropped file."""
        url = check_url(url)
        self._checked(recipe_id, model_id, quality, options)
        request = {
            "recipe": recipe_id,
            "model": model_id,
            "quality": quality,
            "options": options,
            "start": start,
        }
        return self.links.add(url, request)

    def _queue_fetched(self, request: dict[str, Any], fetched: Fetched) -> None:
        self.create_job(
            str(fetched.path),
            request["recipe"],
            request["model"],
            request["quality"],
            request["options"],
            request["start"],
        )

    # -- mixes ----------------------------------------------------------------

    def mix(self, paths: list[str]) -> dict[str, Any]:
        """Write some of a song's stems as one file, next to them."""
        from openstems.pipeline.mix import render_mix

        files = [Path(p) for p in paths]
        if not files:
            raise DomainError("a mix needs at least two stems")
        directory = self._stem_folder(files, "a mix is made of stems of one song")
        return render_mix(directory, [file.name for file in files])

    def _stem_folder(self, files: list[Path], mixed: str) -> Path:
        """The one stem folder that ``files`` are in, each of them still there. Stems of
        several folders (or outside every served one) are refused with ``mixed``; a stem
        gone from its folder is named, since asking again cannot bring it back."""
        directory = files[0].parent
        for file in files:
            if file.parent != directory or not self.is_served(file):
                raise DomainError(mixed)
        for file in files:
            if not file.is_file():
                raise DomainError(
                    f"{file.name} is no longer in its folder: separate the song again"
                )
        return directory

    # -- notes ----------------------------------------------------------------

    def find_notes(self, paths: list[str]) -> dict[str, Any]:
        """Read stems that are already written and write each one's notes and MIDI beside
        it. Returns the stem set as the index now holds it.

        Reading takes seconds, so the folder is locked only for the writing after it, which
        starts from the manifest as it is then: a tempo typed or a stem hidden meanwhile is
        kept."""
        from openstems.pipeline.notes import read_stems, write_notes

        files = [Path(p) for p in paths]
        if not files:
            raise DomainError("name the stems to find notes in")
        directory = self._stem_folder(files, "notes are found in stems of one song")
        where = os.path.normpath(str(directory))
        self._not_being_written(where)
        with self._lock("notes", _path_key(where)):  # one reading of a folder at a time
            reading = read_stems(directory, [file.name for file in files])
            with self._folder(where):
                self._not_being_written(where)  # the reading took seconds
                self._stems_changed(where, directory, write_notes(directory, reading))
        return self._indexed(where)

    def _not_being_written(self, where: str) -> None:
        """Refuse when the job that is running now may be writing the stem folder
        ``where``: its song's folder, under any name it may go by, and its recipe's inside
        it. Whatever is changed there meanwhile is gone when the run replaces the folder.

        Known from the job itself. Its ``output_dir`` cannot say: a job has none until it
        is done, which is when it stops being the one that runs.
        """
        busy = self.jobs.running()
        if busy is None:
            return
        folder = Path(where)
        if folder.name.lower() == safe_component(
            busy["recipe_id"]
        ).lower() and folder.parent.name.lower() in _folders_of(busy):
            raise DomainError("this song is being separated again: wait until it is done")

    def _folder(self, where: str) -> threading.Lock:
        """The lock on one stem folder, for whatever rewrites its manifest in this process:
        notes, a tempo or key, hidden stems, a rename. Without it two of them at once would
        each write the manifest they read, and one change would be lost."""
        return self._lock("folder", _path_key(where))

    def _stems_changed(
        self, where: str, directory: Path, manifest: dict[str, Any], said: bool = True
    ) -> None:
        """Have the index, the queue and the windows follow a manifest that was rewritten.
        ``said`` is false when what the song's notes say cannot have changed."""
        from openstems.pipeline.run import stem_set_from_manifest

        self.index.save_stem_set(where, manifest)
        result = stem_set_from_manifest(directory, manifest)
        if result is not None:
            analysis = manifest.get("analysis") or {}
            if said:
                self.jobs.output_changed(
                    where, _job_stems(where, result), analysis, list(manifest.get("notes") or [])
                )
            else:
                self.jobs.output_changed(where, _job_stems(where, result), analysis)
        self.bus.publish("stemsets.changed")

    # -- clips ----------------------------------------------------------------

    def clips(
        self,
        paths: list[str],
        start: float,
        end: float,
        together: bool = True,
        grid: dict[str, Any] | None = None,
        source: bool | None = None,
    ) -> list[dict[str, Any]]:
        """Write a stretch of a song as files to drag into a DAW: of the song's own file,
        or of some of its stems, summed into one file or one file each.

        ``source`` says which of the two ``paths`` are. Left out, one path that is the file
        of a song in the queue or the history is that song's own file; anything else is
        stems. A stem that was itself separated is both, which only ``source`` can tell.
        """
        from openstems.pipeline.clip import render_clips, render_source_clip

        if not paths:
            raise DomainError("a clip needs the song or at least one of its stems")
        checked = make_grid(**grid) if grid is not None else None
        if source is None:
            # One file that is not a song and not in the output folders: a song meant.
            one = paths[0]
            source = len(paths) == 1 and (self._is_song(one) or not self.is_served(Path(one)))
        if source:
            if len(paths) != 1:
                raise DomainError("a clip of a song's own file is cut from that one file")
            song = self._known_song(paths[0])
            settings = self.runtime.settings
            # Beside the song's stems, under the name the user gave it if they gave one.
            name = self._given_name(str(song)) or song.stem
            with self._lock("clips", _path_key(str(settings.output_path / safe_component(name)))):
                clip = render_source_clip(
                    song,
                    name,
                    settings.output_path,
                    start,
                    end,
                    checked,
                    settings.output_format,
                    settings.tempo_sync,
                    settings.naming_template,
                )
            return [clip]
        files = [Path(p) for p in paths]
        directory = self._stem_folder(files, "a clip is made of stems of one song")
        with self._lock("clips", _path_key(str(directory))):
            return render_clips(
                directory, [file.name for file in files], start, end, together, checked
            )

    # -- a song's own file ----------------------------------------------------

    def source_preview(self, path: str) -> dict[str, Any]:
        """A song's own file, ready to play and draw before it is separated: a FLAC, its
        peaks and the beat grid detection finds. Made once, then found again."""
        from openstems.pipeline.preview import make_preview, preview_key

        song = self._known_song(path)
        try:
            key = preview_key(song)
        except OSError as exc:
            raise DomainError(f"cannot read {song.name}: {exc}") from exc
        with self._lock("preview", key):
            return make_preview(song, self._previews_dir(), key)

    def _previews_dir(self) -> Path:
        return self.runtime.settings.cache_path / PREVIEWS_DIR

    def _song_file(self, path: str) -> str | None:
        """The file of a song in the queue or in the history that ``path`` names, spelled
        as the queue or the history has it, or None."""
        wanted = {_path_key(path), _path_key(os.path.realpath(path))}
        for track_path in [
            *(job["track_path"] for job in self.jobs.list()),
            *sorted(self.index.track_paths()),
        ]:
            if _path_key(track_path) in wanted:
                return track_path
        return None

    def _is_song(self, path: str) -> bool:
        """Whether ``path`` is the file of a song in the queue or in the history."""
        return self._song_file(path) is not None

    def _known_song(self, path: str) -> Path:
        """The file of a song in the queue or the history that ``path`` names, when it is
        still there: the app may read a song's own file only. It is spelled as the queue or
        the history has it, so a clip of it is named after the song, not after the request."""
        song = self._song_file(path)
        if song is None:
            raise DomainError("that is not a song in the queue or the history")
        if not os.path.isfile(song):
            raise DomainError("that song's file is not there any more")
        return Path(song)

    def _lock(self, kind: str, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault((kind, key), threading.Lock())

    # -- GPU self-test --------------------------------------------------------

    def selftest(self) -> dict[str, Any]:
        """Run ``openstems selftest --json`` in its own process and keep the result with the
        logs, where Export diagnostics picks it up. Its own process, because the API never
        imports torch and a GPU fault must not take the API down."""
        if any(j["state"] in ACTIVE_STATES for j in self.jobs.list()):
            raise DomainError("Wait for the queue to finish before running the GPU self-test.")
        if fake_mode():
            report: dict[str, Any] = {
                "ok": False,
                "gpu_available": False,
                "problems": ["The FakeEngine has no GPU to test."],
            }
        else:
            report = run_selftest_process()
        try:
            logs = self.runtime.settings.logs_path
            logs.mkdir(parents=True, exist_ok=True)
            (logs / SELFTEST_FILE).write_text(json.dumps(report, indent=2), encoding="utf-8")
        except OSError:
            pass
        return report

    # -- settings -------------------------------------------------------------

    def patch_settings(self, changes: dict[str, Any]) -> dict[str, Any]:
        if "default_recipe" in changes:
            self.runtime.recipe(changes["default_recipe"])  # must exist
        update_settings(changes)
        old_cache = self.runtime.settings.cache_dir
        self.reload()
        del old_cache  # the index stays where it was opened until the next start
        folder = self.runtime.settings.watch_folder.strip()
        if changes.get("watch_enabled") and not (folder and Path(folder).is_dir()):
            update_settings({"watch_enabled": False})
            self.reload()
            raise DomainError("Choose a watch folder that exists first.")
        self._configure_watcher()
        self.bus.publish("settings.changed", settings=self.runtime.settings.to_dict())
        self.bus.publish("models.changed", id=None)
        return self.runtime.settings.to_dict()

    # -- files ----------------------------------------------------------------

    def is_served(self, path: Path) -> bool:
        """Only files inside the output folder, an indexed stem set or the previews of
        songs' own files are served."""
        try:
            resolved = path.resolve()
        except OSError:
            return False
        roots = [
            self.runtime.settings.output_path,
            self._previews_dir(),
            *map(Path, self.index.stem_set_dirs()),
        ]
        for job in self.jobs.list():
            if job.get("output_dir"):
                roots.append(Path(job["output_dir"]))
        for root in roots:
            try:
                resolved.relative_to(root.resolve())
                return True
            except (ValueError, OSError):
                continue
        return False

    def stem_sets(self, query: str = "") -> list[dict[str, Any]]:
        sets = self.index.stem_sets(query)
        for item in sets:
            item["source_exists"] = os.path.isfile(item["track_path"])
        return sets

    def set_job_analysis(self, job_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        """The tempo, key and bar 1 of a job, by the user. Before it runs they are kept
        for the run; once it is done its stems are re-tagged."""
        from openstems.pipeline.retag import clean_changes

        changes = clean_changes(changes)
        job = self.jobs.get(job_id)
        if job["state"] == "done" and job.get("output_dir"):
            self.set_analysis(job["output_dir"], changes)
            return self.jobs.get(job_id)
        return self.jobs.set_analysis(job_id, changes)

    def set_job_range(self, job_id: str, part: dict[str, Any] | None) -> dict[str, Any]:
        """The part of a waiting song to separate alone, kept inside the song, or None to
        take it away. It is named now ("bars 9-16"): by the grid it was chosen on, else by
        the tempo and bar 1 the job was given, else by its times. A job without a tempo (or
        bar 1) of its own keeps the grid's, so its run lays out the bars the part was named
        by (`JobManager.set_range`)."""
        job = self.jobs.get(job_id)
        if job["state"] != "queued":
            raise DomainError(STARTED)  # before the file is read; asked again under the lock
        if part is None:
            return self.jobs.set_range(job_id, None)
        grid = make_grid(**part["grid"]) if part.get("grid") is not None else None
        length = probe(job["track_path"]).duration  # 0 when the file does not say
        start, end = clean_selection(part["start"], part["end"], length or math.inf)
        return self.jobs.set_range(job_id, (start, end), grid)

    def set_analysis(self, directory: str, changes: dict[str, Any]) -> dict[str, Any]:
        """The tempo, key and bar 1 of stems that are written, by the user: in the
        manifest, in file names that hold them and in the tempo FL Studio reads."""
        from openstems.pipeline.retag import set_analysis

        folder = Path(directory)
        if not self.is_served(folder) or not folder.is_dir():
            raise DomainError("that folder does not hold a set of stems")
        where = os.path.normpath(str(folder))
        self._not_being_written(where)
        with self._folder(where):
            self._stems_changed(where, folder, set_analysis(folder, changes))
        return self._indexed(where)

    def _indexed(self, where: str) -> dict[str, Any]:
        found = self.index.stem_set(where)
        if found is None:
            raise DomainError("that folder does not hold a set of stems")
        found["source_exists"] = os.path.isfile(found["track_path"])
        return found

    def set_hidden(self, directory: str, choices: dict[str, bool | None]) -> dict[str, Any]:
        """The user's choice of stems to leave out of the app's lists, or to keep in them,
        for the stems in ``directory``. Kept in the manifest: no file is touched."""
        from openstems.pipeline.levels import set_hidden

        folder = Path(directory)
        if not self.is_served(folder) or not folder.is_dir():
            raise DomainError("that folder does not hold a set of stems")
        where = os.path.normpath(str(folder))
        self._not_being_written(where)
        with self._folder(where):
            self._stems_changed(where, folder, set_hidden(folder, choices), said=False)
        return self._indexed(where)

    # -- a song's name --------------------------------------------------------

    def _given_name(self, path: str) -> str | None:
        """The name the user gave the song whose file is ``path``, if they gave it one:
        on a row of the queue, or else on its stems in the history."""
        key = _path_key(path)
        for job in self.jobs.list():
            if _path_key(job["track_path"]) == key and job["options"].get("name"):
                return str(job["options"]["name"])
        own = Path(path).stem
        for item in self.index.stem_sets():
            theirs = item["part"] is None and item["track_path"]
            if theirs and item["track_name"] != own and _path_key(item["track_path"]) == key:
                return str(item["track_name"])
        return None

    def rename_job(self, job_id: str, name: str | None) -> dict[str, Any]:
        """Name a job's song, or with None give it its file's name back.

        The name is the song's, so every row of the same file follows: one that waits
        keeps it for its run, and stems that are written are renamed on the disk, their
        folder and their files (`pipeline/rename.py`). Refused while the song runs."""
        title = clean_name(name)
        job = self.jobs.get(job_id)
        key = _path_key(job["track_path"])
        same = [j for j in self.jobs.list() if _path_key(j["track_path"]) == key]
        if any(j["state"] in RUNNING_STATES for j in same):
            raise DomainError(RENAME_BUSY)
        with self._rename_lock:
            # One rename per song folder: a part separated alone has a folder of its own.
            folders: dict[str, tuple[Path, str]] = {}
            for other in same:
                out = other.get("output_dir")
                if other["state"] != "done" or not out or not Path(out).is_dir():
                    continue
                part = str((other.get("part") or {}).get("label") or "")
                full = _song_name(other["track_path"], part, title)
                folders.setdefault(_path_key(str(Path(out).parent)), (Path(out), full))
            for directory, full in folders.values():
                self._rename_folder(directory, full, title)
            self.jobs.set_name([j["id"] for j in same], title)
        return self.jobs.get(job_id)

    def rename_stem_set(self, directory: str, name: str | None) -> dict[str, Any]:
        """Name the song whose stems are in ``directory`` as it is typed, or with None
        give it its file's name back. Its stems are renamed on the disk, for every recipe
        it was separated with, and rows of the same file in the queue follow."""
        from openstems.pipeline.run import read_manifest

        typed = clean_name(name)
        folder = Path(directory)
        manifest = read_manifest(folder) if self.is_served(folder) else None
        if manifest is None:
            raise DomainError("that folder does not hold a set of stems")
        source = manifest.get("source") or {}
        part = str((source.get("range") or {}).get("label") or "")
        tail = f" ({part})" if part else ""
        if typed is None:
            if not source.get("path"):
                raise DomainError("this song's file is not known: type a name for it")
            title, full = None, _song_name(str(source["path"]), part, None)
        elif tail and typed.endswith(tail) and typed[: -len(tail)].strip():
            # A part keeps its label in its name: what is before it is the song's.
            title, full = typed[: -len(tail)].strip(), typed
        else:
            title, full = typed, typed
        with self._rename_lock:
            moved = self._rename_folder(folder, full, title)
        return self._indexed(moved[_path_key(str(folder))])

    def _rename_folder(self, directory: Path, full: str, title: str | None) -> dict[str, str]:
        """Rename on the disk the song that the stem folder ``directory`` is of, then have
        the history and the queue follow. ``full`` is the name its folder and files take,
        ``title`` the song's name without a part's label (None: its file's own). Returns
        each stem folder as it compared before, to where it is now."""
        from openstems.pipeline.rename import rename_song
        from openstems.pipeline.run import stem_set_from_manifest

        if not self.is_served(directory) or not directory.is_dir():
            raise DomainError("that folder does not hold a set of stems")
        song_folder = directory.parent
        busy = self.jobs.running()
        if busy is not None and song_folder.name.lower() in _folders_of(busy):
            raise DomainError(RENAME_BUSY)
        try:
            sets = [p.name for p in song_folder.iterdir() if p.is_dir()]
        except OSError:
            sets = []
        # Nothing else rewrites a manifest of this song while its folders move: not under
        # the names they have, and not under the ones they are about to take.
        renamed = song_folder.parent / safe_component(full)
        both = {_path_key(str(parent / one)) for one in sets for parent in (song_folder, renamed)}
        with contextlib.ExitStack() as held:
            for key in sorted(both):
                held.enter_context(self._lock("folder", key))
            moved = rename_song(directory, full)

        under = _path_key(str(song_folder)) + os.sep
        for known in self.index.stem_set_dirs():
            if _path_key(known).startswith(under):
                self.index.delete_stem_set(known)
        folders: dict[str, tuple[str, list[dict[str, Any]] | None]] = {}
        files: set[str] = set()
        for item in moved:
            where = os.path.normpath(str(item.now))
            if item.manifest.get("complete"):
                self.index.save_stem_set(where, item.manifest)
            result = stem_set_from_manifest(item.now, item.manifest)
            stems = _job_stems(where, result) if result is not None else None
            folders[_path_key(str(item.was))] = (where, stems)
            source = item.manifest.get("source") or {}
            if source.get("path") and not source.get("range"):
                files.add(_path_key(str(source["path"])))
        self.jobs.moved(folders, title)
        # Rows of the same song that have no stems yet run under its new name.
        self.jobs.set_name(
            [
                job["id"]
                for job in self.jobs.list()
                if job["state"] != "done" and _path_key(job["track_path"]) in files
            ],
            title,
        )
        self.bus.publish("stemsets.changed")
        return {key: where for key, (where, _) in folders.items()}

    def all_recipes_for(self, model_id: str) -> Recipe:
        spec = self.runtime.catalog.get(model_id)
        return single_model_recipe(spec.id, spec.stems, spec.name)
