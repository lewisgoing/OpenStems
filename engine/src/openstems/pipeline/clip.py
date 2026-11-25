"""A stretch of a song as a file of its own, to drag into a DAW.

A clip is cut on the song's timeline from the song's own file or from its stems: one stem,
several summed into one file (the whole drum kit as "drums"), or every stem as a file of its
own. Like a mix (docs/adr/0013-links-and-mixes.md) it is written before the drag starts,
into a ``Clips`` folder: beside the stems for a clip of stems, beside the song's stem
folders for a clip of the song's own file. Only the stretch asked for is read from a stem.

Clips are always WAV: an MP3's encoder padding would put silence into a loop, and FL Studio
reads a tempo from WAV files alone (docs/adr/0016-tempo-sync.md).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import stat
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

import numpy as np

from openstems.audio.decode import decode, probe
from openstems.audio.write import audio_rate, read_comment, read_window, write_audio
from openstems.domain.errors import DomainError
from openstems.domain.grid import Grid, clean_selection, clip_label
from openstems.domain.naming import DEFAULT_TEMPLATE, MAX_COMPONENT, render_name, safe_component
from openstems.pipeline.mix import mix_label
from openstems.pipeline.run import SAMPLE_RATE, output_dir_for, read_manifest

CLIPS_DIR = "Clips"
# How far "<name> (2).wav", "(3)" and so on go: one more for each file of that name that is
# in use or holds something else.
MAX_COPIES = 99
# Stands for the selection's label while the naming template is filled in: a character from
# Unicode's private use area, which no template or token holds.
_MARK = "\ue000"


def render_clips(
    directory: Path,
    files: list[str],
    start: float,
    end: float,
    together: bool,
    grid: Grid | None,
) -> list[dict[str, Any]]:
    """Cut ``start`` to ``end``, in seconds of the song, from the named stem files of the
    stem set in ``directory``: summed into one file when ``together``, a file each when not.

    ``files`` are file names from the folder's manifest. ``grid`` names the selection
    ("bars 9-16"), and its tempo is the one the files are marked with when tempo sync was on
    for the song. Returns one entry per file, written now or found from before.
    """
    manifest = read_manifest(directory)
    if manifest is None:
        raise DomainError("that folder does not hold a set of stems")
    stems: list[dict[str, Any]] = list(manifest.get("stems", []))
    by_file = {str(stem["file"]): stem for stem in stems}
    wanted = list(dict.fromkeys(files))
    unknown = [name for name in wanted if name not in by_file]
    if unknown:
        raise DomainError(f"not a stem of this song: {unknown[0]}")
    if not wanted:
        raise DomainError("a clip needs at least one stem")
    # In the song's own stem order, whatever order they were asked for in.
    chosen = [stem for stem in stems if stem["file"] in wanted]
    rates: dict[str, int] = {}
    for stem in chosen:
        try:
            rates[stem["file"]] = audio_rate(directory / stem["file"])
        except (OSError, RuntimeError) as exc:
            raise DomainError(f"cannot read {stem['file']}: {exc}") from exc
    if together and len(set(rates.values())) > 1:
        raise DomainError("these stems have different sample rates and cannot be mixed")
    start, end = clean_selection(start, end, _song_seconds(manifest))

    options = manifest.get("options") or {}
    analysis = manifest.get("analysis") or {}
    fmt = _clip_format(options.get("format"))
    bpm = None
    if options.get("tempo_sync"):
        bpm = grid.bpm if grid is not None else analysis.get("bpm")
    source = manifest.get("source") or {}
    tokens = {
        "track": str(source.get("name") or directory.parent.name),
        "recipe": str((manifest.get("recipe") or {}).get("id") or ""),
        "bpm": str(analysis.get("bpm") or ""),
        "key": str(analysis.get("key") or ""),
    }
    template = str(options.get("template") or DEFAULT_TEMPLATE)
    every = [str(stem["name"]) for stem in stems]
    groups = {str(stem["name"]): str(stem["group"]) for stem in stems if stem.get("group")}
    selection = clip_label(grid, start, end)

    out: list[dict[str, Any]] = []
    for part in [chosen] if together else [[stem] for stem in chosen]:
        names = [str(stem["name"]) for stem in part]
        label = mix_label(names, every, groups) if len(part) > 1 else names[0]
        rate = rates[part[0]["file"]]
        first, frames = round(start * rate), round((end - start) * rate)
        audio = _summed([_stem_window(directory, stem, rate, first, frames) for stem in part])
        identity = _identity(
            files=[stem["file"] for stem in part],
            first=first,
            frames=frames,
            rate=rate,
            format=fmt,
            bpm=bpm,
        )
        path = _put(
            directory / CLIPS_DIR,
            _clip_name(template, label, selection, tokens),
            audio,
            rate,
            fmt,
            bpm,
            identity,
            [directory / stem["file"] for stem in part],
        )
        out.append(_entry(path, label, names, start, end, frames, rate))
    return out


def render_source_clip(
    source: Path,
    track_name: str,
    output_root: Path,
    start: float,
    end: float,
    grid: Grid | None,
    fmt: str,
    tempo_sync: bool,
    template: str,
) -> dict[str, Any]:
    """Cut ``start`` to ``end`` from a song's own file, at the file's own sample rate.

    The clip goes to ``<output>/<track>/Clips``, beside the song's stem folders, named by
    the naming template with the selection as the stem: "Satellite Rain - bars 9-16.wav".
    ``fmt`` is the output format of the settings: the clip is in it when it is wav24, in
    float WAV otherwise. With ``tempo_sync`` the clip is marked with the grid's tempo.
    """
    rate = probe(source).sample_rate or SAMPLE_RATE
    audio = decode(source, rate)
    start, end = clean_selection(start, end, audio.shape[1] / rate)
    first, frames = round(start * rate), round((end - start) * rate)
    window = np.zeros((audio.shape[0], frames), dtype=np.float32)
    piece = audio[:, first : first + frames]
    window[:, : piece.shape[1]] = piece
    del audio
    fmt = _clip_format(fmt)
    bpm = grid.bpm if tempo_sync and grid is not None else None
    tokens = {
        "track": track_name,
        "recipe": "",
        "bpm": str(grid.bpm) if grid is not None else "",
        "key": "",
    }
    identity = _identity(
        source=os.path.normcase(os.path.abspath(source)),
        first=first,
        frames=frames,
        rate=rate,
        format=fmt,
        bpm=bpm,
    )
    path = _put(
        # <output>/<track>/Clips: beside the stem folders, <output>/<track>/<recipe>.
        output_dir_for(output_root, track_name, CLIPS_DIR),
        _clip_name(template or DEFAULT_TEMPLATE, "", clip_label(grid, start, end), tokens),
        window,
        rate,
        fmt,
        bpm,
        identity,
        [source],
    )
    return _entry(path, "", [], start, end, frames, rate)


def _entry(
    path: Path, label: str, stems: list[str], start: float, end: float, frames: int, rate: int
) -> dict[str, Any]:
    return {
        "path": str(path),
        "name": path.name,
        "label": label,
        "stems": stems,
        "start": start,
        "end": end,
        "samples": int(frames),
        "sample_rate": int(rate),
    }


def _song_seconds(manifest: Mapping[str, Any]) -> float:
    """How long the song is: as it was decoded for separation, or else as far as its
    longest stem reaches."""
    source = manifest.get("source") or {}
    decoded = source.get("decoded_samples")
    if decoded:
        return int(decoded) / int(source.get("decoded_sample_rate") or SAMPLE_RATE)
    longest = 0.0
    for stem in manifest.get("stems", []):
        try:
            reach = int(stem.get("offset") or 0) / SAMPLE_RATE
            longest = max(longest, reach + int(stem["samples"]) / int(stem["sample_rate"]))
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            continue
    return longest


def _clip_format(fmt: object) -> str:
    """The stems' own format when it is 24-bit WAV, float WAV for everything else."""
    return "wav24" if fmt == "wav24" else "wav32f"


