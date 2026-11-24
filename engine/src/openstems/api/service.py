"""Everything the API routes need, in one object: runtime, index, queue, downloads."""

from __future__ import annotations

import json
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
from openstems.api.jobs import JobManager
from openstems.api.links import LinkManager
from openstems.api.watcher import FolderWatcher
from openstems.audio.decode import probe
from openstems.cli_inputs import expand_inputs
from openstems.doctor import DoctorReport
from openstems.domain.errors import DomainError
from openstems.domain.memory import GB, MemoryPlan, memory_is_estimated, recommended_ids
from openstems.domain.recipe import Recipe, single_model_recipe
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
ACTIVE_STATES = ("queued", "preparing", "running", "writing")


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

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        self.index.prune_missing()
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
        from openstems.pipeline.retag import clean_changes

        opts.update(clean_changes(opts))  # a tempo or key typed by the user
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
        directory = files[0].parent
        for file in files:
            if file.parent != directory or not self.is_served(file) or not file.is_file():
                raise DomainError("a mix is made of stems of one song")
        return render_mix(directory, [file.name for file in files])

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
        """Only files inside the output folder or an indexed stem set are served."""
        try:
            resolved = path.resolve()
        except OSError:
            return False
        roots = [self.runtime.settings.output_path, *map(Path, self.index.stem_set_dirs())]
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
        """The tempo and key of a job, by the user. Before it runs they are kept for the
        run; once it is done its stems are re-tagged."""
        from openstems.pipeline.retag import clean_changes

        changes = clean_changes(changes)
        job = self.jobs.get(job_id)
        if job["state"] == "done" and job.get("output_dir"):
            self.set_analysis(job["output_dir"], changes)
            return self.jobs.get(job_id)
        return self.jobs.set_analysis(job_id, changes)

    def set_analysis(self, directory: str, changes: dict[str, Any]) -> dict[str, Any]:
        """The tempo and key of stems that are written, by the user: in the manifest, in
        file names that hold them and in the tempo FL Studio reads."""
        from openstems.pipeline.retag import set_analysis
        from openstems.pipeline.run import stem_set_from_manifest

        folder = Path(directory)
        if not self.is_served(folder) or not folder.is_dir():
            raise DomainError("that folder does not hold a set of stems")
        where = os.path.normpath(str(folder))
        if self.jobs.writing_to(where):
            raise DomainError("this song is being separated again: wait until it is done")
        manifest = set_analysis(folder, changes)
        self.index.save_stem_set(where, manifest)
        result = stem_set_from_manifest(folder, manifest)
        if result is not None:
            stems = [
                {
                    "name": s.name,
                    "file": s.file,
                    "path": os.path.join(where, s.file),
                    "peaks": os.path.join(where, s.peaks) if s.peaks else None,
                    "midi": os.path.join(where, s.midi) if s.midi else None,
                    "offset": s.offset,
                    "samples": s.samples,
                    "sample_rate": s.sample_rate,
                    "group": s.group or None,
                }
                for s in result.stems
            ]
            self.jobs.output_changed(
                where, stems, manifest.get("analysis") or {}, list(manifest.get("notes") or [])
            )
        self.bus.publish("stemsets.changed")
        found = self.index.stem_set(where)
        if found is None:
            raise DomainError("that folder does not hold a set of stems")
        found["source_exists"] = os.path.isfile(found["track_path"])
        return found

    def all_recipes_for(self, model_id: str) -> Recipe:
        spec = self.runtime.catalog.get(model_id)
        return single_model_recipe(spec.id, spec.stems, spec.name)
