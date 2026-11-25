"""Empty stems: which stems of a song hold nothing but what the model let through, the peak
a run measures for it, the stems written before that, and the setting the app hides by."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from openstems.api.db import Index
from openstems.audio.write import write_audio
from openstems.domain.levels import EMPTY_BELOW_DB, empty_stems
from openstems.domain.stem import MANIFEST_NAME
from openstems.pipeline.levels import mark_empty, measure_peak, stored_peak
from openstems.pipeline.run import RunOptions, read_manifest
from openstems.settings import Settings
from tests.conftest import RATE, tone
from tests.test_api import all_terminal, client, fake_env, service_of, wait_for
from tests.test_producer_features import full_song

__all__ = ["client", "fake_env"]  # fixtures, used by name


def db(level: float) -> float:
    return 10 ** (level / 20)


# -- the rule ---------------------------------------------------------------------------


def test_a_stem_far_under_the_loudest_is_empty() -> None:
    # Figures of a real six-stem separation of a rap song: guitar and piano are hiss.
    peaks = {
        "vocals": db(0.4),
        "drums": db(-0.5),
        "bass": db(-1.9),
        "guitar": db(-74.0),
        "piano": db(-70.5),
        "other": db(-10.7),
    }
    assert empty_stems(peaks) == {"guitar", "piano"}


def test_the_line_is_drawn_from_the_loudest_stem() -> None:
    assert EMPTY_BELOW_DB == 45.0
    just_in, just_out = db(-44.9), db(-45.1)
    assert empty_stems({"a": 1.0, "b": just_in, "c": just_out}) == {"c"}
    # A quiet recording keeps its quiet parts: 27 dB under a loudest stem at -15 dB.
    assert empty_stems({"other": db(-15.5), "kick": db(-42.5)}) == set()
    # The same stem beside a loud one is empty.
    assert empty_stems({"other": db(0.0), "kick": db(-46.0)}) == {"kick"}


def test_silence_and_stems_nobody_measured() -> None:
    assert empty_stems({"a": 0.5, "b": 0.0}) == {"b"}
    assert empty_stems({"a": 0.0, "b": 0.0}) == {"a", "b"}  # nothing in the song at all
    assert empty_stems({"a": 0.5, "b": None}) == set()  # not known is never called empty
    assert empty_stems({"a": None, "b": db(-80)}) == set()  # the loudest that is known
    assert empty_stems({"only": 0.3}) == set()
    assert empty_stems({}) == set()


def test_the_peak_is_the_largest_sample_of_any_channel() -> None:
    audio = np.zeros((2, 100), dtype=np.float32)
    audio[1, 40] = -0.25  # one channel only, and negative
    assert measure_peak(audio) == 0.25
    # Opposite channels cancel in the mono sum the waveform is drawn from, not here.
    audio[0, 40] = 0.25
    assert measure_peak(audio) == 0.25
    assert measure_peak(np.zeros((2, 0), dtype=np.float32)) == 0.0


def test_a_stem_without_a_peak_is_read_from_its_peaks_file(tmp_path: Path) -> None:
    loud, hiss, first = tmp_path / "loud.json", tmp_path / "hiss.json", tmp_path / "first.json"
    loud.write_text(json.dumps({"peak": 0.8, "data": [-0.8, 0.7]}), "utf-8")
    hiss.write_text(json.dumps({"peak": 0.0002, "data": [-0.0002, 0.0001]}), "utf-8")
    first.write_text(json.dumps({"data": [-0.0003, 0.0001]}), "utf-8")  # before `peak`
    assert stored_peak(loud) == 0.8
    assert stored_peak(first) == 0.0003
    assert stored_peak(tmp_path / "gone.json") is None
    assert stored_peak(None) is None
    (tmp_path / "torn.json").write_text("{", "utf-8")
    assert stored_peak(tmp_path / "torn.json") is None

    stems: list[dict[str, Any]] = [
        {"name": "vocals", "peaks": str(loud)},
        {"name": "guitar", "peaks": str(hiss)},
        {"name": "piano", "peaks": str(first)},
        {"name": "bass", "peaks": str(tmp_path / "gone.json")},
        # A measured peak wins over the file: this one was made loud by normalize.
        {"name": "other", "peaks": str(loud), "peak": 0.0001},
    ]
    marked = {stem["name"]: stem["empty"] for stem in mark_empty(stems)}
    assert marked == {
        "vocals": False,
        "guitar": True,
        "piano": True,
        "bass": False,
        "other": True,
    }


# -- a run ------------------------------------------------------------------------------


@pytest.fixture
def song(tmp_path: Path) -> Path:
    path = tmp_path / "in" / "Satellite Rain.wav"
    path.parent.mkdir()
    write_audio(path, tone(2.0), RATE)
    return path


def test_a_run_keeps_each_stems_peak_in_the_manifest(
    pipeline, song: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_FAKE_EMPTY", "guitar, piano")
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    peaks = {stem.name: stem.peak for stem in result.stems}
    assert all(peak is not None and peak > 0 for peak in peaks.values())
    assert empty_stems(peaks) == {"guitar", "piano"}
    manifest = read_manifest(Path(result.directory))
    assert manifest is not None
    assert {raw["name"]: raw["peak"] for raw in manifest["stems"]} == peaks
    # The files are all there: empty is about what is shown, never about what is written.
    assert all((Path(result.directory) / stem.file).is_file() for stem in result.stems)


def test_normalize_does_not_fill_an_empty_stem(
    pipeline, song: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_FAKE_EMPTY", "piano")
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(normalize=True))
    peaks = {stem.name: stem.peak for stem in result.stems}
    # Its file is as loud as the rest now, but what was measured is the separation.
    drawn = stored_peak(
        Path(result.directory) / next(s.peaks or "" for s in result.stems if s.name == "piano")
    )
    assert drawn is not None and drawn > 0.5
    assert empty_stems(peaks) == {"piano"}


# -- the API ----------------------------------------------------------------------------


@pytest.fixture
def two_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Before the client, whose worker reads it when it starts."""
    monkeypatch.setenv("OPENSTEMS_FAKE_EMPTY", "guitar,piano")


