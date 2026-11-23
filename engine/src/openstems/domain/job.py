"""Jobs: one track run through one recipe."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from openstems.domain.errors import DomainError


class JobState(StrEnum):
    QUEUED = "queued"
    PREPARING = "preparing"
    RUNNING = "running"
    WRITING = "writing"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL = frozenset({JobState.DONE, JobState.FAILED, JobState.CANCELLED})

_ALLOWED: dict[JobState, frozenset[JobState]] = {
    JobState.QUEUED: frozenset({JobState.PREPARING, JobState.CANCELLED, JobState.FAILED}),
    JobState.PREPARING: frozenset(
        {JobState.RUNNING, JobState.DONE, JobState.FAILED, JobState.CANCELLED}
    ),
    JobState.RUNNING: frozenset({JobState.WRITING, JobState.FAILED, JobState.CANCELLED}),
    JobState.WRITING: frozenset({JobState.DONE, JobState.FAILED, JobState.CANCELLED}),
    JobState.DONE: frozenset(),
    JobState.FAILED: frozenset({JobState.QUEUED}),  # retry
    JobState.CANCELLED: frozenset({JobState.QUEUED}),  # retry
}


def can_transition(old: JobState, new: JobState) -> bool:
    return new in _ALLOWED[old]


@dataclass
class Job:
    track_path: str
    recipe_id: str
    quality: str = "balanced"
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    state: JobState = JobState.QUEUED
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    cached: bool = False
    output_dir: str | None = None
    options: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL

    def advance(self, new: JobState, *, error: str | None = None) -> None:
        if not can_transition(self.state, new):
            raise DomainError(f"job {self.id}: illegal transition {self.state} -> {new}")
        self.state = new
        now = time.time()
        if new is JobState.PREPARING:
            self.started_at = now
            self.finished_at = None
            self.error = None
        elif new is JobState.QUEUED:  # retry
            self.progress = 0.0
            self.error = None
            self.started_at = None
            self.finished_at = None
            self.cached = False
        elif new in TERMINAL:
            self.finished_at = now
            if new is JobState.DONE:
                self.progress = 1.0
            if new is JobState.FAILED:
                self.error = error or "failed"
