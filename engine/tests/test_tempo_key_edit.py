"""The user's own tempo and key: before a song is separated, and on stems already written."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from openstems.audio import analysis
from openstems.audio.write import read_audio, set_tempo, write_audio
from openstems.domain.errors import DomainError
from openstems.pipeline.mix import render_mix
from openstems.pipeline.retag import clean_bpm, clean_key, set_analysis
from openstems.pipeline.run import RunOptions, read_manifest
from tests.conftest import RATE, tone
from tests.test_api import all_terminal, client, fake_env, songs, wait_for
from tests.test_producer_features import acid_tempo, click_track, full_song

__all__ = ["client", "fake_env", "songs"]  # fixtures, used by name


# -- what the user may type -----------------------------------------------------------


def test_a_tempo_is_a_number_in_a_sensible_range() -> None:
    assert clean_bpm(None) is None
    assert clean_bpm(140) == 140.0
    assert clean_bpm("87.5") == 87.5
    assert clean_bpm(139.989) == 139.99
    assert clean_bpm(120.001) == 120.0
    for bad in (0, 19, 1000, "fast", float("nan")):
        with pytest.raises(DomainError):
            clean_bpm(bad)


def test_a_key_is_written_the_way_detection_writes_it() -> None:
    assert clean_key("Am") == "Am"
    assert clean_key(" f# ") == "F#"
    assert clean_key("c#m") == "C#m"
    # A flat is the sharp that sounds the same: detection only ever writes sharps.
    assert clean_key("Bb") == "A#"
    assert clean_key("ebm") == "D#m"
    assert clean_key("") is None
    assert clean_key(None) is None
    for bad in ("H", "A minor", "Amaj", "12"):
        with pytest.raises(DomainError):
            clean_key(bad)


# -- the tempo mark of a WAV ----------------------------------------------------------


def test_the_tempo_mark_of_a_wav_can_be_changed_added_and_taken_away(tmp_path: Path) -> None:
    marked, plain = tmp_path / "marked.wav", tmp_path / "plain.wav"
    audio = tone(0.5)
    write_audio(marked, audio, RATE, bpm=105.0)
    write_audio(plain, audio, RATE)
    size = marked.stat().st_size

    set_tempo(marked, 210.0)
    assert acid_tempo(marked) == 210.0
    assert marked.stat().st_size == size  # changed in place
    set_tempo(marked, None)
    assert acid_tempo(marked) == 0.0  # a tempo of 0 is what FL Studio does not sync to
    set_tempo(marked, 98.0)
    assert acid_tempo(marked) == 98.0

    set_tempo(plain, None)
    assert acid_tempo(plain) is None  # nothing to take away
    set_tempo(plain, 128.0)
    assert acid_tempo(plain) == 128.0
    for path in (marked, plain):
        assert np.array_equal(read_audio(path)[0], audio)


# -- before the song is separated -----------------------------------------------------


def test_a_run_uses_the_tempo_and_key_it_is_given(pipeline, tmp_path: Path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    options = RunOptions(
        naming_template="{track} {bpm} {key} - {stem}", tempo_sync=True, bpm=60.0, key="F#m"
    )
    result = pipeline.run(source, full_song(), tmp_path / "out", options)
    found = result.manifest["analysis"]
    assert (found["bpm"], found["key"]) == (60.0, "F#m")
    # What detection found is kept beside the user's figures.
    assert abs(found["detected"]["bpm"] - 120.0) < 3.0
    for stem in result.stems:
        assert stem.file.startswith("Click 60.0 F#m - ")
        assert acid_tempo(Path(result.directory) / stem.file) == 60.0


def test_a_given_tempo_needs_no_detection_setting(pipeline, song, tmp_path, monkeypatch) -> None:
    def boom(*args: object) -> None:
        raise AssertionError("analysis should not run")

    monkeypatch.setattr(analysis, "detect_tempo_key", boom)
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(bpm=174.0))
    assert result.manifest["analysis"]["bpm"] == 174.0
    assert result.manifest["analysis"]["key"] is None


def test_a_cached_result_takes_the_tempo_it_is_asked_for(pipeline, tmp_path: Path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    first = pipeline.run(source, full_song(), tmp_path / "out", RunOptions(tempo_sync=True))
    assert not first.cached
    again = pipeline.run(
        source, full_song(), tmp_path / "out", RunOptions(tempo_sync=True, bpm=240.0)
    )
    assert again.cached  # the tempo is not a reason to separate the song again
    assert again.manifest["analysis"]["bpm"] == 240.0
    for stem in again.stems:
        assert acid_tempo(Path(again.directory) / stem.file) == 240.0
    # Asked for nothing in particular, the result keeps what the user set.
    third = pipeline.run(source, full_song(), tmp_path / "out", RunOptions(tempo_sync=True))
    assert third.cached and third.manifest["analysis"]["bpm"] == 240.0


# -- after: stems that are already written --------------------------------------------


def separated(pipeline, tmp_path: Path, **options: Any):
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    return pipeline.run(source, full_song(), tmp_path / "out", RunOptions(**options))


def test_changing_the_tempo_renames_marks_and_records(pipeline, tmp_path: Path) -> None:
    result = separated(
        pipeline, tmp_path, naming_template="{track} {bpm}bpm {key} - {stem}", tempo_sync=True
    )
    folder = Path(result.directory)
    detected = dict(result.manifest["analysis"])
    audio_before = {s.name: read_audio(folder / s.file)[0] for s in result.stems}
    mix = Path(render_mix(folder, [s.file for s in result.stems[:2]])["path"])

    manifest = set_analysis(folder, {"bpm": 60, "key": "bbm"})
    assert manifest["analysis"]["bpm"] == 60.0
    assert manifest["analysis"]["key"] == "A#m"
    assert manifest["analysis"]["detected"] == {"bpm": detected["bpm"], "key": detected["key"]}
    assert read_manifest(folder) == manifest
    for stem in manifest["stems"]:
        path = folder / stem["file"]
        assert stem["file"] == f"Click 60.0bpm A#m - {stem['name']}.wav"
        assert path.is_file()
        assert acid_tempo(path) == 60.0
        assert np.array_equal(read_audio(path)[0], audio_before[stem["name"]])
        assert (folder / stem["peaks"]).is_file()
    # Nothing is left behind under the old names, and a mix made earlier follows the tempo.
    wavs = sorted(p.name for p in folder.glob("*.wav"))
    assert wavs == sorted(s["file"] for s in manifest["stems"])
    assert acid_tempo(mix) == 60.0

    # A second change keeps what detection found, not the figure in between.
    again = set_analysis(folder, {"bpm": 61})
    assert again["analysis"]["detected"]["bpm"] == detected["bpm"]
    assert again["analysis"]["key"] == "A#m"


def test_changing_only_the_key_leaves_names_and_marks_alone(pipeline, tmp_path: Path) -> None:
    result = separated(pipeline, tmp_path)  # the default template, no tempo sync
    folder = Path(result.directory)
    before = {p.name: p.read_bytes() for p in folder.glob("*.wav")}
    manifest = set_analysis(folder, {"key": "Dm"})
    assert manifest["analysis"]["key"] == "Dm"
    assert {p.name: p.read_bytes() for p in folder.glob("*.wav")} == before
    # The same figures again change nothing, not even the manifest.
    stamp = (folder / "manifest.json").read_bytes()
    set_analysis(folder, {"key": "Dm"})
    assert (folder / "manifest.json").read_bytes() == stamp


def test_a_song_can_be_given_no_tempo(pipeline, tmp_path: Path) -> None:
    result = separated(
        pipeline, tmp_path, naming_template="{track} {bpm} - {stem}", tempo_sync=True
    )
    folder = Path(result.directory)
    manifest = set_analysis(folder, {"bpm": None})
    assert manifest["analysis"]["bpm"] is None
    for stem in manifest["stems"]:
        assert stem["file"] == f"Click - {stem['name']}.wav"
        assert acid_tempo(folder / stem["file"]) == 0.0


def test_a_bad_figure_or_a_name_that_is_taken_changes_nothing(pipeline, tmp_path: Path) -> None:
    result = separated(pipeline, tmp_path, naming_template="{track} {bpm} - {stem}")
    folder = Path(result.directory)
    before = json.loads((folder / "manifest.json").read_text("utf-8"))
    with pytest.raises(DomainError):
        set_analysis(folder, {"bpm": 5})
    first = before["stems"][0]
    (folder / f"Click 99.0 - {first['name']}.wav").write_bytes(b"someone else's file")
    with pytest.raises(DomainError, match="already in the stem folder"):
        set_analysis(folder, {"bpm": 99})
    assert json.loads((folder / "manifest.json").read_text("utf-8")) == before
    assert all((folder / s["file"]).is_file() for s in before["stems"])
    with pytest.raises(DomainError):
        set_analysis(tmp_path, {"bpm": 99})  # not a stem folder


# -- through the API ------------------------------------------------------------------


def test_a_waiting_job_is_given_its_tempo_and_key(client: TestClient, songs: list[Path]) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {}, "start": False}
    job = client.post("/v1/jobs", json=body).json()
    assert job["held"] is True

    answer = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 150, "key": "gm"})
    assert answer.status_code == 200, answer.text
    assert answer.json()["options"]["bpm"] == 150.0
    assert answer.json()["options"]["key"] == "Gm"
    # null takes the user's figure away again: that one is detected.
    cleared = client.post(f"/v1/jobs/{job['id']}/analysis", json={"key": None}).json()
    assert "key" not in cleared["options"] and cleared["options"]["bpm"] == 150.0
    assert client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 3}).status_code == 400

    client.post("/v1/jobs/start")
    done = wait_for(client, all_terminal)[0]
    assert done["state"] == "done"
    assert done["analysis"]["bpm"] == 150.0


def test_a_job_can_be_queued_with_its_tempo(client: TestClient, songs: list[Path]) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {"bpm": 90, "key": "C"}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    done = wait_for(client, all_terminal)[0]
    assert (done["analysis"]["bpm"], done["analysis"]["key"]) == (90.0, "C")


def test_finished_stems_are_retagged_through_the_job_and_the_history(
    client: TestClient, songs: list[Path]
) -> None:
    options = {"naming_template": "{track} {bpm} - {stem}"}
    assert client.patch("/v1/settings", json=options).status_code == 200
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {"bpm": 100}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]
    assert all(" 100.0 - " in s["file"] for s in job["stems"])

    # From the queue: the job itself.
    changed = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 200}).json()
    assert changed["analysis"]["bpm"] == 200.0
    assert all(" 200.0 - " in s["file"] and Path(s["path"]).is_file() for s in changed["stems"])
    assert all(Path(s["peaks"]).is_file() for s in changed["stems"])

    # From the history: the folder. The job in the queue follows.
    answer = client.post(
        "/v1/stemsets/analysis", json={"directory": job["output_dir"], "bpm": 50, "key": "Am"}
    )
    assert answer.status_code == 200, answer.text
    stem_set = answer.json()
    assert stem_set["analysis"]["bpm"] == 50.0 and stem_set["analysis"]["key"] == "Am"
    assert all(Path(s["path"]).is_file() and " 50.0 - " in s["file"] for s in stem_set["stems"])
    listed = client.get("/v1/stemsets").json()["stem_sets"][0]
    assert listed["analysis"]["bpm"] == 50.0
    after = client.get(f"/v1/jobs/{job['id']}").json()
    assert after["analysis"]["key"] == "Am"
    assert [s["file"] for s in after["stems"]] == [s["file"] for s in stem_set["stems"]]
    # The renamed files are served, so the app can still play and drag them.
    served = client.get("/v1/files", params={"path": after["stems"][0]["path"]})
    assert served.status_code == 200

    outside = client.post("/v1/stemsets/analysis", json={"directory": str(songs[0].parent)})
    assert outside.status_code == 400


def test_a_stem_that_is_open_elsewhere_leaves_the_folder_as_it_was(
    pipeline, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = separated(
        pipeline, tmp_path, naming_template="{track} {bpm} - {stem}", tempo_sync=True
    )
    folder = Path(result.directory)
    render_mix(folder, [s.file for s in result.stems[:2]])
    before = {
        p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()
    }

    import openstems.pipeline.retag as retag

    real = os.replace
    calls = {"n": 0}

    def busy(src: Any, dst: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 2:  # the second stem is open in a DAW
            raise PermissionError(13, "The process cannot access the file", str(src))
        real(src, dst)

    monkeypatch.setattr(retag.os, "replace", busy)
    with pytest.raises(DomainError, match="open in another program"):
        set_analysis(folder, {"bpm": 99})
    monkeypatch.setattr(retag.os, "replace", real)

    after = {
        p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()
    }
    assert after == before  # every name, every tempo mark and the manifest, byte for byte