def separated(client: TestClient, song: Path) -> dict[str, Any]:
    answer = client.post("/v1/jobs", json={"path": str(song), "recipe": "full-song"})
    assert answer.status_code == 200, answer.text
    job = wait_for(client, all_terminal)[-1]
    assert job["state"] == "done", job["error"]
    return job


def empties(stems: list[dict[str, Any]]) -> set[str]:
    return {stem["name"] for stem in stems if stem["empty"]}


def test_a_job_and_its_stem_set_say_which_stems_are_empty(
    two_empty: None, client: TestClient, song: Path
) -> None:
    job = separated(client, song)
    assert len(job["stems"]) == 6 and empties(job["stems"]) == {"guitar", "piano"}
    sets = client.get("/v1/stemsets").json()["stem_sets"]
    assert empties(sets[0]["stems"]) == {"guitar", "piano"}
    # A tempo typed in rewrites the stems' list; the verdict stays.
    changed = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 120})
    assert changed.status_code == 200, changed.text
    assert empties(changed.json()["stems"]) == {"guitar", "piano"}


def test_no_stem_of_an_ordinary_song_is_empty(client: TestClient, song: Path) -> None:
    assert empties(separated(client, song)["stems"]) == set()


def test_stems_from_before_peaks_were_measured(
    two_empty: None, client: TestClient, song: Path
) -> None:
    """An older version's output: a manifest without peaks, an index row and a saved job
    without verdicts. Both are filled in from the peaks files when the engine starts."""
    job = separated(client, song)
    service = service_of(client)
    folder = Path(job["output_dir"])
    manifest = json.loads((folder / MANIFEST_NAME).read_text("utf-8"))
    for raw in manifest["stems"]:
        del raw["peak"]
    (folder / MANIFEST_NAME).write_text(json.dumps(manifest), "utf-8")

    index: Index = service.index
    with sqlite3.connect(index.path) as raw_db:
        (stems,) = raw_db.execute("SELECT stems FROM stem_sets").fetchone()
        old = [
            {k: v for k, v in s.items() if k not in ("peak", "empty")} for s in json.loads(stems)
        ]
        raw_db.execute("UPDATE stem_sets SET stems = ?", (json.dumps(old),))
    listed = index.stem_sets()[0]["stems"]
    assert empties(listed) == set()  # an old row reads as nothing empty until it is marked

    assert index.mark_empty_stems() == 1
    assert empties(index.stem_sets()[0]["stems"]) == {"guitar", "piano"}
    assert index.mark_empty_stems() == 0  # once

    from openstems.api.jobs import _with_empty

    saved = [{k: v for k, v in s.items() if k not in ("peak", "empty")} for s in job["stems"]]
    assert empties(_with_empty(saved)) == {"guitar", "piano"}
    assert "empty" not in saved[0]  # the saved list itself is left as it was
    assert _with_empty(job["stems"]) is job["stems"]


# -- the setting ------------------------------------------------------------------------


def test_hiding_is_on_by_default_and_can_be_turned_off(client: TestClient) -> None:
    assert Settings().hide_empty_stems is True
    assert client.get("/v1/settings").json()["hide_empty_stems"] is True
    off = client.patch("/v1/settings", json={"hide_empty_stems": False})
    assert off.status_code == 200 and off.json()["hide_empty_stems"] is False
    assert client.get("/v1/settings").json()["hide_empty_stems"] is False
    # Another setting leaves it alone, and it takes a yes or a no.
    assert (
        client.patch("/v1/settings", json={"sum_to_mix": True}).json()["hide_empty_stems"] is False
    )
    assert client.patch("/v1/settings", json={"hide_empty_stems": "maybe"}).status_code == 422
