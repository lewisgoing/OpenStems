"""Fetch the stem-to-MIDI benchmark sets (Phase 7, stage M0) into one folder.

All three are CC BY 4.0 (docs/research/stem-to-midi.md, section 4):

- Slakh2100 test songs: stems, mix and MIDI. The archive is a single 104 GB .tar.gz whose
  splits are interleaved, so it is streamed and reading stops once enough test songs are in;
  nothing else is written to disk.
- GuitarSet: mono microphone audio and the annotations (pitch contours and notes), 0.7 GB.
- vocadito: 40 solo vocal excerpts with f0 and note annotations, 58 MB.

Downloads are checked against Zenodo's md5 and extracted with path checks. Standard library
only:

    python -I scripts/midi_bench_data.py [--out D:\\lew-stems\\bench] [--slakh 25] [--skip-slakh]
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import shutil
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

SLAKH_URL = "https://zenodo.org/records/4599666/files/slakh2100_flac_redux.tar.gz"
ZENODO_API = "https://zenodo.org/api/records/{}"
SMALL = {
    "guitarset": ("3371780", ["annotation.zip", "audio_mono-mic.zip"]),
    "vocadito": ("5578807", ["vocadito.zip"]),
}
SLAKH_TEST = re.compile(r"^slakh2100_flac_redux/test/(Track\d{5})/([\w./-]+)$")
USER_AGENT = "midi-bench-fetch/1"


def _open(url: str):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=60
    )


class ResumingReader:
    """A read-only stream over a URL that reconnects with an HTTP Range request from the byte
    it reached when the connection drops, so a long stream survives network blips."""

    def __init__(self, url: str, attempts: int = 50) -> None:
        self.url, self.attempts, self.pos = url, attempts, 0
        self.response = _open(url)

    def read(self, size: int = -1) -> bytes:
        for attempt in range(self.attempts):
            try:
                data = self.response.read(size)
                if data or size == 0:
                    self.pos += len(data)
                    return data
                return b""
            except (OSError, http.client.HTTPException) as error:
                print(f"slakh: connection lost at {self.pos / 1e9:.2f} GB ({error}); retrying")
                time.sleep(min(60, 5 * (attempt + 1)))
                try:
                    request = urllib.request.Request(
                        self.url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={self.pos}-"}
                    )
                    self.response = urllib.request.urlopen(request, timeout=60)
                except (OSError, http.client.HTTPException):
                    continue
        raise OSError("slakh: gave up after repeated connection losses")

    def close(self) -> None:
        self.response.close()


def _safe_target(root: Path, name: str) -> Path:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe path in archive: {name!r}")
    target = (root / Path(*path.parts)).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError(f"unsafe path in archive: {name!r}")
    return target


def fetch_small(out: Path, name: str, record: str, files: list[str]) -> None:
    folder = out / name
    done = folder / ".done"
    if done.exists():
        print(f"{name}: already here")
        return
    folder.mkdir(parents=True, exist_ok=True)
    meta = json.load(_open(ZENODO_API.format(record)))
    entries = {f["key"]: f for f in meta["files"]}
    for key in files:
        entry = entries[key]
        algo, expected = entry["checksum"].split(":", 1)
        archive = folder / key
        print(f"{name}: downloading {key} ({entry['size'] / 1e6:.0f} MB)")
        digest = hashlib.new(algo)
        with _open(entry["links"]["self"]) as response, archive.open("wb") as fh:
            while chunk := response.read(1 << 20):
                digest.update(chunk)
                fh.write(chunk)
        if digest.hexdigest() != expected:
            archive.unlink()
            raise SystemExit(f"{name}: {key} failed its {algo} check")
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = _safe_target(folder, info.filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        archive.unlink()
    done.write_text(time.strftime("%Y-%m-%d %H:%M:%S"))
    print(f"{name}: done")


def _slakh_stems(metadata: str) -> dict[str, bool]:
    """Stem ids in a Slakh metadata.yaml and whether each was rendered to audio. A small
    line parser, so the fetch needs no YAML library."""
    stems: dict[str, bool] = {}
    current = None
    for line in metadata.splitlines():
        head = re.match(r"^  (S\d\d):\s*$", line)
        if head:
            current = head.group(1)
            stems[current] = False
            continue
        rendered = re.match(r"^    audio_rendered:\s*(\w+)", line)
        if current and rendered:
            stems[current] = rendered.group(1).lower() == "true"
    return stems


def slakh_complete(song: Path) -> bool:
    """The mix, the metadata, and every stem's MIDI and (when rendered) audio are present."""
    meta = song / "metadata.yaml"
    if not (meta.is_file() and (song / "mix.flac").is_file()):
        return False
    stems = _slakh_stems(meta.read_text("utf-8", errors="replace"))
    return bool(stems) and all(
        (song / "MIDI" / f"{sid}.mid").is_file()
        and (not rendered or (song / "stems" / f"{sid}.flac").is_file())
        for sid, rendered in stems.items()
    )


