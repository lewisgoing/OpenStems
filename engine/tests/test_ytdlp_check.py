"""The check that the pinned yt-dlp is the newest one (`scripts/check_ytdlp.py`). The answer
from PyPI is a stand-in: no test touches the network."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def check() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "check_ytdlp", ROOT / "scripts" / "check_ytdlp.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_engine_pins_yt_dlp_where_the_check_looks(check: ModuleType) -> None:
    version = check.pinned_version(check.PYPROJECT.read_text(encoding="utf-8"))
    assert len(check.as_numbers(version)) >= 3


def test_versions_compare_as_numbers(check: ModuleType) -> None:
    assert check.is_newer("2026.11.2", "2026.10.26")
    assert check.is_newer("2026.10.26.1", "2026.10.26")
    assert not check.is_newer("2026.10.26", "2026.10.26")
    assert not check.is_newer("2026.9.30", "2026.10.26")


def test_the_pin_moves_and_the_extras_stay(check: ModuleType) -> None:
    text = 'dependencies = [\n    "soxr==1.0.0",\n    "yt-dlp[default,deno]==2026.10.26",\n]\n'
    moved = check.with_pin(text, "2026.11.2")
    assert '"yt-dlp[default,deno]==2026.11.2"' in moved
    assert '"soxr==1.0.0"' in moved
    assert check.pinned_version(moved) == "2026.11.2"


def run(
    check: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    latest: str,
    *args: str,
) -> tuple[Path, dict[str, str]]:
    pyproject = tmp_path / "pyproject.toml"
    if not pyproject.exists():
        pyproject.write_text('deps = ["yt-dlp[default,deno]==2026.10.26"]\n', encoding="utf-8")
    output = tmp_path / "output"
    output.unlink(missing_ok=True)
    monkeypatch.setattr(check, "PYPROJECT", pyproject)
    monkeypatch.setattr(check, "newest_release", lambda: (latest, "2026-11-02"))
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(sys, "argv", ["check_ytdlp.py", *args])
    assert check.main() == 0
    lines = output.read_text(encoding="utf-8").splitlines()
    return pyproject, dict(line.split("=", 1) for line in lines)


def test_a_newer_release_is_reported_and_written_only_on_request(
    check: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    body = tmp_path / "issue.md"
    pyproject, said = run(check, monkeypatch, tmp_path, "2026.11.2", "--issue-body", str(body))
    assert said == {"pinned": "2026.10.26", "latest": "2026.11.2", "outdated": "true"}
    assert "2026.10.26" in pyproject.read_text(encoding="utf-8")
    text = body.read_text(encoding="utf-8")
    assert "**2026.11.2** came out on 2026-11-02" in text and "**2026.10.26**" in text

    pyproject, _ = run(check, monkeypatch, tmp_path, "2026.11.2", "--write")
    assert "yt-dlp[default,deno]==2026.11.2" in pyproject.read_text(encoding="utf-8")


def test_a_current_pin_is_left_alone(
    check: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pyproject, said = run(check, monkeypatch, tmp_path, "2026.10.26", "--write")
    assert said["outdated"] == "false"
    assert "2026.10.26" in pyproject.read_text(encoding="utf-8")
