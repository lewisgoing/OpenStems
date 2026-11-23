"""Model downloads for the API: one background thread per model, progress on the event bus."""

from __future__ import annotations

import threading
import time
from typing import Any

from openstems.api.events import EventBus
from openstems.catalog.download import pull_model
from openstems.catalog.store import ModelStore
from openstems.domain.errors import Cancelled, DomainError
from openstems.domain.model import ModelSpec

PROGRESS_INTERVAL = 0.2


class DownloadManager:
    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self._lock = threading.Lock()
        self._active: dict[str, dict[str, Any]] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}

    def state(self, model_id: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._active.get(model_id)
            return dict(entry) if entry else None

    def start(self, spec: ModelSpec, store: ModelStore) -> None:
        with self._lock:
            current = self._active.get(spec.id)
            if current and current["state"] in ("downloading", "verifying"):
                return
            self._active[spec.id] = {
                "state": "downloading",
                "done": store.present_bytes(spec),
                "total": spec.total_bytes,
                "error": None,
            }
            cancel = self._cancel[spec.id] = threading.Event()
            thread = threading.Thread(
                target=self._run, args=(spec, store, cancel), name=f"pull-{spec.id}", daemon=True
            )
            self._threads[spec.id] = thread
        self._publish(spec.id)
        thread.start()

    def cancel(self, model_id: str) -> bool:
        with self._lock:
            event = self._cancel.get(model_id)
        if event is None:
            return False
        event.set()
        return True

    def wait(self, model_id: str, timeout: float = 30.0) -> None:
        thread = self._threads.get(model_id)
        if thread is not None:
            thread.join(timeout)

    def stop(self) -> None:
        with self._lock:
            events = list(self._cancel.values())
            threads = list(self._threads.values())
        for event in events:
            event.set()
        for thread in threads:
            thread.join(3)

    def _publish(self, model_id: str) -> None:
        state = self.state(model_id)
        if state is not None:
            self.bus.publish("model.progress", id=model_id, **state)

    def _run(self, spec: ModelSpec, store: ModelStore, cancel: threading.Event) -> None:
        last = 0.0

        def on_progress(done: int, total: int) -> None:
            nonlocal last
            with self._lock:
                entry = self._active[spec.id]
                entry["done"], entry["total"] = done, total
                if done >= total:
                    entry["state"] = "verifying"
            now = time.monotonic()
            if now - last >= PROGRESS_INTERVAL or done >= total:
                last = now
                self._publish(spec.id)

        try:
            pull_model(spec, store, on_progress, cancel.is_set)
            outcome, error = "installed", None
        except Cancelled:
            outcome, error = "cancelled", None
        except DomainError as exc:
            outcome, error = "failed", str(exc)
        except Exception as exc:
            outcome, error = "failed", f"{exc.__class__.__name__}: {exc}"
        with self._lock:
            self._active[spec.id].update(state=outcome, error=error)
        self._publish(spec.id)
        self.bus.publish("models.changed", id=spec.id)
        with self._lock:
            # A finished download no longer overrides the store's own status.
            if outcome == "installed":
                self._active.pop(spec.id, None)
            self._cancel.pop(spec.id, None)
