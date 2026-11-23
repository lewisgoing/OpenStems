"""Fetching the audio behind a link, so a song can be queued from its address.

yt-dlp does the work: it knows YouTube, SoundCloud, Bandcamp and many other sites, and a
direct link to a media file. Only the audio is fetched, in the format the site stores it in;
nothing is converted, because the decoder reads those formats as they are.

Sites change, and a pinned yt-dlp falls behind them: a fetch that fails for a site that used
to work usually needs a newer OpenStems (docs/adr/0013-links-and-mixes.md).
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from openstems.domain.errors import Cancelled, DomainError
from openstems.domain.naming import safe_component

# Longer than this is a broadcast or a compilation, not a song: decoded, it would not fit in
# memory.
MAX_SECONDS = 3 * 60 * 60
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_PREFIX = re.compile(r"^(ERROR:\s*)?(\[[^\]]+\]\s*)?([\w-]+:\s+)?")


_OFFLINE = ("Failed to resolve", "getaddrinfo", "timed out", "Connection refused", "Network is")
# What a title may hold that a file name may not, and what reads best in its place.
_TITLE = str.maketrans({":": " -", "/": "-", "\\": "-", "|": "-", "?": "", "*": "", '"': "'"})


def tidy_title(title: str) -> str:
    """A song's title as a file name: ``Artist: Song`` becomes ``Artist - Song``."""
    return safe_component(title.translate(_TITLE).replace("<", "(").replace(">", ")"), "Untitled")


class LinkError(DomainError):
    pass


@dataclass(frozen=True)
class Fetched:
    path: Path
    title: str


TitleFn = Callable[[str], None]
ProgressFn = Callable[[float], None]
CancelledFn = Callable[[], bool]


def check_url(url: str) -> str:
    """The address, trimmed, if it is one that can be fetched over the web."""
    url = url.strip()
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc or " " in url:
        raise LinkError("That is not a web link. Paste the address of a song's page.")
    return url


def host_of(url: str) -> str:
    """The site's name, to show while the song's own name is not known yet."""
    return (urlsplit(url).hostname or "link").removeprefix("www.")


def folder_for(root: Path, url: str) -> Path:
    """One folder per address: two songs with the same title never share a file, and the same
    link fetched again finds its file already there."""
    return root / hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]


def clean_error(message: str) -> str:
    """yt-dlp's message without colour codes and without its ``ERROR: [site] id:`` prefix."""
    text = _ANSI.sub("", message).strip().splitlines()[0] if message.strip() else ""
    text = _PREFIX.sub("", text, count=1).strip()
    if "Unsupported URL" in text:
        return "OpenStems cannot fetch a song from this page."
    if any(sign in text for sign in _OFFLINE):
        return "The site could not be reached. Check the connection and try again."
    return text[:300] or "The link could not be fetched."


def fetch(
    url: str,
    root: Path,
    on_title: TitleFn,
    on_progress: ProgressFn,
    cancelled: CancelledFn,
) -> Fetched:
    """Download the audio behind ``url`` into its folder under ``root``."""
    from openstems.engines.host import fake_mode

    url = check_url(url)
    folder = folder_for(root, url)
    folder.mkdir(parents=True, exist_ok=True)
    if fake_mode():
        return _fake_fetch(url, folder, on_title, on_progress, cancelled)
    return _ytdlp_fetch(url, folder, root, on_title, on_progress, cancelled)


# -- yt-dlp ---------------------------------------------------------------------------


def _deno() -> str | None:
    """The JavaScript runtime yt-dlp needs for YouTube. It is installed with the engine, in
    the environment's own folder, which is not on PATH when the app starts the engine."""
    try:
        import deno

        return str(deno.find_deno_bin())
    except Exception:
        return None


def _single(ydl: Any, info: dict[str, Any]) -> dict[str, Any]:
    """The one song a link stands for. A playlist is refused: which song was meant?"""
    if info.get("_type") != "playlist":
        return info
    entries = [e for e in (info.get("entries") or []) if e]
    if len(entries) != 1:
        raise LinkError(
            f"This link is a playlist of {len(entries)} songs. Paste the link to one song."
        )
    entry = entries[0]
    if entry.get("formats") or entry.get("url") is None:
        return entry
    resolved = ydl.extract_info(entry.get("webpage_url") or entry["url"], download=False)
    return _single(ydl, resolved)


