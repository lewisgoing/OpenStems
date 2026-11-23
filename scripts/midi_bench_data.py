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
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}))


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


def fetch_slakh(out: Path, wanted: int) -> None:
    folder = out / "slakh"
    folder.mkdir(parents=True, exist_ok=True)
    have = {p.name for p in folder.iterdir() if (p / ".done").exists()}
    if len(have) >= wanted:
        print(f"slakh: {len(have)} test songs already here")
        return
    print(f"slakh: streaming the archive until {wanted} test songs are in ({len(have)} so far)")
    current: str | None = None
    started = time.time()
    with _open(SLAKH_URL) as response, tarfile.open(fileobj=response, mode="r|gz") as tar:
        for member in tar:
            match = SLAKH_TEST.match(member.name)
            track = match.group(1) if match else None
            if current and track != current:
                (folder / current / ".done").write_text("ok")
                have.add(current)
                print(f"slakh: {current} ({len(have)}/{wanted})")
                current = None
                if len(have) >= wanted:
                    break
            if not match or not member.isfile() or track in have:
                continue
            current = track
            target = _safe_target(folder, f"{track}/{match.group(2)}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                continue
            with target.open("wb") as dst:
                shutil.copyfileobj(source, dst)
    if current and current not in have:
        (folder / current / ".done").write_text("ok")
        have.add(current)
    minutes = (time.time() - started) / 60
    print(f"slakh: {len(have)} test songs in {minutes:.0f} min")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path(r"D:\lew-stems\bench"))
    parser.add_argument("--slakh", type=int, default=25, help="number of Slakh test songs")
    parser.add_argument("--skip-slakh", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, (record, files) in SMALL.items():
        fetch_small(args.out, name, record, files)
    if not args.skip_slakh:
        fetch_slakh(args.out, args.slakh)


if __name__ == "__main__":
    main()
