"""The Engine port: build a model and run it over audio.

Engines report progress, honor cancel, and never read or write audio files.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Protocol

import numpy as np

from openstems.catalog.store import ModelStore
from openstems.domain.errors import Cancelled
from openstems.domain.model import ModelSpec
from openstems.domain.quality import RunSettings

ProgressFn = Callable[[float], None]


class CancelToken:
    """A thread-safe cancel flag checked between chunks."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise Cancelled()


class LoadedModel(Protocol):
    spec: ModelSpec
    vram_bytes: int

    def separate(
        self,
        mix: np.ndarray,
        settings: RunSettings,
        progress: ProgressFn | None = None,
        cancel: CancelToken | None = None,
        only: frozenset[str] | None = None,
    ) -> dict[str, np.ndarray]:
        """Split ``(2, samples)`` float32 audio into stems of the same shape.

        ``only`` limits which stems are computed and returned.
        """
        ...

    def unload(self) -> None: ...


class Engine(Protocol):
    name: str

    def load(self, spec: ModelSpec, store: ModelStore, device: str | None = None) -> LoadedModel:
        """Build the model on the device the settings choose, or on ``device`` ("cpu")
        when the pipeline asks for one."""
        ...
