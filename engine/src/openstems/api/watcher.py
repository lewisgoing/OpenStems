"""Watch folder: queue new files with the default recipe."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from openstems.cli_inputs import is_media


class FolderWatcher:
    """Polls a folder. A file is queued once it is new since watching began and its size
    has stopped changing between two scans, so a file still being copied is left alone."""

    def __init__(self, submit: Callable[[Path], None], interval: float = 2.0) -> None:
        self._submit = submit
        self.interval = interval
        self._lock = threading.Lock()
        self._folder: Path | None = None
        self._exclude: Path | None = None
        self._done: set[str] = set()
        self._pending: dict[str, tuple[int, int]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def folder(self) -> Path | None:
        return self._folder

    def configure(self, folder: str, enabled: bool, exclude: Path | None = None) -> None:
        """Start, stop or retarget. Files already in the folder are not queued."""
        target = Path(folder) if enabled and folder.strip() else None
        with self._lock:
            if target == self._folder and exclude == self._exclude:
                return
            self._folder = target
            self._exclude = exclude
            self._pending = {}
            self._done = {str(p).lower() for p in self._files()} if target else set()

    def _files(self) -> list[Path]:
        folder = self._folder
        if folder is None or not folder.is_dir():
            return []
        found: list[Path] = []
        try:
            for path in folder.rglob("*"):
                if not path.is_file() or not is_media(path) or ".peaks" in path.parts:
                    continue
                # Never pick up our own output if it lives inside the watched folder.
                if self._exclude is not None and self._exclude in path.parents:
                    continue
                found.append(path)
        except OSError:
            return []
        return sorted(found)

    def scan(self) -> list[Path]:
        """One poll. Returns the files that were queued."""
        ready: list[Path] = []
        with self._lock:
            pending: dict[str, tuple[int, int]] = {}
            for path in self._files():
                key = str(path).lower()
                if key in self._done:
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                signature = (stat.st_size, stat.st_mtime_ns)
                if stat.st_size > 0 and self._pending.get(key) == signature:
                    self._done.add(key)
                    ready.append(path)
                else:
                    pending[key] = signature
            self._pending = pending
        for path in ready:
            self._submit(path)
        return ready

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="watch-folder", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(self.interval + 1)
            self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.scan()
            except Exception:  # never let a bad file stop the watcher
                continue
