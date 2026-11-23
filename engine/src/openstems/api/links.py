"""Links on their way to the queue: each is fetched on a background thread, with progress on
the event bus, and becomes an ordinary job once its audio is on disk.

A link is not a job yet: the queue is about files. It has its own short life here (waiting,
resolving, downloading), and only a failed one stays around, to be retried or dismissed.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from openstems.api.events import EventBus
from openstems.domain.errors import Cancelled, DomainError
from openstems.links import Fetched, fetch, folder_for, host_of

PROGRESS_INTERVAL = 0.2
# Sites slow down or refuse a client that asks for many songs at once.
MAX_PARALLEL = 2

# Called with the request a link came with and the fetched file; queues the job.
QueueFn = Callable[[dict[str, Any], Fetched], Any]
RootFn = Callable[[], Path]


class LinkNotFound(DomainError):
    pass


def _remove_partial(folder: Path) -> None:
    """After a cancelled fetch: leave nothing half-fetched behind. A file fetched in full
    stays, because a job from an earlier paste of the same link may be using it."""
    try:
        for item in folder.iterdir():
            if item.suffix in (".part", ".ytdl"):
                item.unlink(missing_ok=True)
        if not any(folder.iterdir()):
            folder.rmdir()
    except OSError:
        pass


class LinkManager:
    def __init__(self, bus: EventBus, root: RootFn, queue: QueueFn) -> None:
        self.bus = bus
        self._root = root
        self._queue = queue
        self._lock = threading.Lock()
        self._links: dict[str, dict[str, Any]] = {}
        self._requests: dict[str, dict[str, Any]] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._slots = threading.Semaphore(MAX_PARALLEL)

    # -- views ----------------------------------------------------------------

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(link) for link in self._links.values()]

    def _publish(self, link_id: str) -> None:
        with self._lock:
            link = self._links.get(link_id)
            data = dict(link) if link else None
        if data is not None:
            self.bus.publish("link.updated", link=data)

    # -- commands -------------------------------------------------------------

    def add(self, url: str, request: dict[str, Any]) -> dict[str, Any]:
        """Start fetching ``url``. ``request`` is what to run on the song once it is here."""
        link_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._links[link_id] = {
                "id": link_id,
                "url": url,
                "name": host_of(url),
                "state": "waiting",
                "progress": 0.0,
                "error": None,
                "created_at": time.time(),
            }
            self._requests[link_id] = request
        self._begin(link_id)
        return self.get(link_id)

    def get(self, link_id: str) -> dict[str, Any]:
        with self._lock:
            try:
                return dict(self._links[link_id])
            except KeyError:
                raise LinkNotFound(f"no such link: {link_id}") from None

    def retry(self, link_id: str) -> dict[str, Any]:
        with self._lock:
            link = self._links.get(link_id)
            if link is None:
                raise LinkNotFound(f"no such link: {link_id}")
            if link["state"] != "failed":
                raise DomainError("only a link that failed can be fetched again")
            link.update(state="waiting", progress=0.0, error=None)
        self._begin(link_id)
        return self.get(link_id)

    def remove(self, link_id: str) -> None:
        """Cancel a fetch that is under way, or dismiss one that failed. It is gone from the
        list at once; the thread notices on its next step and cleans up after itself."""
        with self._lock:
            if link_id not in self._links:
                raise LinkNotFound(f"no such link: {link_id}")
            del self._links[link_id]
            self._requests.pop(link_id, None)
            event = self._cancel.pop(link_id, None)
        if event is not None:
            event.set()
        self.bus.publish("link.removed", id=link_id)

    def stop(self) -> None:
        with self._lock:
            events = list(self._cancel.values())
            threads = list(self._threads.values())
        for event in events:
            event.set()
        for thread in threads:
            thread.join(3)

    # -- the fetch (one thread per link) ---------------------------------------

    def _begin(self, link_id: str) -> None:
        cancel = threading.Event()
        thread = threading.Thread(
            target=self._run, args=(link_id, cancel), name=f"link-{link_id}", daemon=True
        )
        with self._lock:
            self._cancel[link_id] = cancel
            self._threads[link_id] = thread
        self._publish(link_id)
        thread.start()

    def _update(self, link_id: str, cancel: threading.Event, **changes: Any) -> None:
        with self._lock:
            link = self._links.get(link_id)
            if link is None or cancel.is_set():
                return
            link.update(changes)
        self._publish(link_id)

    def _run(self, link_id: str, cancel: threading.Event) -> None:
        with self._lock:
            link = self._links.get(link_id)
            request = self._requests.get(link_id)
        if link is None or request is None:
            return
        url = link["url"]
        root = self._root()
        last = 0.0

        def on_title(title: str) -> None:
            self._update(link_id, cancel, name=title, state="downloading")

        def on_progress(fraction: float) -> None:
            nonlocal last
            now = time.monotonic()
            if now - last < PROGRESS_INTERVAL and fraction < 1.0:
                return
            last = now
            self._update(link_id, cancel, progress=round(fraction, 4))

        error: str | None = None
        fetched: Fetched | None = None
        with self._slots:
            if not cancel.is_set():
                self._update(link_id, cancel, state="resolving")
                try:
                    fetched = fetch(url, root, on_title, on_progress, cancel.is_set)
                except Cancelled:
                    pass
                except DomainError as exc:
                    error = str(exc)
                except Exception as exc:
                    error = f"{exc.__class__.__name__}: {exc}"

        if cancel.is_set():
            _remove_partial(folder_for(root, url))
        elif fetched is not None:
            try:
                self._queue(request, fetched)
            except DomainError as exc:
                error = str(exc)
            else:
                # The job is in the queue: the link has done its part.
                with self._lock:
                    self._links.pop(link_id, None)
                    self._requests.pop(link_id, None)
                self.bus.publish("link.removed", id=link_id)
        if error is not None:
            self._update(link_id, cancel, state="failed", error=error, progress=0.0)
        with self._lock:
            if self._cancel.get(link_id) is cancel:
                del self._cancel[link_id]
            if self._threads.get(link_id) is threading.current_thread():
                del self._threads[link_id]
