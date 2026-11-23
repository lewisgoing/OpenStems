"""The models folder: where files live, whether they are present and hash-verified."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections.abc import Callable
from pathlib import Path

from openstems.catalog.catalog import CUSTOM_DIR
from openstems.domain.errors import Cancelled, DomainError
from openstems.domain.model import ModelFile, ModelSpec

MARKER = ".verified.json"
HASH_BLOCK = 4 * 1024 * 1024

BytesProgress = Callable[[int, int], None]  # (done_bytes, total_bytes)


class ModelNotInstalled(DomainError):
    def __init__(self, model_id: str, detail: str = "") -> None:
        super().__init__(
            f"model {model_id!r} is not installed{': ' + detail if detail else ''}. "
            f"Run: openstems models pull {model_id}"
        )
        self.model_id = model_id


def sha256_file(
    path: Path,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(HASH_BLOCK):
            if should_cancel and should_cancel():
                raise Cancelled()
            digest.update(block)
            if progress:
                progress(len(block))
    return digest.hexdigest()


class ModelStore:
    """Files on disk for catalog models. A model is usable only when every file is
    present and hash-verified; the marker file remembers a successful verification
    for as long as the files' size and modification time stay the same."""

    def __init__(self, models_dir: Path, *, fake: bool = False) -> None:
        self.root = Path(models_dir)
        self.fake = fake

    def model_dir(self, spec: ModelSpec) -> Path:
        return self.root / CUSTOM_DIR / spec.id if spec.custom else self.root / spec.id

    def file_path(self, spec: ModelSpec, file: ModelFile) -> Path:
        return self.model_dir(spec) / file.name

    def checkpoint_path(self, spec: ModelSpec) -> Path:
        return self.file_path(spec, spec.checkpoint)

    def config_path(self, spec: ModelSpec) -> Path | None:
        return self.file_path(spec, spec.config) if spec.config else None

    # -- status ---------------------------------------------------------------

    def _marker(self, spec: ModelSpec) -> dict[str, dict[str, object]]:
        try:
            data = json.loads((self.model_dir(spec) / MARKER).read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _file_verified(self, spec: ModelSpec, file: ModelFile, marker: dict) -> bool:
        path = self.file_path(spec, file)
        try:
            stat = path.stat()
        except OSError:
            return False
        entry = marker.get(file.name)
        return (
            isinstance(entry, dict)
            and stat.st_size == file.size
            and entry.get("sha256") == file.sha256.lower()
            and entry.get("size") == stat.st_size
            and entry.get("mtime_ns") == stat.st_mtime_ns
        )

    def present_bytes(self, spec: ModelSpec) -> int:
        total = 0
        for file in spec.files:
            for candidate in (self.file_path(spec, file), self._part(spec, file)):
                if candidate.is_file():
                    total += min(candidate.stat().st_size, file.size)
                    break
        return total

    def status(self, spec: ModelSpec) -> str:
        """``installed`` (verified), ``unverified`` (files present), ``partial`` or ``missing``."""
        if self.fake:
            return "installed"
        marker = self._marker(spec)
        if all(self._file_verified(spec, f, marker) for f in spec.files):
            return "installed"
        present = [self.file_path(spec, f).is_file() for f in spec.files]
        if all(present):
            return "unverified"
        if any(present) or any(self._part(spec, f).is_file() for f in spec.files):
            return "partial"
        return "missing"

    def is_installed(self, spec: ModelSpec) -> bool:
        return self.status(spec) == "installed"

    def _part(self, spec: ModelSpec, file: ModelFile) -> Path:
        return self.model_dir(spec) / (file.name + ".part")

    # -- verify ---------------------------------------------------------------

    def verify(
        self,
        spec: ModelSpec,
        progress: BytesProgress | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> list[str]:
        """Re-hash every file. Returns problems; writes the marker when there are none."""
        if self.fake:
            return []
        problems: list[str] = []
        marker: dict[str, dict[str, object]] = {}
        done = 0

        def bump(n: int) -> None:
            nonlocal done
            done += n
            if progress:
                progress(done, spec.total_bytes)

        for file in spec.files:
            path = self.file_path(spec, file)
            if not path.is_file():
                problems.append(f"{file.name}: missing")
                continue
            stat = path.stat()
            if stat.st_size != file.size:
                problems.append(f"{file.name}: size {stat.st_size}, expected {file.size}")
                continue
            actual = sha256_file(path, bump, should_cancel)
            if actual != file.sha256.lower():
                problems.append(f"{file.name}: sha256 mismatch ({actual[:12]}...)")
                continue
            marker[file.name] = {
                "sha256": actual,
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            }

        marker_path = self.model_dir(spec) / MARKER
        if problems:
            marker_path.unlink(missing_ok=True)
        else:
            marker_path.write_text(json.dumps(marker, indent=2), encoding="utf-8")
        return problems

    def require(self, spec: ModelSpec) -> None:
        """Raise unless the model is installed and verified. Verifies once if unmarked."""
        status = self.status(spec)
        if status == "installed":
            return
        if status == "unverified":
            problems = self.verify(spec)
            if not problems:
                return
            raise ModelNotInstalled(spec.id, "; ".join(problems))
        raise ModelNotInstalled(spec.id)

    def delete(self, spec: ModelSpec) -> bool:
        """Remove a model's files. Only ever touches the model's own folder."""
        folder = self.model_dir(spec)
        if not folder.is_dir():
            return False
        root = self.root.resolve()
        if root not in folder.resolve().parents:
            raise DomainError(f"refusing to delete outside the models folder: {folder}")
        shutil.rmtree(folder)
        return True

    def disk_bytes(self, spec: ModelSpec) -> int:
        folder = self.model_dir(spec)
        if not folder.is_dir():
            return 0
        return sum(os.path.getsize(folder / name) for name in os.listdir(folder) if name != MARKER)
