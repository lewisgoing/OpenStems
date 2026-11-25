"""The job queue: one job on the GPU at a time, in order, with cancel, retry and reorder.

A queued job may be held: it keeps its place but is not sent to the GPU until the user
starts it. That is how files added without auto-start wait for the Start button."""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any

from openstems.api.db import Index
from openstems.api.events import EventBus
from openstems.domain.errors import DomainError
from openstems.domain.grid import Grid, SongPart, clean_downbeat, clip_label
from openstems.domain.job import Job, JobState
from openstems.pipeline.run import SAMPLE_RATE
from openstems.worker.supervisor import WorkerSupervisor

_STAGE_STATE = {
    "preparing": JobState.PREPARING,
    "running": JobState.RUNNING,
    "writing": JobState.WRITING,
}
_ORDER = [JobState.PREPARING, JobState.RUNNING, JobState.WRITING]
MAX_FINISHED = 300
STARTED = "this song has started: its part can no longer change"

log = logging.getLogger(__name__)


class JobNotFound(DomainError):
    pass


def _given_grid(options: dict[str, Any]) -> Grid | None:
    """The grid a waiting job was given, when it has both a tempo and bar 1. Without both,
    its part is named by its times."""
    bpm, downbeat = options.get("bpm"), options.get("downbeat")
    if bpm is None or downbeat is None:
        return None
    return Grid(float(bpm), float(downbeat))


def _keep_grid(options: dict[str, Any], grid: Grid) -> None:
    """Give a waiting job the figures of the grid its part was named on that it lacks, so
    that its run lays the part's bars where they were named: the tempo with bar 1 when it
    had no tempo, bar 1 alone when it had this tempo. Figures it has stay as they are."""
    from openstems.pipeline.retag import clean_bpm

    bpm = options.get("bpm")
    if bpm is None:
        options["bpm"] = clean_bpm(grid.bpm)
        if options.get("downbeat") is None:
            options["downbeat"] = clean_downbeat(grid.downbeat)
    elif options.get("downbeat") is None and abs(float(bpm) - grid.bpm) < 0.005:
        options["downbeat"] = clean_downbeat(grid.downbeat)


