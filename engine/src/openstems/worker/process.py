"""The GPU worker process: one long-lived process that runs jobs one at a time.

It owns the models (the last one stays warm) and talks to the API process through two
queues. A cancel is a shared integer: the sequence number of the job to stop.

A warm model is graphics memory. The app can sit in the tray for days, so after a stretch
with no job the worker lets its models go; the next job loads its model again.

A job that fails with an unexpected error ends the process (`run_job`): the supervisor
starts a fresh one, so the next job never inherits what that error broke.
"""

from __future__ import annotations

import os
import queue
import sys
import time
import traceback
from multiprocessing.queues import Queue
from multiprocessing.sharedctypes import Synchronized
from typing import Any

from openstems.domain.errors import Cancelled, DomainError
from openstems.engines.base import CancelToken

PROGRESS_INTERVAL = 0.1  # seconds between progress events
IDLE_UNLOAD_SECONDS = 600.0  # with no job for this long, the warm models are unloaded
# On a small machine a warm model is memory the user's other apps want back.
SMALL_IDLE_UNLOAD_SECONDS = 60.0
# Windows' "The paging file is too small for this operation to complete": the memory the
# system can promise (RAM and paging file together) has run out. Loading PyTorch's CUDA
# libraries promises several GB, so it is where a full system drive shows first.
PAGING_FILE_FULL = 1455
PAGING_FILE_NOTE = (
    "Windows ran out of memory (its paging file is full). Close some programs or free "
    "space on the system drive (usually C:), then try again."
)


def idle_unload_seconds(small: bool = False) -> float:
    """How long the worker keeps models warm without a job. Zero or less means for ever.
    ``small`` is for a machine with little memory, which lets go sooner."""
    default = SMALL_IDLE_UNLOAD_SECONDS if small else IDLE_UNLOAD_SECONDS
    raw = os.environ.get("OPENSTEMS_IDLE_UNLOAD_SECONDS", "")
    try:
        return float(raw) if raw.strip() else default
    except ValueError:
        return default


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
    from openstems.pipeline.levels import mark_empty
    from openstems.pipeline.run import SAMPLE_RATE

    directory = result.directory
    return {
        "directory": directory,
        "cached": result.cached,
        "cache_key": result.manifest.get("cache_key"),
        "analysis": result.manifest.get("analysis") or {},
        "notes": list(result.manifest.get("notes") or []),
        # The part of the song these stems are, when only a part of it was separated.
        "part": (result.manifest.get("source") or {}).get("range"),
        "stems": mark_empty(
            [
                {
                    "name": s.name,
                    "file": s.file,
                    "path": os.path.join(directory, s.file),
                    "peaks": os.path.join(directory, s.peaks) if s.peaks else None,
                    "midi": os.path.join(directory, s.midi) if s.midi else None,
                    "offset": s.offset,
                    # Seconds into the song where the file begins: later when silence was trimmed.
                    "start": s.offset / SAMPLE_RATE,
                    "samples": s.samples,
                    "sample_rate": s.sample_rate,
                    "group": s.group or None,
                    "peak": s.peak,
                }
                for s in result.stems
            ]
        ),
    }


def windows_words(code: int) -> str:
    """Windows' own sentence for an error code, in the machine's language. Empty elsewhere."""
    if sys.platform != "win32":
        return ""
    import ctypes

    return ctypes.FormatError(code).strip()


def paging_file_full(exc: BaseException) -> bool:
    """Whether Windows refused for lack of memory it can promise. PyTorch's own loader raises
    the error with its code (`OSError.winerror`). A DLL that Python loads itself, such as
    the one behind `torch._C`, fails as an ImportError with only Windows' sentence."""
    if getattr(exc, "winerror", None) == PAGING_FILE_FULL:
        return True
    words = windows_words(PAGING_FILE_FULL)
    return bool(words) and words in str(exc)


def failure_message(exc: BaseException) -> str:
    """What a job that failed with an unexpected error says. Windows refuses to load
    PyTorch's libraries when the memory it can promise runs out (its paging file is full):
    the error names a DLL, so say instead what the user can do about it."""
    if paging_file_full(exc):
        return PAGING_FILE_NOTE
    return f"{exc.__class__.__name__}: {exc}"


def run_job(runtime: Any, payload: dict[str, Any], events: Queue, cancel: CancelToken) -> bool:
    """Run one job and report how it ended. False when it failed with an unexpected error
    (neither the user's nor a cancel), which may have left this process unable to run
    another: a failed import keeps half of a library loaded for good (PyTorch's, when
    Windows runs out of memory while loading it), and a CUDA error spoils the GPU's context.
    The "failed" event says so, `worker_main` lets the process end, and the supervisor
    starts a fresh one for the next job."""
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
        events.put(("failed", job_id, str(exc), None, False))
    except Exception as exc:
        traceback.print_exc()
        # ("failed", job, message, traceback for the engine's log, whether this process ends)
        events.put(("failed", job_id, failure_message(exc), traceback.format_exc(), True))
        return False
    return True


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
    while True:
        # The host learns how small the machine is when it first loads a model.
        idle_seconds = idle_unload_seconds(runtime.pipeline.host.small)
        command = next_command(commands, runtime.pipeline.host, idle_seconds)
        kind = command[0]
        if kind == "shutdown":
            runtime.pipeline.host.clear()
            return
        if kind == "evict":
            runtime.pipeline.host.evict(command[1])
        elif kind == "run":
            seq, payload = command[1], command[2]
            if not run_job(runtime, payload, events, SharedCancel(cancel_seq, seq)):
                return  # a fresh process takes this one's place (`run_job`)
            events.put(("idle", seq))
