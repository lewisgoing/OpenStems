"""The GPU worker process: one long-lived process that runs jobs one at a time.

It owns the models (the last one stays warm) and talks to the API process through two
queues. A cancel is a shared integer: the sequence number of the job to stop.

A warm model is graphics memory. The app can sit in the tray for days, so after a stretch
with no job the worker lets its models go; the next job loads its model again.
"""

from __future__ import annotations

import os
import queue
import time
import traceback
from multiprocessing.queues import Queue
from multiprocessing.sharedctypes import Synchronized
from typing import Any

from openstems.domain.errors import Cancelled, DomainError
from openstems.engines.base import CancelToken

PROGRESS_INTERVAL = 0.1  # seconds between progress events
IDLE_UNLOAD_SECONDS = 600.0  # with no job for this long, the warm models are unloaded


def idle_unload_seconds() -> float:
    """How long the worker keeps models warm without a job. Zero or less means for ever."""
    raw = os.environ.get("OPENSTEMS_IDLE_UNLOAD_SECONDS", "")
    try:
        return float(raw) if raw.strip() else IDLE_UNLOAD_SECONDS
    except ValueError:
        return IDLE_UNLOAD_SECONDS


def next_command(commands: Any, host: Any, idle_seconds: float) -> Any:
    """Wait for the next command. If none comes within ``idle_seconds``, unload the warm
    models once and go on waiting: an idle worker should not hold graphics memory."""
    if idle_seconds <= 0:
        return commands.get()
    try:
        return commands.get(timeout=idle_seconds)
    except queue.Empty:
        host.clear()
        return commands.get()


class SharedCancel(CancelToken):
    """A cancel token backed by a value shared with the API process."""

    def __init__(self, shared: Synchronized[int], seq: int) -> None:
        super().__init__()
        self._shared = shared
        self._seq = seq

    @property
    def cancelled(self) -> bool:
        return self._shared.value == self._seq or super().cancelled

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise Cancelled()


def stem_set_payload(result: Any) -> dict[str, Any]:
    directory = result.directory
    return {
        "directory": directory,
        "cached": result.cached,
        "cache_key": result.manifest.get("cache_key"),
        "analysis": result.manifest.get("analysis") or {},
        "stems": [
            {
                "name": s.name,
                "file": s.file,
                "path": os.path.join(directory, s.file),
                "peaks": os.path.join(directory, s.peaks) if s.peaks else None,
                "midi": os.path.join(directory, s.midi) if s.midi else None,
                "offset": s.offset,
                "samples": s.samples,
                "sample_rate": s.sample_rate,
            }
            for s in result.stems
        ],
    }


def run_job(runtime: Any, payload: dict[str, Any], events: Queue, cancel: CancelToken) -> None:
    job_id = payload["id"]
    last = {"t": 0.0, "stage": ""}

    def on_progress(p: Any) -> None:
        now = time.monotonic()
        if p.stage != last["stage"] or now - last["t"] >= PROGRESS_INTERVAL or p.fraction >= 1:
            last["t"], last["stage"] = now, p.stage
            events.put(("progress", job_id, p.stage, p.fraction, p.message))

    try:
        runtime.reload()  # pick up settings changes and newly imported models
        recipe = runtime.recipe(payload["recipe_id"])
        options = runtime.options(quality=payload.get("quality"), **payload.get("options", {}))
        output_root = payload.get("output_root") or runtime.settings.output_path
        result = runtime.pipeline.run(
            payload["track_path"], recipe, output_root, options, on_progress, cancel
        )
        events.put(("done", job_id, stem_set_payload(result)))
    except Cancelled:
        events.put(("cancelled", job_id))
    except DomainError as exc:
        events.put(("failed", job_id, str(exc)))
    except Exception as exc:
        traceback.print_exc()
        events.put(("failed", job_id, f"{exc.__class__.__name__}: {exc}"))


def _exit_with_parent(parent_pid: int) -> None:
    """Never outlive the API process: if it dies without a goodbye, exit at once."""
    import threading

    from openstems.procutil import process_alive

    def watch() -> None:
        while process_alive(parent_pid):
            time.sleep(1.0)
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def worker_main(
    commands: Queue, events: Queue, cancel_seq: Synchronized[int], env: dict[str, str]
) -> None:
    """Entry point of the worker process."""
    os.environ.update(env)
    _exit_with_parent(os.getppid())
    from openstems.runtime import build_runtime

    try:
        runtime = build_runtime()
    except Exception as exc:
        events.put(("fatal", f"{exc.__class__.__name__}: {exc}"))
        return
    events.put(("ready", os.getpid()))
    idle_seconds = idle_unload_seconds()
    while True:
        command = next_command(commands, runtime.pipeline.host, idle_seconds)
        kind = command[0]
        if kind == "shutdown":
            runtime.pipeline.host.clear()
            return
        if kind == "evict":
            runtime.pipeline.host.evict(command[1])
        elif kind == "run":
            seq, payload = command[1], command[2]
            run_job(runtime, payload, events, SharedCancel(cancel_seq, seq))
            events.put(("idle", seq))