def _ytdlp_fetch(
    url: str,
    folder: Path,
    root: Path,
    on_title: TitleFn,
    on_progress: ProgressFn,
    cancelled: CancelledFn,
) -> Fetched:
    import yt_dlp
    from yt_dlp.utils import DownloadCancelled, DownloadError

    class Stop(DownloadCancelled):
        pass

    class Quiet:
        """yt-dlp reports through a logger; errors arrive as exceptions as well."""

        def debug(self, message: str) -> None:
            pass

        info = warning = error = debug

    def hook(status: dict[str, Any]) -> None:
        if cancelled():
            raise Stop("cancelled")
        if status.get("status") == "downloading":
            total = status.get("total_bytes") or status.get("total_bytes_estimate")
            if total:
                on_progress(min(1.0, float(status.get("downloaded_bytes") or 0) / float(total)))

    options: dict[str, Any] = {
        "format": "bestaudio/best",
        "noplaylist": True,  # a song's link that also names a playlist means the song
        "extract_flat": "in_playlist",  # a playlist is refused without resolving every entry
        "logger": Quiet(),
        "progress_hooks": [hook],
        "noprogress": True,
        "cachedir": str(root / ".yt-dlp"),
        "socket_timeout": 20,
        "retries": 3,
        "overwrites": False,
        "continuedl": True,
    }
    deno = _deno()
    if deno:
        options["js_runtimes"] = {"deno": {"path": deno}}

    # Typed loosely: yt-dlp documents plain dicts, and its type stubs ask for more than that.
    downloader: Any = yt_dlp.YoutubeDL
    try:
        with downloader(options) as ydl:
            info = _single(ydl, ydl.extract_info(url, download=False))
            if cancelled():
                raise Cancelled()
            if info.get("is_live"):
                raise LinkError("This is a live stream. Paste the link to a finished song.")
            duration = info.get("duration")
            if isinstance(duration, int | float) and duration > MAX_SECONDS:
                raise LinkError(
                    f"This is {duration / 3600:.1f} hours long. Links up to "
                    f"{MAX_SECONDS // 3600} hours can be fetched."
                )
            title = tidy_title(str(info.get("title") or info.get("id") or ""))
            on_title(title)
            # The name on disk is ours: it becomes the track's name and the stems' names.
            ydl.params["outtmpl"] = {
                "default": str(folder / (title.replace("%", "%%") + ".%(ext)s"))
            }
            done = ydl.process_ie_result(info, download=True)
    except Stop:
        raise Cancelled() from None
    except DownloadError as exc:
        raise LinkError(clean_error(str(exc))) from exc
    except OSError as exc:
        raise LinkError(f"The song could not be saved: {exc}") from exc

    downloads = done.get("requested_downloads") or []
    path = Path(downloads[0].get("filepath") or "") if downloads else Path()
    if not downloads or not path.is_file():
        raise LinkError("The site sent no audio for this link.")
    on_progress(1.0)
    return Fetched(path=path, title=title)


# -- the stand-in for tests -------------------------------------------------------------


def _fake_fetch(
    url: str,
    folder: Path,
    on_title: TitleFn,
    on_progress: ProgressFn,
    cancelled: CancelledFn,
) -> Fetched:
    """No network: a short tone named after the link. ``fail`` in the address fails the
    fetch, ``playlist`` refuses it as one, and ``slow`` takes a few seconds, so that a fetch
    can be watched and cancelled."""
    import numpy as np

    from openstems.audio.write import write_audio

    parts = urlsplit(url)
    if "fail" in url:
        raise LinkError("OpenStems cannot fetch a song from this page.")
    if "playlist" in url:
        raise LinkError("This link is a playlist of 12 songs. Paste the link to one song.")
    named = parse_qs(parts.query).get("title", [""])[0] or Path(parts.path).stem
    title = tidy_title(named.replace("-", " ").replace("_", " ")) if named else "Linked song"
    on_title(title)
    pause = 0.15 if "slow" in url else float(os.environ.get("OPENSTEMS_FAKE_DELAY", "0"))
    for step in range(1, 21):
        if cancelled():
            raise Cancelled()
        on_progress(step / 20)
        if pause:
            time.sleep(pause)
    rate = 44100
    t = np.arange(int(0.6 * rate), dtype=np.float64) / rate
    audio = np.stack([0.4 * np.sin(2 * np.pi * 220 * t), 0.3 * np.sin(2 * np.pi * 330 * t)])
    path = folder / f"{title}.wav"
    write_audio(path, audio.astype(np.float32), rate)
    return Fetched(path=path, title=title)