def fetch_slakh(out: Path, wanted: int, max_gb: float | None = None) -> None:
    """The archive stores files in no particular order: a song's files are spread through it,
    so completing even a few songs takes most of the 104 GB. ``wanted`` > 0 keeps the first
    that many test songs met and stops once they are complete; 0 keeps every test song (the
    same download, about 7 to 8 GB on disk)."""
    folder = out / "slakh"
    folder.mkdir(parents=True, exist_ok=True)
    limit = wanted if wanted > 0 else None
    chosen = sorted(p.name for p in folder.iterdir() if p.is_dir())[:limit]
    done = {name for name in chosen if slakh_complete(folder / name)}
    if limit is not None and len(done) >= limit:
        print(f"slakh: {len(done)} complete test songs already here")
        return
    goal = f"{limit} test songs" if limit else "every test song"
    print(f"slakh: streaming until {goal} is complete ({len(done)} so far)")
    started = time.time()
    seen_bytes = 0
    next_report = 5e9
    response = ResumingReader(SLAKH_URL)
    with tarfile.open(fileobj=response, mode="r|gz") as tar:
        for member in tar:
            seen_bytes += member.size
            if seen_bytes >= next_report:
                minutes = (time.time() - started) / 60
                gb = seen_bytes / 1e9
                print(f"slakh: {gb:.0f} GB read, {len(done)} complete, {minutes:.0f} min")
                next_report += 5e9
            if max_gb is not None and seen_bytes > max_gb * 1e9:
                print(f"slakh: stopped at the --max-gb limit ({max_gb:g} GB)")
                break
            match = SLAKH_TEST.match(member.name)
            if not match or not member.isfile():
                continue
            track = match.group(1)
            if track not in chosen:
                if limit is not None and len(chosen) >= limit:
                    continue
                chosen.append(track)
            if track in done:
                continue
            target = _safe_target(folder, f"{track}/{match.group(2)}")
            if target.is_file() and target.stat().st_size == member.size:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                continue
            with target.open("wb") as dst:
                shutil.copyfileobj(source, dst)
            if slakh_complete(folder / track):
                done.add(track)
                minutes = (time.time() - started) / 60
                print(
                    f"slakh: {track} complete ({len(done)}), "
                    f"{seen_bytes / 1e9:.1f} GB read, {minutes:.0f} min"
                )
                if limit is not None and len(done) >= limit:
                    break
    minutes = (time.time() - started) / 60
    incomplete = sorted(set(chosen) - done)
    print(f"slakh: {len(done)} test songs complete after {minutes:.0f} min")
    if incomplete:
        print(f"slakh: incomplete: {', '.join(incomplete)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path(r"D:\lew-stems\bench"))
    parser.add_argument(
        "--slakh", type=int, default=0, help="number of Slakh test songs (0: all of them)"
    )
    parser.add_argument("--skip-slakh", action="store_true")
    parser.add_argument("--max-gb", type=float, help="stop reading the Slakh archive after this")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, (record, files) in SMALL.items():
        fetch_small(args.out, name, record, files)
    if not args.skip_slakh:
        fetch_slakh(args.out, args.slakh, args.max_gb)


if __name__ == "__main__":
    main()
