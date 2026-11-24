"""Fetch the stem-to-MIDI benchmark sets (Phase 7, stage M0) into one folder.

All three are CC BY 4.0 (docs/research/stem-to-midi.md, section 4):

- Slakh2100 test songs: stems, mix and MIDI. The archive is a single 104 GB .tar.gz with its
  files in no order, so it is downloaded whole (resuming after a dropped connection or a
  restart; needs 104 GB free), checked against its md5, the test songs extracted, and the
  archive deleted unless --keep-archive.
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
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

SLAKH_RECORD = "4599666"
SLAKH_URL = f"https://zenodo.org/records/{SLAKH_RECORD}/files/slakh2100_flac_redux.tar.gz"
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


def download_resuming(url: str, target: Path, attempts: int = 200) -> None:
    """Download ``url`` to ``target``, picking up from the bytes already on disk with an HTTP
    Range request after a dropped connection or a stopped process. A connection that ends
    early without an error counts as dropped: the total comes from Content-Range or
    Content-Length."""
    total = None
    step = 5_000_000_000
    for attempt in range(attempts):
        have = target.stat().st_size if target.exists() else 0
        if total is not None and have >= total:
            return
        headers = {"User-Agent": USER_AGENT}
        if have:
            headers["Range"] = f"bytes={have}-"
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                if have and response.status != 206:
                    raise OSError("the server ignored the Range request")
                span = response.headers.get("Content-Range")
                if span and "/" in span:
                    total = int(span.rsplit("/", 1)[1])
                elif response.headers.get("Content-Length"):
                    total = have + int(response.headers["Content-Length"])
                with target.open("ab") as fh:
                    while chunk := response.read(1 << 20):
                        fh.write(chunk)
                        if (have + len(chunk)) // step != have // step:
                            got, size = (have + len(chunk)) / 1e9, (total or 0) / 1e9
                            print(f"slakh: {got:.0f} of {size:.0f} GB")
                        have += len(chunk)
            if total is not None and have >= total:
                return
            print(f"slakh: connection ended early at {have / 1e9:.2f} GB; resuming")
        except urllib.error.HTTPError as error:
            if error.code == 416 and have:
                return  # nothing left past what is on disk; the checksum decides
            print(f"slakh: connection lost at {have / 1e9:.2f} GB ({error}); resuming")
        except (OSError, http.client.HTTPException) as error:
            print(f"slakh: connection lost at {have / 1e9:.2f} GB ({error}); resuming")
        time.sleep(min(60, 5 * (attempt % 12 + 1)))
    raise OSError("slakh: gave up after repeated connection losses")


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
    """The mix, the metadata, and the MIDI and audio of every rendered stem are present. The
    archive has neither for a stem that was not rendered."""
    meta = song / "metadata.yaml"
    if not (meta.is_file() and (song / "mix.flac").is_file()):
        return False
    stems = _slakh_stems(meta.read_text("utf-8", errors="replace"))
    return bool(stems) and all(
        not rendered
        or ((song / "MIDI" / f"{sid}.mid").is_file() and (song / "stems" / f"{sid}.flac").is_file())
        for sid, rendered in stems.items()
    )


def fetch_slakh(
    out: Path, wanted: int, max_gb: float | None = None, keep_archive: bool = False
) -> None:
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
    archive = out / "slakh2100_flac_redux.tar.gz"
    checked = archive.with_suffix(".checked")
    if not checked.exists():
        meta = json.load(_open(ZENODO_API.format(SLAKH_RECORD)))
        entry = next(f for f in meta["files"] if f["key"] == archive.name)
        algo, expected = entry["checksum"].split(":", 1)
        print(f"slakh: downloading the archive to {archive} ({entry['size'] / 1e9:.0f} GB)")
        download_resuming(SLAKH_URL, archive)
        print(f"slakh: checking the {algo}")
        digest = hashlib.new(algo)
        with archive.open("rb") as fh:
            while chunk := fh.read(1 << 24):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            archive.unlink()
            raise SystemExit(f"slakh: the archive failed its {algo} check; run again")
        checked.write_text(expected)
    started = time.time()
    seen_bytes = 0
    next_report = 5e9
    with tarfile.open(archive, mode="r|gz") as tar:
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
    elif not keep_archive:
        archive.unlink()
        checked.unlink()
        print("slakh: deleted the archive")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path(r"D:\lew-stems\bench"))
    parser.add_argument(
        "--slakh", type=int, default=0, help="number of Slakh test songs (0: all of them)"
    )
    parser.add_argument("--skip-slakh", action="store_true")
    parser.add_argument("--max-gb", type=float, help="stop reading the Slakh archive after this")
    parser.add_argument(
        "--keep-archive", action="store_true", help="keep the 104 GB Slakh archive afterwards"
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, (record, files) in SMALL.items():
        fetch_small(args.out, name, record, files)
    if not args.skip_slakh:
        fetch_slakh(args.out, args.slakh, args.max_gb, args.keep_archive)


if __name__ == "__main__":
    main()
