"""Download model files: resume, sha256 verification and progress."""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable
from pathlib import Path

import httpx

from openstems.catalog.store import HASH_BLOCK, BytesProgress, ModelStore
from openstems.domain.errors import Cancelled, DomainError
from openstems.domain.model import ModelFile, ModelSpec

CHUNK = 1024 * 1024
TIMEOUT = httpx.Timeout(30.0, read=60.0)
USER_AGENT = "OpenStems"


class DownloadError(DomainError):
    pass


def _client() -> httpx.Client:
    return httpx.Client(follow_redirects=True, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})


def download_file(
    file: ModelFile,
    dest: Path,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    client: httpx.Client | None = None,
    retries: int = 3,
) -> None:
    """Download to ``dest.part`` (resuming a partial file), verify sha256, then rename.

    ``progress`` receives byte deltas, including the bytes already on disk when resuming.
    A file that fails verification is deleted, never left in place.
    """
    if not file.url:
        raise DownloadError(f"{file.name}: no download URL (custom model)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    own_client = client is None
    http = client or _client()
    try:
        attempt = 0
        while True:
            have = part.stat().st_size if part.exists() else 0
            if have > file.size:
                part.unlink()
                have = 0
            try:
                if have < file.size:
                    # Bytes already on disk are reported once, on the first attempt.
                    _fetch(http, file, part, have, progress, should_cancel, attempt == 0)
                elif progress and attempt == 0:
                    progress(have)
                break
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                attempt += 1
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if attempt > retries or status in (401, 403, 404, 410):
                    raise DownloadError(f"{file.name}: download failed: {exc}") from exc
                time.sleep(min(2**attempt, 8))

        digest = hashlib.sha256()
        with part.open("rb") as handle:
            while block := handle.read(HASH_BLOCK):
                if should_cancel and should_cancel():
                    raise Cancelled()
                digest.update(block)
        if digest.hexdigest() != file.sha256.lower():
            part.unlink(missing_ok=True)
            raise DownloadError(
                f"{file.name}: sha256 mismatch after download "
                f"(got {digest.hexdigest()[:12]}..., expected {file.sha256[:12]}...)"
            )
        os.replace(part, dest)
    finally:
        if own_client:
            http.close()


def _fetch(
    http: httpx.Client,
    file: ModelFile,
    part: Path,
    have: int,
    progress: Callable[[int], None] | None,
    should_cancel: Callable[[], bool] | None,
    report_existing: bool = True,
) -> None:
    headers = {"Range": f"bytes={have}-"} if have else {}
    with http.stream("GET", file.url, headers=headers) as response:
        if have and response.status_code == 200:
            have = 0  # the server ignored the range: start again
        elif response.status_code == 416:
            part.unlink(missing_ok=True)
            raise httpx.TransportError("range not satisfiable; restarting")
        response.raise_for_status()
        if progress and have and report_existing:
            progress(have)
        with part.open("ab" if have else "wb") as handle:
            for block in response.iter_bytes(CHUNK):
                if should_cancel and should_cancel():
                    raise Cancelled()
                handle.write(block)
                if progress:
                    progress(len(block))


def pull_model(
    spec: ModelSpec,
    store: ModelStore,
    progress: BytesProgress | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> None:
    """Fetch every missing file of a model, then verify the whole model."""
    if store.fake:
        _fake_pull(spec, progress, should_cancel)
        return
    if store.is_installed(spec):
        if progress:
            progress(spec.total_bytes, spec.total_bytes)
        return
    done = 0

    def bump(n: int) -> None:
        nonlocal done
        done += n
        if progress:
            progress(max(0, min(done, spec.total_bytes)), spec.total_bytes)

    with _client() as http:
        for file in spec.files:
            dest = store.file_path(spec, file)
            if dest.is_file() and dest.stat().st_size == file.size:
                bump(file.size)
                continue
            dest.unlink(missing_ok=True)
            download_file(file, dest, bump, should_cancel, client=http)
    problems = store.verify(spec, should_cancel=should_cancel)
    if problems:
        raise DownloadError(f"{spec.id}: " + "; ".join(problems))


def _fake_pull(
    spec: ModelSpec,
    progress: BytesProgress | None,
    should_cancel: Callable[[], bool] | None,
) -> None:
    steps = 10
    for i in range(1, steps + 1):
        if should_cancel and should_cancel():
            raise Cancelled()
        time.sleep(float(os.environ.get("OPENSTEMS_FAKE_DELAY", "0.02")))
        if progress:
            progress(spec.total_bytes * i // steps, spec.total_bytes)


def check_live(spec: ModelSpec, client: httpx.Client | None = None) -> list[str]:
    """Liveness check: every URL answers and reports the catalogued size."""
    problems: list[str] = []
    own = client is None
    http = client or _client()
    try:
        for file in spec.files:
            if not file.url:
                continue
            try:
                # Ask for the raw bytes: a compressed response reports a smaller length.
                plain = {"Accept-Encoding": "identity"}
                response = http.head(file.url, headers=plain)
                if response.status_code in (403, 405):
                    response = http.get(file.url, headers={**plain, "Range": "bytes=0-0"})
                if response.status_code >= 400:
                    problems.append(f"{file.name}: HTTP {response.status_code}")
                    continue
                size = response.headers.get("content-range", "").rpartition("/")[2] or (
                    response.headers.get("content-length", "")
                )
                if response.status_code != 206 and size.isdigit() and int(size) != file.size:
                    problems.append(f"{file.name}: remote size {size}, catalog {file.size}")
            except httpx.HTTPError as exc:
                problems.append(f"{file.name}: {exc.__class__.__name__}: {exc}")
    finally:
        if own:
            http.close()
    return problems