def _stem_window(
    directory: Path, stem: Mapping[str, Any], rate: int, first: int, frames: int
) -> np.ndarray:
    """``frames`` frames of a stem from frame ``first`` of the song, silent where the stem
    has no audio. A stem whose leading silence was trimmed starts later than the song: its
    offset is counted at the engine's rate, and the file may be at the source's."""
    offset = round(int(stem.get("offset") or 0) * rate / SAMPLE_RATE)
    try:
        return read_window(directory / stem["file"], first - offset, frames)
    except (OSError, RuntimeError) as exc:
        raise DomainError(f"cannot read {stem['file']}: {exc}") from exc


def _summed(windows: list[np.ndarray]) -> np.ndarray:
    """Stems played together, summed the way `render_mix` sums them."""
    if len(windows) == 1:
        return windows[0]
    channels = max(window.shape[0] for window in windows)
    total = np.zeros((channels, windows[0].shape[1]), dtype=np.float32)
    for window in windows:
        if window.shape[0] < channels:
            window = np.repeat(window, channels, axis=0)[:channels]
        total += window
    return total


def _identity(**what: Any) -> str:
    """What a clip holds, short enough for its tags: the files it was cut from, where and
    how long, its format and its tempo mark."""
    blob = json.dumps(what, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return f"OpenStems clip {hashlib.sha256(blob.encode('utf-8')).hexdigest()[:16]}"


def _clip_name(template: str, label: str, selection: str, tokens: Mapping[str, str]) -> str:
    """The naming template filled in with "<label> - <selection>" as the stem, or the
    selection alone for a clip of the song's own file.

    The selection goes in after the template is tidied, so it stays whole: tidying would
    take the "--" of "bars -3--2" for empty tokens, and a name that is too long is cut at
    its end, where the selection is. The track's name is shortened instead.
    """
    stem = f"{label} - {_MARK}" if label else _MARK
    track = tokens.get("track", "")
    while True:
        filled = render_name(template, stem=stem, **{**tokens, "track": track})
        if _MARK not in filled:
            filled = f"{filled} - {_MARK}"
        name = filled.replace(_MARK, selection)
        excess = len(name) - MAX_COMPONENT
        if excess <= 0 or not track:
            return safe_component(name)
        track = track[: max(0, len(track) - excess)].rstrip()


def _put(
    folder: Path,
    name: str,
    audio: np.ndarray,
    rate: int,
    fmt: str,
    bpm: float | None,
    identity: str,
    sources: list[Path],
) -> Path:
    """Write a clip as ``<name>.wav`` in ``folder``, or find it there from before.

    A clip given to a DAW may be in use there, open or in a project, so a clip that is
    newer than the files it was cut from is never written over. When its tags say it holds
    this very selection it is taken as it is. When it holds something else, it is someone
    else's (the same bars on a corrected grid are another stretch of the song, and a clip
    the user edited and saved has no tags) and the clip takes "<name> (2).wav", "(3)" and
    so on instead. Only a file older than the files it was cut from (the song was separated
    again) is replaced: the clip is written under a temporary name and moved into place, so
    no reader sees half a file. When the move fails because a program holds the old file
    open (Windows), the next name is tried and the file in use is left as it is.
    """
    try:
        folder.mkdir(parents=True, exist_ok=True)
        newest = max(path.stat().st_mtime_ns for path in sources)
    except OSError as exc:
        raise DomainError(f"cannot write the clip: {exc}") from exc
    tmp: Path | None = None
    try:
        for copy in range(1, MAX_COPIES + 1):
            target = folder / (f"{name} ({copy}).wav" if copy > 1 else f"{name}.wav")
            held = _held(target, identity, newest)
            if held == "this clip":
                return target
            if held == "another file":
                continue
            if tmp is None:
                tmp = folder / f".{uuid.uuid4().hex[:8]}.wav"
                write_audio(tmp, audio, rate, fmt, bpm, comment=identity)
            try:
                os.replace(tmp, target)
            except PermissionError:
                continue  # held open by another program: it keeps its file
            tmp = None
            return target
    except (OSError, RuntimeError) as exc:
        raise DomainError(f"cannot write the clip: {exc}") from exc
    finally:
        if tmp is not None:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
    raise DomainError("cannot write the clip: every name it could take is in use")


def _held(
    path: Path, identity: str, newest: int
) -> Literal["nothing", "this clip", "an old file", "another file"]:
    """What a clip's file name holds: "nothing"; "this clip", written after the files it
    was cut from; "an old file", written before them, which may be replaced; or "another
    file", newer than them but not this clip, or a file that cannot be read, which is left
    alone."""
    try:
        found = path.stat()
    except FileNotFoundError:
        return "nothing"
    except OSError:
        return "another file"
    if not stat.S_ISREG(found.st_mode):
        return "another file"
    if found.st_mtime_ns <= newest:
        return "an old file"
    try:
        return "this clip" if read_comment(path) == identity else "another file"
    except (OSError, RuntimeError):
        return "another file"
