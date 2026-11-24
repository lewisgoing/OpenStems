"""Starts the worker process, relays its events and restarts it if it dies."""

from __future__ import annotations

import multiprocessing as mp
import os
import queue
import threading
from collections.abc import Callable
from multiprocessing.process import BaseProcess
from typing import Any

from openstems.worker.process import worker_main

EventHandler = Callable[[tuple[Any, ...]], None]

# How long a worker that ends by itself after a failed job gets to exit before it is killed.
RETIRE_SECONDS = 10.0

# Environment the worker needs to see even though it is a fresh interpreter.
_ENV_KEYS = (
    "OPENSTEMS_ENGINE",
    "OPENSTEMS_FAKE_DELAY",
    "OPENSTEMS_FAKE_OOM",
    "OPENSTEMS_FAKE_LATE",
    "OPENSTEMS_FAKE_IMPORT_FAILS",
    "OPENSTEMS_MEMORY_GB",
    "OPENSTEMS_CONFIG_DIR",
    "OPENSTEMS_MODELS_DIR",
    "OPENSTEMS_OUTPUT_DIR",
    "OPENSTEMS_CACHE_DIR",
)


class WorkerSupervisor:
    """One GPU worker process fed by a queue.

    ``on_event`` receives the worker's events on the pump thread. A worker that dies
    produces a ``("crashed",)`` event and is restarted, so a crash cannot take the API down.
    One that ends itself after a job failed unexpectedly is replaced quietly (`_replace`).
    """

    def __init__(self, on_event: EventHandler) -> None:
        self._on_event = on_event
        self._ctx = mp.get_context("spawn")
        self._lock = threading.RLock()
        self._process: BaseProcess | None = None
        self._commands: Any = None
        self._events: Any = None
        self._cancel_seq: Any = None
        self._pump: threading.Thread | None = None
        self._stopping = threading.Event()
        self.ready = threading.Event()
        self.restarts = 0

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        with self._lock:
            self._stopping.clear()
            self._spawn()
            self._pump = threading.Thread(target=self._run_pump, name="worker-pump", daemon=True)
            self._pump.start()

    def _spawn(self) -> None:
        self.ready.clear()
        self._commands = self._ctx.Queue()
        self._events = self._ctx.Queue()
        self._cancel_seq = self._ctx.Value("q", -1)
        env = {k: os.environ[k] for k in _ENV_KEYS if k in os.environ}
        process = self._ctx.Process(
            target=worker_main,
            args=(self._commands, self._events, self._cancel_seq, env),
            name="openstems-worker",
            daemon=True,
        )
        process.start()
        self._process = process

    def stop(self, timeout: float = 5.0) -> None:
        self._stopping.set()
        with self._lock:
            process = self._process
            if process is not None and process.is_alive():
                try:
                    self._cancel_seq.value = -2  # nothing matches; jobs see shutdown next
                    self._commands.put(("shutdown",))
                except (ValueError, OSError):
                    pass
        if process is not None:
            process.join(timeout)
            if process.is_alive():
                process.kill()
                process.join(2)
        if self._pump is not None and self._pump is not threading.current_thread():
            self._pump.join(2)

    # -- commands -------------------------------------------------------------

    @property
    def pid(self) -> int | None:
        process = self._process
        return process.pid if process is not None and process.is_alive() else None

    @property
    def alive(self) -> bool:
        process = self._process
        return process is not None and process.is_alive()

    def submit(self, seq: int, payload: dict[str, Any]) -> None:
        with self._lock:
            self._commands.put(("run", seq, payload))

    def cancel(self, seq: int) -> None:
        with self._lock:
            if self._cancel_seq is not None:
                self._cancel_seq.value = seq

    def evict(self, model_id: str) -> None:
        with self._lock:
            if self.alive:
                self._commands.put(("evict", model_id))

    def kill(self) -> None:
        """Kill the worker outright (used when a cancel is not honored, and by tests)."""
        process = self._process
        if process is not None and process.is_alive():
            process.kill()

    # -- pump -----------------------------------------------------------------

    def _run_pump(self) -> None:
        while not self._stopping.is_set():
            events, process = self._events, self._process
            try:
                event = events.get(timeout=0.2)
            except queue.Empty:
                if process is not None and not process.is_alive() and not self._stopping.is_set():
                    self._handle_crash()
                continue
            except (EOFError, OSError, ValueError):
                if not self._stopping.is_set():
                    self._handle_crash()
                continue
            if event[0] == "ready":
                self.ready.set()
            self._on_event(event)
            if event[0] == "failed" and len(event) > 4 and event[4]:
                self._replace()

    def _replace(self) -> None:
        """Start a fresh worker in place of one that ends by itself after a job that failed
        with an unexpected error (`process.run_job`). Not a crash: nothing else is failed and
        nothing is counted. The job manager holds the queue until the new one is ready."""
        process = self._process
        if process is not None:
            process.join(RETIRE_SECONDS)
            if process.is_alive():
                process.kill()
                process.join(2)
        with self._lock:
            if not self._stopping.is_set():
                self._spawn()

    def _handle_crash(self) -> None:
        with self._lock:
            if self._stopping.is_set():
                return
            self.restarts += 1
            self._spawn()
        self._on_event(("crashed",))
