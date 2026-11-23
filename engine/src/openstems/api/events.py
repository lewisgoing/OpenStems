"""Event bus: worker and download threads publish, WebSocket clients subscribe."""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import threading
from typing import Any


class EventBus:
    """Fan-out of JSON events to any number of subscribers. ``publish`` is thread-safe.

    Every event gets a strictly increasing ``seq`` so clients can tell the order.
    """

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._seq = itertools.count(1)
        self._lock = threading.Lock()
        self.history: list[dict[str, Any]] = []  # kept only when record is on (tests)
        self.record = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    def publish(self, kind: str, **data: Any) -> None:
        with self._lock:
            event = {"type": kind, "seq": next(self._seq), **data}
            if self.record:
                self.history.append(event)
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with contextlib.suppress(RuntimeError):  # the loop is shutting down
            loop.call_soon_threadsafe(self._deliver, event)

    def _deliver(self, event: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # A client that stopped reading: drop it rather than grow without bound.
                self._subscribers.discard(q)
