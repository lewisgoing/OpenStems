"""Is the pinned yt-dlp the newest one?

Links are fetched with yt-dlp, pinned in ``engine/pyproject.toml``. Sites change, and a fetch
that stops working is nearly always fixed by a newer yt-dlp, so a new release of it is the
moment to update the pin and ship a version of OpenStems.

    python scripts/check_ytdlp.py            # say where things stand
    python scripts/check_ytdlp.py --write    # also move the pin; then run `uv lock` in engine/

The scheduled workflow ``.github/workflows/links-check.yml`` runs this every day and keeps one
issue open while the pin is behind. Standard library only, so it runs without the engine's
environment.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "engine" / "pyproject.toml"
PYPI = "https://pypi.org/pypi/yt-dlp/json"
PIN = re.compile(r'("yt-dlp(?:\[[^\]]*\])?==)([0-9][0-9.]*)(")')


def pinned_version(text: str) -> str:
    found = PIN.search(text)
    if found is None:
        raise SystemExit("engine/pyproject.toml does not pin yt-dlp")
    return found.group(2)


def with_pin(text: str, version: str) -> str:
    return PIN.sub(lambda m: f"{m.group(1)}{version}{m.group(3)}", text, count=1)


def as_numbers(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split(".") if part.isdigit())


def is_newer(latest: str, pinned: str) -> bool:
    return as_numbers(latest) > as_numbers(pinned)


def newest_release() -> tuple[str, str]:
    """The newest stable yt-dlp on PyPI and the day it came out."""
    request = urllib.request.Request(PYPI, headers={"User-Agent": "openstems-links-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    version = str(data["info"]["version"])
    files = data.get("releases", {}).get(version) or data.get("urls") or []
    day = str(files[0].get("upload_time_iso_8601", ""))[:10] if files else ""
    return version, day


def issue_body(pinned: str, latest: str, day: str) -> str:
    out = f" on {day}" if day else ""
    return f"""yt-dlp **{latest}** came out{out}. OpenStems pins **{pinned}**.

Pasted links are fetched with yt-dlp. A new release of it usually means a site changed and
fetching from it broke, so links in the released app may be failing now.

To update:

1. `python scripts/check_ytdlp.py --write`, then `uv lock` in `engine/`.
2. Run the engine tests, and paste a real link in the app (`pnpm dev`) to see it fetch.
3. Release a new version. Installed apps add the new yt-dlp on their first start after the
   update.

What changed in yt-dlp: https://github.com/yt-dlp/yt-dlp/releases/tag/{latest}

This issue is kept by the `links-check` workflow, which closes it once the pin is current.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="move the pin to the newest release")
    parser.add_argument("--issue-body", type=Path, help="write the text of the issue to this file")
    args = parser.parse_args()

    text = PYPROJECT.read_text(encoding="utf-8")
    pinned = pinned_version(text)
    latest, day = newest_release()
    outdated = is_newer(latest, pinned)

    if outdated:
        print(f"yt-dlp {latest} is out ({day or 'date unknown'}); the pin is {pinned}")
    else:
        print(f"yt-dlp {pinned} is the newest release")

    if args.write and outdated:
        PYPROJECT.write_text(with_pin(text, latest), encoding="utf-8", newline="\n")
        print(f"pinned yt-dlp {latest}; now run `uv lock` in engine/")
    if args.issue_body is not None:
        args.issue_body.write_text(issue_body(pinned, latest, day), encoding="utf-8")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as out:
            out.write(f"pinned={pinned}\nlatest={latest}\noutdated={str(outdated).lower()}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
