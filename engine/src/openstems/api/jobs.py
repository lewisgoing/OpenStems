"""The job queue: one job on the GPU at a time, in order, with cancel, retry and reorder."""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from openstems.api.db import Index
from openstems.api.events import EventBus
from openstems.domain.errors import DomainError
from openstems.domain.job import Job, JobState
from openstems.worker.supervisor import WorkerSupervisor

_STAGE_STATE = {
    "preparing": JobState.PREPARING,
    "running": JobState.RUNNING,
    "writing": JobState.WRITING,
}
_ORDER = [JobState.PREPARING, JobState.RUNNING, JobState.WRITING]
MAX_FINISHED = 300


class JobNotFound(DomainError):
    pass


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
                "stems": data.get("stems", []),
                "analysis": data.get("analysis", {}),
            }
            self._order.append(job.id)

    # -- views ----------------------------------------------------------------

    def to_dict(self, job: Job) -> dict[str, Any]:
        extra = self._extra.get(job.id, {})
        queued = [j for j in self._order if self._jobs[j].state is JobState.QUEUED]
        return {
            "id": job.id,
            "track_path": job.track_path,
            "track_name": Path(job.track_path).stem,
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
            "queue_position": queued.index(job.id) if job.id in queued else None,
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
    ) -> dict[str, Any]:
        job = Job(track_path=track_path, recipe_id=recipe_id, quality=quality)
        job.options = dict(options or {})
        with self._lock:
            self._jobs[job.id] = job
            self._extra[job.id] = {"recipe_name": recipe_name, "stems": [], "analysis": {}}
            self._order.append(job.id)
            self._changed(job)
            self._trim_finished()
            self._dispatch()
            return self.to_dict(job)

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
            if job.state is JobState.QUEUED:
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
                if event[1] == self._current:
                    self._finish_current(JobState.FAILED, event[2])
            elif kind == "cancelled":
                if event[1] == self._current:
                    self._finish_current(JobState.CANCELLED, None)
            elif kind == "idle":
                self._dispatch()

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
