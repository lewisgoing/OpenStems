"""Everything the API routes need, in one object: runtime, index, queue, downloads."""

from __future__ import annotations

import json
import os
import subprocess
import sys
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
from openstems.domain.errors import DomainError
from openstems.domain.recipe import Recipe, single_model_recipe
from openstems.engines.host import fake_mode
from openstems.links import Fetched, check_url
from openstems.runtime import Runtime, build_runtime
from openstems.settings import config_dir, update_settings

SELFTEST_FILE = "selftest.json"
# Songs fetched from links are kept here, inside the output folder: the user chose that
# drive for large files, and the watch folder never looks into it.
LINKS_DIR = "_links"
ACTIVE_STATES = ("queued", "preparing", "running", "writing")


def run_selftest_process(timeout: float = 1800.0) -> dict[str, Any]:
    """The self-test's JSON report. It exits 1 on a mismatch and still prints the report."""
    command = [sys.executable, "-m", "openstems.cli", "selftest", "--json"]
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
        return {"ok": False, "problems": [f"The self-test did not finish in {timeout:.0f} s."]}
    start = done.stdout.find("{")
    try:
        report = json.loads(done.stdout[start:]) if start >= 0 else None
    except ValueError:
        report = None
    if not isinstance(report, dict):
        tail = (done.stderr or done.stdout).strip().splitlines()[-6:]
        return {
            "ok": False,
            "problems": [f"The self-test crashed (exit code {done.returncode}).", *tail],
        }
    return report


class Service:
    def __init__(self) -> None:
        self.bus = EventBus()
        self.runtime: Runtime = build_runtime()
        self.index = Index(self.runtime.settings.cache_path / "index.sqlite")
        self.jobs = JobManager(self.index, self.bus)
        self.downloads = DownloadManager(self.bus)
        self.links = LinkManager(self.bus, self._links_root, self._queue_fetched)
        self.watcher = FolderWatcher(self._queue_watched)
        self._system: dict[str, Any] | None = None

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        self.index.prune_missing()
        self.jobs.start()
        self._configure_watcher()
        self.watcher.start()

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

    def system(self) -> dict[str, Any]:
        if self._system is None:
            if fake_mode():
                import platform

                self._system = {
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
                }
            else:
                from openstems.doctor import run_doctor

                r = run_doctor()
                self._system = {
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
                }
        return {
            "version": __version__,
            **self._system,
            "fake_engine": fake_mode(),
            "worker": self.jobs.worker_status,
            "config_dir": str(config_dir()),
            "logs_dir": str(self.runtime.settings.logs_path),
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

    def recipe_info(self, recipe: Recipe, single_model: bool = False) -> dict[str, Any]:
        catalog, store = self.runtime.catalog, self.runtime.store
        missing = [m for m in recipe.model_ids if not store.is_installed(catalog.get(m))]
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
            "models": list(recipe.model_ids),
            "passes": [
                {"id": p.id, "models": list(p.models), "input": p.input} for p in recipe.passes
            ],
            "missing_models": missing,
            "download_bytes": sum(catalog.get(m).total_bytes for m in missing),
            "supports_sum_to_mix": recipe.residual_into is not None,
        }

    def recipes(self) -> list[dict[str, Any]]:
        return [self.recipe_info(r) for r in self.runtime.recipes.values()]

    def resolve_recipe(self, recipe_id: str | None, model_id: str | None) -> Recipe:
        return self.runtime.recipe(recipe_id, model_id)

    # -- models ---------------------------------------------------------------

    def model_info(self, model_id: str) -> dict[str, Any]:
        spec = self.runtime.catalog.get(model_id)
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
        }

    def models(self) -> dict[str, Any]:
        infos = [self.model_info(spec.id) for spec in self.runtime.catalog]
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

    def all_recipes_for(self, model_id: str) -> Recipe:
        spec = self.runtime.catalog.get(model_id)
        return single_model_recipe(spec.id, spec.stems, spec.name)