class JobManager:
    def __init__(self, index: Index, bus: EventBus) -> None:
        self.index = index
        self.bus = bus
        self.supervisor = WorkerSupervisor(self._on_worker_event)
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._extra: dict[str, dict[str, Any]] = {}  # recipe name, stems, etc. per job
        self._order: list[str] = []
        self._current: str | None = None
        self._seq = 0
        self._current_seq = -1
        self._worker_ready = False
        self._restore()

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        self.supervisor.start()

    def stop(self) -> None:
        self.supervisor.stop()

    def _restore(self) -> None:
        """Bring back the job list. Jobs that were mid-flight when the engine stopped
        are marked failed; queued ones stay queued."""
        for data in self.index.jobs():
            try:
                job = Job(
                    track_path=data["track_path"],
                    recipe_id=data["recipe_id"],
                    quality=data.get("quality", "balanced"),
                    id=data["id"],
                    state=JobState(data["state"]),
                    progress=data.get("progress", 0.0),
                    message=data.get("message", ""),
                    error=data.get("error"),
                    cached=data.get("cached", False),
                    output_dir=data.get("output_dir"),
                    options=data.get("options", {}),
                    created_at=data.get("created_at", 0.0),
                    started_at=data.get("started_at"),
                    finished_at=data.get("finished_at"),
                )
            except (KeyError, ValueError):
                continue
            if job.state in (JobState.PREPARING, JobState.RUNNING, JobState.WRITING):
                job.state = JobState.FAILED
                job.error = "Interrupted: the engine stopped while this job was running."
                job.message = ""
            self._jobs[job.id] = job
            self._extra[job.id] = {
                "recipe_name": data.get("recipe_name", job.recipe_id),
                "stems": _with_empty([_with_start(stem) for stem in data.get("stems") or []]),
                "analysis": data.get("analysis", {}),
                "notes": data.get("notes", []),
                # A job that was waiting for Start still waits after a restart.
                "held": bool(data.get("held")) and job.state is JobState.QUEUED,
                "part": data.get("part"),
            }
            self._order.append(job.id)

    # -- views ----------------------------------------------------------------

    def to_dict(self, job: Job) -> dict[str, Any]:
        extra = self._extra.get(job.id, {})
        held = bool(extra.get("held")) and job.state is JobState.QUEUED
        # The position counts the jobs that will run before this one: held jobs are not in line.
        queued = [j for j in self._order if self._runnable(j)]
        return {
            "id": job.id,
            "track_path": job.track_path,
            # The name the user gave the song, or else its file's.
            "track_name": job.options.get("name") or Path(job.track_path).stem,
            "recipe_id": job.recipe_id,
            "recipe_name": extra.get("recipe_name", job.recipe_id),
            "quality": job.quality,
            "state": job.state.value,
            "progress": round(job.progress, 4),
            "message": job.message,
            "error": job.error,
            "cached": job.cached,
            "output_dir": job.output_dir,
            "options": job.options,
            "stems": extra.get("stems", []),
            "analysis": extra.get("analysis", {}),
            "notes": extra.get("notes", []),
            "queue_position": queued.index(job.id) if job.id in queued else None,
            "held": held,
            # The part of the song its stems are, when only a part was separated.
            "part": extra.get("part"),
            "created_at": job.created_at,
            "started_at": job.started_at,
            "finished_at": job.finished_at,
        }

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self.to_dict(self._jobs[j]) for j in self._order]

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            return self.to_dict(self._job(job_id))

    def _runnable(self, job_id: str) -> bool:
        """Queued and free to go to the GPU: not waiting for the user's Start."""
        return self._jobs[job_id].state is JobState.QUEUED and not self._extra.get(job_id, {}).get(
            "held"
        )

    def _job(self, job_id: str) -> Job:
        try:
            return self._jobs[job_id]
        except KeyError:
            raise JobNotFound(f"no such job: {job_id}") from None

    @property
    def worker_status(self) -> dict[str, Any]:
        return {
            "alive": self.supervisor.alive,
            "ready": self._worker_ready,
            "pid": self.supervisor.pid,
            "restarts": self.supervisor.restarts,
            "current_job": self._current,
        }

    # -- commands -------------------------------------------------------------

    def create(
        self,
        track_path: str,
        recipe_id: str,
        recipe_name: str,
        quality: str,
        options: dict[str, Any] | None = None,
        hold: bool = False,
    ) -> dict[str, Any]:
        """Add a job. With ``hold`` it waits in the queue until `release` lets it go."""
        job = Job(track_path=track_path, recipe_id=recipe_id, quality=quality)
        job.options = dict(options or {})
        with self._lock:
            self._jobs[job.id] = job
            self._extra[job.id] = {
                "recipe_name": recipe_name,
                "stems": [],
                "analysis": {},
                "notes": [],
                "held": hold,
                "part": None,
            }
            self._order.append(job.id)
            self._changed(job)
            self._trim_finished()
            self._dispatch()
            return self.to_dict(job)

    def release(self, job_id: str | None = None) -> list[dict[str, Any]]:
        """The user's Start: release one held job, or every held job, to the GPU. They run
        in queue order, behind whatever is already in line."""
        with self._lock:
            if job_id is not None:
                self._job(job_id)
            for held_id in self._order:
                if job_id not in (None, held_id) or not self._extra[held_id].get("held"):
                    continue
                self._extra[held_id]["held"] = False
                self._changed(self._jobs[held_id])
            # Positions in line changed for the jobs behind them.
            for queued_id in self._order:
                if self._runnable(queued_id):
                    self.bus.publish("job.updated", job=self.to_dict(self._jobs[queued_id]))
            self._dispatch()
            return [self.to_dict(self._jobs[j]) for j in self._order]

    def set_analysis(self, job_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        """Give a job that has not started the song's tempo, key and bar 1, in place of
        what detection will find. A value of None takes the user's figure away again.

        A part chosen to be separated alone is named on the song's grid: it is named again
        in the same step, by the tempo and bar 1 the job has now (by its times without
        both), so its name, its folder and its stems' bars follow the one tempo the song
        has (ADR 0023)."""
        with self._lock:
            job = self._job(job_id)
            if job.state is not JobState.QUEUED:
                raise DomainError("this job has already started")
            for name, value in changes.items():
                if value is None:
                    job.options.pop(name, None)
                else:
                    job.options[name] = value
            part = SongPart.from_dict(job.options.get("range"))
            if part is not None:
                label = clip_label(_given_grid(job.options), part.start, part.end)
                job.options["range"] = SongPart(part.start, part.end, label).to_dict()
            self._changed(job)
            return self.to_dict(job)

    def set_range(
        self, job_id: str, times: tuple[float, float] | None, grid: Grid | None = None
    ) -> dict[str, Any]:
        """Give a job that has not started the part of its song to separate alone, its
        times already checked, or take it away again with None. Whether only the part is
        separated is decided when the job starts, by the separate_selection setting.

        The part is named now ("bars 9-16"): by ``grid``, the grid it was chosen on, else
        by the tempo and bar 1 the job was given, else by its times. The job keeps what it
        lacked of that grid (`_keep_grid`), all in one step under the queue's lock."""
        with self._lock:
            job = self._job(job_id)
            if job.state is not JobState.QUEUED:
                raise DomainError(STARTED)
            if times is None:
                job.options.pop("range", None)
            else:
                start, end = times
                if grid is not None:
                    _keep_grid(job.options, grid)
                named = grid if grid is not None else _given_grid(job.options)
                job.options["range"] = SongPart(start, end, clip_label(named, start, end)).to_dict()
            self._changed(job)
            return self.to_dict(job)

    def output_changed(
        self,
        directory: str,
        stems: list[dict[str, Any]],
        analysis: dict[str, Any],
        notes: list[str] | None = None,
    ) -> None:
        """The stems in ``directory`` were re-tagged: finished jobs that show them follow."""
        with self._lock:
            for job in self._jobs.values():
                if job.state is not JobState.DONE or not job.output_dir:
                    continue
                if os.path.normcase(os.path.normpath(job.output_dir)) != os.path.normcase(
                    directory
                ):
                    continue
                self._extra[job.id]["stems"] = stems
                self._extra[job.id]["analysis"] = analysis
                if notes is not None:
                    self._extra[job.id]["notes"] = notes
                self._changed(job)

    def running(self) -> dict[str, Any] | None:
        """The job that is on the GPU now, if any."""
        with self._lock:
            job = self._jobs.get(self._current or "")
            return self.to_dict(job) if job is not None and not job.is_terminal else None

    def set_name(self, job_ids: list[str], name: str | None) -> None:
        """Name the song of these jobs, or with None give it its file's name back. A job
        that waits keeps the name for its run; one that is running is left as it is."""
        with self._lock:
            for job_id in job_ids:
                job = self._jobs.get(job_id)
                if job is None or job.state in _ORDER:
                    continue
                if (job.options.get("name") or None) == name:
                    continue
                if name is None:
                    job.options.pop("name", None)
                else:
                    job.options["name"] = name
                self._changed(job)

    def moved(
        self, folders: dict[str, tuple[str, list[dict[str, Any]] | None]], name: str | None
    ) -> None:
        """A song was renamed on the disk: finished jobs whose stems were in one of
        ``folders`` (a stem folder as it compares, to where it is now and its stems as
        they are now) follow, and carry the song's name."""
        with self._lock:
            for job in self._jobs.values():
                if job.state is not JobState.DONE or not job.output_dir:
                    continue
                key = os.path.normcase(os.path.normpath(os.path.abspath(job.output_dir)))
                if key not in folders:
                    continue
                job.output_dir, stems = folders[key]
                if stems is not None:
                    self._extra[job.id]["stems"] = stems
                if name is None:
                    job.options.pop("name", None)
                else:
                    job.options["name"] = name
                self._changed(job)

    def writing_to(self, directory: str) -> bool:
        """Whether a job that is running now has, or last had, its output in ``directory``."""
        with self._lock:
            job = self._jobs.get(self._current or "")
            if job is None or not job.output_dir:
                return False
            return os.path.normcase(os.path.normpath(job.output_dir)) == os.path.normcase(directory)

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._job(job_id)
            if job.state is JobState.QUEUED:
                job.advance(JobState.CANCELLED)
                job.message = ""
                self._changed(job)
            elif job.id == self._current and not job.is_terminal:
                job.message = "Cancelling"
                self.supervisor.cancel(self._current_seq)
                self._changed(job)
            return self.to_dict(job)

    def retry(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._job(job_id)
            if job.state not in (JobState.FAILED, JobState.CANCELLED):
                raise DomainError(f"job {job_id} is {job.state.value}; only failed or "
                                  "cancelled jobs can be retried")  # fmt: skip
            job.advance(JobState.QUEUED)
            job.message = ""
            job.output_dir = None
            self._extra[job.id]["stems"] = []
            self._extra[job.id]["notes"] = []
            self._extra[job.id]["part"] = None
            self._extra[job.id]["held"] = False  # asking again is asking for it to run
            # A retried job goes to the back of the queue.
            self._order.remove(job.id)
            self._order.append(job.id)
            self._changed(job)
            self._publish_order()
            self._dispatch()
            return self.to_dict(job)

    def reorder(self, job_ids: list[str]) -> list[dict[str, Any]]:
        """Set the order of the queued jobs. Ids must be exactly the queued jobs."""
        with self._lock:
            queued = [j for j in self._order if self._jobs[j].state is JobState.QUEUED]
            if sorted(job_ids) != sorted(queued):
                raise DomainError("reorder needs exactly the ids of the queued jobs")
            replacement = iter(job_ids)
            self._order = [
                next(replacement) if self._jobs[j].state is JobState.QUEUED else j
                for j in self._order
            ]
            for position, job_id in enumerate(self._order):
                self.index.save_job(job_id, position, self.to_dict(self._jobs[job_id]))
            self._publish_order()
            return [self.to_dict(self._jobs[j]) for j in self._order]

    def remove(self, job_id: str) -> None:
        with self._lock:
            job = self._job(job_id)
            if not job.is_terminal:
                raise DomainError("cancel the job before removing it")
            self._forget(job_id)
            self.bus.publish("job.removed", id=job_id)

    def clear_finished(self) -> int:
        with self._lock:
            done = [j for j in self._order if self._jobs[j].is_terminal]
            for job_id in done:
                self._forget(job_id)
                self.bus.publish("job.removed", id=job_id)
            return len(done)

    def _forget(self, job_id: str) -> None:
        self._order.remove(job_id)
        del self._jobs[job_id]
        self._extra.pop(job_id, None)
        self.index.delete_job(job_id)

    def _trim_finished(self) -> None:
        finished = [j for j in self._order if self._jobs[j].is_terminal]
        for job_id in finished[: max(0, len(finished) - MAX_FINISHED)]:
            self._forget(job_id)

    # -- queue ----------------------------------------------------------------

    def _dispatch(self) -> None:
        """Send the next queued job to the worker if it is idle."""
        if self._current is not None or not self._worker_ready:
            return
        for job_id in self._order:
            job = self._jobs[job_id]
            if self._runnable(job_id):
                self._seq += 1
                self._current, self._current_seq = job.id, self._seq
                job.advance(JobState.PREPARING)
                job.message = "Starting"
                self._changed(job)
                self.supervisor.submit(
                    self._seq,
                    {
                        "id": job.id,
                        "track_path": job.track_path,
                        "recipe_id": job.recipe_id,
                        "quality": job.quality,
                        "options": job.options,
                    },
                )
                return

    def _changed(self, job: Job) -> None:
        data = self.to_dict(job)
        self.index.save_job(job.id, self._order.index(job.id), data)
        self.bus.publish("job.updated", job=data)

    def _publish_order(self) -> None:
        self.bus.publish("jobs.order", ids=list(self._order))

    # -- worker events (pump thread) -------------------------------------------

    def _on_worker_event(self, event: tuple[Any, ...]) -> None:
        kind = event[0]
        with self._lock:
            if kind == "ready":
                self._worker_ready = True
                self.bus.publish("worker.status", **self.worker_status)
                self._dispatch()
            elif kind == "fatal":
                self._worker_ready = False
                self.bus.publish("worker.status", **self.worker_status, error=event[1])
            elif kind == "crashed":
                self._worker_ready = False
                self._finish_current(JobState.FAILED, "The worker process stopped unexpectedly.")
                self.bus.publish("worker.status", **self.worker_status)
            elif kind == "progress":
                self._on_progress(*event[1:])
            elif kind == "done":
                self._on_done(event[1], event[2])
            elif kind == "failed":
                self._on_failed(*event[1:])
            elif kind == "cancelled":
                if event[1] == self._current:
                    self._finish_current(JobState.CANCELLED, None)
            elif kind == "idle":
                self._dispatch()

    def _on_failed(
        self, job_id: str, error: str, trace: str | None = None, ending: bool = False
    ) -> None:
        """A job failed. The traceback of an unexpected error goes to the engine's log, the
        only place it is kept. ``ending``: the worker ends after this job and a fresh one
        takes its place (`process.run_job`), so nothing is sent to it in between: the queue
        moves on when the new one is ready."""
        if trace:
            log.error("job %s failed: %s\n%s", job_id, error, trace.rstrip())
        else:
            log.warning("job %s failed: %s", job_id, error)
        if ending:
            self._worker_ready = False
        if job_id == self._current:
            self._finish_current(JobState.FAILED, error)
        if ending:
            self.bus.publish("worker.status", **self.worker_status)

    def _on_progress(self, job_id: str, stage: str, fraction: float, message: str) -> None:
        job = self._jobs.get(job_id)
        if job is None or job_id != self._current or job.is_terminal:
            return
        target = _STAGE_STATE.get(stage)
        if target is not None and target is not job.state:
            # Walk forward through the states so every transition stays legal.
            start = _ORDER.index(job.state) if job.state in _ORDER else -1
            for state in _ORDER[start + 1 : _ORDER.index(target) + 1]:
                job.advance(state)
            self._changed(job)
        job.progress = max(job.progress, float(fraction))
        if job.message != "Cancelling":
            job.message = message
        self.bus.publish(
            "job.progress",
            id=job.id,
            state=job.state.value,
            progress=round(job.progress, 4),
            message=job.message,
        )

    def _on_done(self, job_id: str, result: dict[str, Any]) -> None:
        job = self._jobs.get(job_id)
        if job is None or job_id != self._current:
            return
        if job.state is JobState.RUNNING:
            job.advance(JobState.WRITING)
        job.advance(JobState.DONE)
        job.cached = bool(result.get("cached"))
        job.output_dir = result["directory"]
        job.message = "From cache" if job.cached else ""
        self._extra[job.id]["stems"] = result["stems"]
        self._extra[job.id]["analysis"] = result.get("analysis", {})
        self._extra[job.id]["notes"] = result.get("notes", [])
        self._extra[job.id]["part"] = result.get("part")
        self._current = None
        manifest_dir = result["directory"]
        from openstems.pipeline.run import read_manifest

        manifest = read_manifest(Path(manifest_dir))
        if manifest is not None:
            self.index.save_stem_set(os.path.normpath(manifest_dir), manifest)
        self._changed(job)
        self.bus.publish("stemsets.changed")

    def _finish_current(self, state: JobState, error: str | None) -> None:
        job = self._jobs.get(self._current or "")
        self._current = None
        if job is None or job.is_terminal:
            return
        job.advance(state, error=error)
        job.message = ""
        self._changed(job)


def _with_empty(stems: list[Any]) -> list[Any]:
    """The stems of a job saved before stems said whether they are empty, with that said
    (from their peaks files, which a stem of that time has in place of a measured peak)."""
    if not all(isinstance(stem, dict) for stem in stems) or all("empty" in stem for stem in stems):
        return stems
    from openstems.pipeline.levels import mark_empty

    return mark_empty([dict(stem) for stem in stems])


def _with_start(stem: Any) -> Any:
    """A stem of a job saved before stems said where they start in the song: its start,
    from the offset the worker sent with it (counted at the engine's rate)."""
    if not isinstance(stem, dict) or "start" in stem:
        return stem
    try:
        offset = int(stem.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    return {**stem, "start": offset / SAMPLE_RATE}
