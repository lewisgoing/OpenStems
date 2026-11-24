"""A part of a song separated alone: chosen in the trimmer while the song waits in the
queue (a job's `range`), and separated alone, as a song of its own, only while the
separate_selection setting is on when the song starts."""

from __future__ import annotations

import math
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from openstems.api.db import Index
from openstems.api.events import EventBus
from openstems.api.jobs import JobManager
from openstems.audio.write import read_audio, write_audio
from openstems.domain.errors import DomainError
from openstems.domain.grid import SongPart, clean_selection, part_downbeat
from openstems.domain.naming import safe_component
from openstems.domain.stem import Track
from openstems.pipeline.clip import render_clips
from openstems.pipeline.retag import set_analysis
from openstems.pipeline.run import RunOptions, read_manifest
from openstems.settings import Settings
from tests.conftest import RATE, tone
from tests.test_api import all_terminal, client, fake_env, service_of, wait_for
from tests.test_clips import beat_song
from tests.test_producer_features import full_song

__all__ = ["client", "fake_env"]  # fixtures, used by name

STARTED = "this song has started: its part can no longer change"
GRID = {"bpm": 120, "downbeat": 0.5}  # bar lines every 2 s from 0.5 s


@pytest.fixture
def song(tmp_path: Path) -> Path:
    """Six seconds of tones and seeded noise: every frame differs from its neighbours."""
    path = tmp_path / "in" / "Satellite Rain.wav"
    path.parent.mkdir()
    write_audio(path, tone(6.0), RATE)
    return path


def queued(client: TestClient, song: Path, **body: Any) -> dict[str, Any]:
    """The song in the queue, waiting for Start."""
    answer = client.post("/v1/jobs", json={"path": str(song), "start": False, **body})
    assert answer.status_code == 200, answer.text
    return answer.json()


def set_range(client: TestClient, job: dict[str, Any], part: dict[str, Any] | None) -> Any:
    return client.post(f"/v1/jobs/{job['id']}/range", json={"range": part})


def run(client: TestClient, job: dict[str, Any]) -> dict[str, Any]:
    assert client.post(f"/v1/jobs/{job['id']}/start").status_code == 200
    jobs = wait_for(client, lambda jobs: all_terminal([j for j in jobs if j["id"] == job["id"]]))
    done = next(j for j in jobs if j["id"] == job["id"])
    assert done["state"] == "done", done["error"]
    return done


def separate_selection(client: TestClient, on: bool) -> None:
    answer = client.patch("/v1/settings", json={"separate_selection": on})
    assert answer.status_code == 200 and answer.json()["separate_selection"] is on


# -- the setting ------------------------------------------------------------------------


def test_the_setting_is_off_by_default_and_round_trips(client: TestClient) -> None:
    assert Settings().separate_selection is False
    assert client.get("/v1/settings").json()["separate_selection"] is False
    separate_selection(client, True)
    assert client.get("/v1/settings").json()["separate_selection"] is True
    # Other settings leave it as it is.
    assert client.patch("/v1/settings", json={"sum_to_mix": True}).json()["separate_selection"]
    assert client.patch("/v1/settings", json={"separate_selection": "maybe"}).status_code == 422
    separate_selection(client, False)
    assert client.get("/v1/settings").json()["separate_selection"] is False


# -- choosing the part ------------------------------------------------------------------


def test_a_waiting_song_is_given_a_part_and_can_lose_it(client: TestClient, song: Path) -> None:
    job = queued(client, song)
    answer = set_range(client, job, {"start": 2.5, "end": 4.5, "grid": GRID})
    assert answer.status_code == 200, answer.text
    assert answer.json()["options"]["range"] == {"start": 2.5, "end": 4.5, "label": "bar 2"}
    assert answer.json()["part"] is None  # nothing is separated yet
    # The queue shows it, and was told.
    (listed,) = client.get("/v1/jobs").json()["jobs"]
    assert listed["options"]["range"]["label"] == "bar 2"
    told = [e["job"] for e in service_of(client).bus.history if e["type"] == "job.updated"]
    assert told[-1]["id"] == job["id"] and told[-1]["options"]["range"]["label"] == "bar 2"
    # One tempo per song: a job with no tempo of its own keeps the grid its part was named
    # on, so its run lays the bars out where the name says they are.
    assert (answer.json()["options"]["bpm"], answer.json()["options"]["downbeat"]) == (120, 0.5)

    # Without a grid it is named by the tempo and bar 1 the job has, or by its times.
    by_tempo = set_range(client, job, {"start": 0.5, "end": 4.5}).json()
    assert by_tempo["options"]["range"] == {"start": 0.5, "end": 4.5, "label": "bars 1-2"}
    none = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": None, "downbeat": None})
    assert none.status_code == 200, none.text
    by_times = set_range(client, job, {"start": 2.5, "end": 4.5}).json()
    assert by_times["options"]["range"]["label"] == "0m02.50s-0m04.50s"
    assert "bpm" not in by_times["options"] and "downbeat" not in by_times["options"]
    given = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 120, "downbeat": 0.5})
    assert given.status_code == 200, given.text
    # The grid it was chosen on wins over the job's own, which stays as it was.
    beats = set_range(client, job, {"start": 1.0, "end": 2.0, "grid": {"bpm": 60, "downbeat": 0}})
    assert beats.json()["options"]["range"]["label"] == "1.2-1.3"
    assert (beats.json()["options"]["bpm"], beats.json()["options"]["downbeat"]) == (120, 0.5)

    # Kept inside the song.
    whole = set_range(client, job, {"start": -1.0, "end": 60.0}).json()["options"]["range"]
    assert (whole["start"], whole["end"]) == (0.0, 6.0)

    cleared = set_range(client, job, None)
    assert cleared.status_code == 200 and "range" not in cleared.json()["options"]
    assert cleared.json()["options"]["bpm"] == 120  # the rest of its options stay
    assert set_range(client, job, None).status_code == 200  # nothing to take away: fine


def test_a_part_that_cannot_be_is_refused_with_a_sentence(
    client: TestClient, song: Path, tmp_path: Path
) -> None:
    job = queued(client, song)

    def refused(part: dict[str, Any] | None, which: dict[str, Any] | None = None) -> str:
        answer = set_range(client, which or job, part)
        assert answer.status_code == 400, answer.text
        return answer.json()["detail"]

    assert refused({"start": 3.0, "end": 2.0}) == "the selection must end after it starts"
    assert refused({"start": 2.0, "end": 2.01}) == "the selection is too short"
    assert refused({"start": 7.0, "end": 9.0}) == "the selection is too short"  # past the end
    tempo = refused({"start": 1.0, "end": 2.0, "grid": {"bpm": 5, "downbeat": 0}})
    assert tempo == "the tempo must be between 20 and 999 BPM"
    # JSON can carry NaN, and FastAPI takes it as a number.
    nan = client.post(
        f"/v1/jobs/{job['id']}/range",
        content='{"range": {"start": NaN, "end": 2.0}}',
        headers={"Content-Type": "application/json"},
    )
    assert (
        nan.status_code == 400 and nan.json()["detail"] == "the selection must be a time in seconds"
    )
    assert client.post(f"/v1/jobs/{job['id']}/range", json={}).status_code == 422
    assert client.post("/v1/jobs/nope/range", json={"range": None}).status_code == 404
    assert "range" not in client.get(f"/v1/jobs/{job['id']}").json()["options"]

    # A part is chosen once the song is in the queue, never with the job.
    body = {"path": str(song), "options": {"range": {"start": 1, "end": 2, "label": "x"}}}
    made = client.post("/v1/jobs", json=body)
    assert made.status_code == 400
    assert made.json()["detail"] == "a part of a song is chosen once the song is in the queue"

    # Once the song has started, its part stays as it was, and so does the lack of one.
    done = run(client, job)
    assert refused({"start": 1.0, "end": 2.0}, done) == STARTED
    assert refused(None, done) == STARTED
    cancelled = queued(client, song)
    client.post(f"/v1/jobs/{cancelled['id']}/cancel")
    assert refused({"start": 1.0, "end": 2.0}, cancelled) == STARTED


def test_a_job_keeps_what_it_lacked_of_the_grid_its_part_was_named_on(
    client: TestClient, song: Path
) -> None:
    # A tempo of its own and no bar 1: bar 1 is kept when the grid has that tempo.
    job = queued(client, song)
    client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 120})
    kept = set_range(client, job, {"start": 2.5, "end": 4.5, "grid": GRID}).json()["options"]
    assert (kept["bpm"], kept["downbeat"], kept["range"]["label"]) == (120, 0.5, "bar 2")
    # With another tempo, the grid's bar 1 would not fit the job's own: nothing is kept.
    other = queued(client, song)
    client.post(f"/v1/jobs/{other['id']}/analysis", json={"bpm": 100})
    left = set_range(client, other, {"start": 2.5, "end": 4.5, "grid": GRID}).json()["options"]
    assert left["bpm"] == 100 and "downbeat" not in left and left["range"]["label"] == "bar 2"
    # Kept as the tempo field keeps a tempo: two decimals at most, and bar 1 to four.
    loose = queued(client, song)
    fine = {"bpm": 86.66666, "downbeat": 0.123456}
    kept = set_range(client, loose, {"start": 2.5, "end": 4.5, "grid": fine}).json()["options"]
    assert (kept["bpm"], kept["downbeat"]) == (86.67, 0.1235)


def test_a_part_is_named_again_when_the_song_gets_another_tempo(
    client: TestClient, song: Path
) -> None:
    # The trimmer names the part on the song's grid; then the tempo is corrected in the
    # song's row, which sends the tempo alone.
    job = queued(client, song)
    assert set_range(client, job, {"start": 2.5, "end": 4.5, "grid": GRID}).status_code == 200
    halved = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 60})
    assert halved.status_code == 200, halved.text
    # Bar 1 stays at 0.5 s, so at 60 BPM the same seconds are beats 1.3 to 2.1.
    assert halved.json()["options"]["range"] == {"start": 2.5, "end": 4.5, "label": "1.3-2.1"}
    told = [e["job"] for e in service_of(client).bus.history if e["type"] == "job.updated"]
    assert told[-1]["options"]["range"]["label"] == "1.3-2.1"
    # A key renames nothing; a tempo taken away names it by its times.
    keyed = client.post(f"/v1/jobs/{job['id']}/analysis", json={"key": "Am"}).json()
    assert keyed["options"]["range"]["label"] == "1.3-2.1"
    auto = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": None}).json()
    assert auto["options"]["range"]["label"] == "0m02.50s-0m04.50s"
    back = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 60}).json()
    assert back["options"]["range"]["label"] == "1.3-2.1"

    # Its folder and its stems' grid follow the one tempo.
    separate_selection(client, True)
    done = run(client, job)
    assert done["part"] == {"start": 2.5, "end": 4.5, "label": "1.3-2.1"}
    assert Path(done["output_dir"]).parent.name == "Satellite Rain (1.3-2.1)"
    assert done["analysis"]["bpm"] == 60
    # Bar 1 of the song, two beats before the part, moves on by a bar: 2 s into the part.
    assert done["analysis"]["downbeat"] == 2.0


# -- separating it ----------------------------------------------------------------------


def test_with_the_setting_on_only_the_part_is_separated(client: TestClient, song: Path) -> None:
    whole = run(client, queued(client, song))  # the whole song first, to compare with
    job = queued(client, song)
    given = client.post(f"/v1/jobs/{job['id']}/analysis", json={"bpm": 120, "downbeat": 0.5})
    assert given.status_code == 200, given.text
    assert set_range(client, job, {"start": 2.5, "end": 4.5}).status_code == 200
    separate_selection(client, True)
    done = run(client, job)

    part = {"start": 2.5, "end": 4.5, "label": "bar 2"}
    assert done["part"] == part and done["options"]["range"] == part
    output = service_of(client).runtime.settings.output_path
    folder = Path(done["output_dir"])
    assert folder == output / "Satellite Rain (bar 2)" / "full-song"
    first, frames = round(2.5 * RATE), round(2.0 * RATE)
    for stem, full in zip(done["stems"], whole["stems"], strict=True):
        assert Path(stem["path"]).name == f"Satellite Rain (bar 2) - {stem['name']}.wav"
        assert stem["samples"] == frames and stem["start"] == 0.0
        audio, _ = read_audio(Path(stem["path"]))
        everything, _ = read_audio(Path(full["path"]))
        # Sample-exact: the frames a clip of the same selection is cut from.
        assert np.array_equal(audio, everything[:, first : first + frames])

    manifest = read_manifest(folder)
    assert manifest is not None
    source = manifest["source"]
    assert source["path"] == str(song.resolve()) and source["name"] == "Satellite Rain (bar 2)"
    assert source["range"] == part
    assert (source["decoded_samples"], source["duration"]) == (frames, 2.0)
    # The tempo it was given passes through; bar 1 is moved into the part, onto the part's
    # first bar line: 0.5 s into the song is 2 s before the part, a bar at 120 BPM.
    assert manifest["analysis"]["bpm"] == 120 and manifest["analysis"]["downbeat"] == 0.0
    assert done["analysis"]["downbeat"] == 0.0

    # The history knows it as a part of the song, and so does the queue after a restart.
    (listed,) = [s for s in client.get("/v1/stemsets").json()["stem_sets"] if s["part"]]
    assert listed["part"] == part and listed["track_name"] == "Satellite Rain (bar 2)"
    assert listed["track_path"] == str(song.resolve())
    restored = JobManager(service_of(client).index, EventBus())
    assert next(j for j in restored.list() if j["id"] == job["id"])["part"] == part
    # The same part of the song again is found in the cache, named alike by the grid it was
    # chosen on; the whole song keeps its own stems.
    second = queued(client, song)
    assert set_range(client, second, {"start": 2.5, "end": 4.5, "grid": GRID}).status_code == 200
    again = run(client, second)
    assert again["cached"] and again["part"] == part and again["output_dir"] == str(folder)
    assert read_manifest(Path(whole["output_dir"])) is not None
    assert {s["samples"] for s in whole["stems"]} == {6 * RATE}


def test_with_the_setting_off_the_whole_song_is_separated(client: TestClient, song: Path) -> None:
    job = queued(client, song)
    assert set_range(client, job, {"start": 2.5, "end": 4.5, "grid": GRID}).status_code == 200
    separate_selection(client, True)
    separate_selection(client, False)  # turned off again before the song starts
    done = run(client, job)
    assert done["part"] is None and done["options"]["range"]["label"] == "bar 2"
    output = service_of(client).runtime.settings.output_path
    assert Path(done["output_dir"]) == output / "Satellite Rain" / "full-song"
    assert {stem["samples"] for stem in done["stems"]} == {6 * RATE}
    manifest = read_manifest(Path(done["output_dir"]))
    assert manifest is not None and "range" not in manifest["source"]
    assert "range" not in manifest["options"]
    (listed,) = client.get("/v1/stemsets").json()["stem_sets"]
    assert listed["part"] is None


# -- the run, without the API -----------------------------------------------------------


def test_the_range_enters_the_cache_key_only_when_there_is_one(pipeline, tmp_path: Path) -> None:
    assert "range" not in RunOptions().key_dict()
    part = SongPart(0.5, 2.5, "bar 1")
    assert RunOptions(part=part).key_dict()["range"] == [round(0.5 * RATE), round(2.0 * RATE)]
    rest = {k: v for k, v in RunOptions(part=part).key_dict().items() if k != "range"}
    assert rest == RunOptions().key_dict()

    source = tmp_path / "Satellite Rain.wav"
    write_audio(source, tone(3.0), RATE)
    out = tmp_path / "out"
    whole = pipeline.run(source, full_song(), out, RunOptions())
    piece = pipeline.run(source, full_song(), out, RunOptions(part=part))
    shorter = SongPart(0.5, 2.0, "0m00.50s-0m02.00s")
    other = pipeline.run(source, full_song(), out, RunOptions(part=shorter))
    keys = {r.manifest["cache_key"] for r in (whole, piece, other)}
    assert len(keys) == 3 and not (whole.cached or piece.cached)
    # Each is found again, the whole song under the key it always had.
    assert pipeline.run(source, full_song(), out, RunOptions()).cached
    assert pipeline.run(source, full_song(), out, RunOptions(part=part)).cached
    assert Path(whole.directory) == out / "Satellite Rain" / "full-song"
    assert Path(piece.directory) == out / "Satellite Rain (bar 1)" / "full-song"


def test_a_part_is_a_song_of_its_own(pipeline, tmp_path: Path) -> None:
    source = tmp_path / "Satellite Rain.wav"
    write_audio(source, tone(6.0), RATE)
    options = RunOptions(
        part=SongPart(0.5, 4.5, "bars 1-2"),
        naming_template="{track} {bpm} - {stem}",
        tempo_sync=True,
        bpm=120.0,
        downbeat=0.7,
    )
    result = pipeline.run(source, full_song(), tmp_path / "out", options)
    folder = Path(result.directory)
    assert result.stems[0].file == "Satellite Rain (bars 1-2) 120.0 - bass.wav"
    # Bar 1 of the song is inside the part: it stays where it is, in the part's seconds.
    assert result.manifest["analysis"]["downbeat"] == 0.2
    # A clip of its stems is kept inside the part.
    (clip,) = render_clips(folder, [result.stems[0].file], 1.0, 9.0, True, None)
    assert (clip["start"], clip["end"]) == (1.0, 4.0)
    # Its tempo can be corrected like any song's: the names that hold it follow.
    set_analysis(folder, {"bpm": 128})
    manifest = read_manifest(folder)
    assert manifest is not None
    assert manifest["stems"][0]["file"] == "Satellite Rain (bars 1-2) 128.0 - bass.wav"
    assert (folder / manifest["stems"][0]["file"]).is_file()


def test_detection_runs_on_the_part(pipeline, tmp_path: Path) -> None:
    source = tmp_path / "Beat.wav"
    write_audio(source, beat_song(120.0, 1.3, 20.0), RATE)
    options = RunOptions(part=SongPart(5.0, 17.0, "bars 2-7"), detect_tempo_key=True)
    result = pipeline.run(source, full_song(), tmp_path / "out", options)
    found = result.manifest["analysis"]
    assert abs(found["bpm"] - 120.0) < 0.5
    # The song's bar lines are at 1.3 s and every 2 s after it: 5.3 s is 0.3 s into the part.
    assert abs(found["downbeat"] - 0.3) < 0.03


def test_a_part_past_the_end_of_a_song_that_changed_fails_the_run(pipeline, tmp_path) -> None:
    source = tmp_path / "Satellite Rain.wav"
    write_audio(source, tone(1.0), RATE)
    options = RunOptions(part=SongPart(2.5, 4.5, "bar 2"))
    with pytest.raises(DomainError, match=r"the part to separate \(bar 2\) is not in the song"):
        pipeline.run(source, full_song(), tmp_path / "out", options)
    # One that reaches past the end is kept inside the song.
    piece = pipeline.run(
        source, full_song(), tmp_path / "out", RunOptions(part=SongPart(0.5, 4.5, "x"))
    )
    assert piece.manifest["source"]["range"] == {"start": 0.5, "end": 1.0, "label": "x"}
    assert {stem.samples for stem in piece.stems} == {round(0.5 * RATE)}


# -- the pieces -------------------------------------------------------------------------


def test_bar_one_is_moved_into_the_part() -> None:
    # In the part, or after it: where it is, in the part's seconds.
    assert part_downbeat(1.3, 1.0, 120.0) == 0.3
    assert part_downbeat(10.0, 2.0, 120.0) == 8.0
    # Before it: on by whole bars to the part's first bar line.
    assert part_downbeat(0.5, 2.5, 120.0) == 0.0
    assert part_downbeat(0.5, 2.6, 120.0) == -0.1  # within half a beat: still bar 1
    assert part_downbeat(0.5, 2.8, 120.0) == 1.7  # later in a bar: the part starts in bar 0
    # Far into a long song, it stays where bar 1 may be.
    far = part_downbeat(0.5, 300.25, 120.0)
    assert far is not None and -0.25 <= far < 2.0 and math.isclose(far % 2.0, 0.25)
    at_173 = part_downbeat(0.5, 0.5 + 8 * 4 * 60 / 173.4, 173.4)
    assert at_173 == 0.0
    # Without a tempo it cannot move: one before the part is dropped.
    assert part_downbeat(1.3, 1.0, None) == 0.3
    assert part_downbeat(0.5, 2.5, None) is None
    assert part_downbeat(2.5, 2.5, None) == 0.0


def test_a_selection_is_kept_inside_the_song() -> None:
    assert clean_selection(-1.0, 2.0, 6.0) == (0.0, 2.0)
    assert clean_selection(5.0, 9.0, 6.0) == (5.0, 6.0)
    assert clean_selection(5.0, 9.0, math.inf) == (5.0, 9.0)  # a song of unknown length
    for start, end, sentence in (
        (math.nan, 1.0, "the selection must be a time in seconds"),
        (0.0, math.inf, "the selection must be a time in seconds"),
        (2.0, 1.0, "the selection must end after it starts"),
        (1.0, 1.01, "the selection is too short"),
        (6.5, 9.0, "the selection is too short"),
    ):
        with pytest.raises(DomainError, match=sentence):
            clean_selection(start, end, 6.0)


def test_a_part_keeps_its_name_whole_when_the_songs_is_long() -> None:
    long = "A" * 130
    names = [
        Track(f"D:/in/{long}.wav", "ab", 1, part=label).name
        for label in ("bars 9-16", "bars 17-24")
    ]
    assert names[0].endswith("A (bars 9-16)") and names[1].endswith("A (bars 17-24)")
    # Short enough for a folder as it is: the folder of each part is its own.
    assert all(len(name) <= 120 and safe_component(name) == name for name in names)
    assert Track("D:/in/Song.wav", "ab", 1).name == "Song"


def test_a_part_that_was_kept_is_read_back() -> None:
    part = SongPart(2.5, 4.5, "bar 2")
    assert SongPart.from_dict(part.to_dict()) == part
    assert SongPart.from_dict(None) is None
    for bad in ({"start": 1.0}, {"start": "soon", "end": 2.0, "label": "x"}, [1, 2]):
        with pytest.raises(DomainError, match="the part of the song to separate cannot be read"):
            SongPart.from_dict(bad)


def test_an_index_from_before_parts_learns_of_them(tmp_path: Path) -> None:
    path = tmp_path / "index.sqlite"
    old = sqlite3.connect(path)
    old.executescript(
        "CREATE TABLE stem_sets (directory TEXT PRIMARY KEY, track_name TEXT NOT NULL, "
        "track_path TEXT NOT NULL, track_hash TEXT NOT NULL, recipe_id TEXT NOT NULL, "
        "recipe_name TEXT NOT NULL, cache_key TEXT NOT NULL, created_at TEXT NOT NULL, "
        "stems TEXT NOT NULL, analysis TEXT NOT NULL);"
    )
    old.execute(
        "INSERT INTO stem_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("D:/out/Song/full-song", "Song", "D:/in/Song.wav", "ab", "full-song", "Full song",
         "k", "2026-11-01T10:00:00", "[]", "{}"),
    )  # fmt: skip
    old.commit()
    old.close()
    index = Index(path)
    (before,) = index.stem_sets()
    assert before["part"] is None
    part = {"start": 2.5, "end": 4.5, "label": "bar 2"}
    manifest: dict[str, Any] = {
        "source": {"name": "Song (bar 2)", "path": "D:/in/Song.wav", "range": part},
        "recipe": {"id": "full-song", "name": "Full song"},
        "stems": [],
    }
    index.save_stem_set("D:/out/Song (bar 2)/full-song", manifest)
    found = index.stem_set("D:/out/Song (bar 2)/full-song")
    assert found is not None and found["part"] == part
    index.close()
    again = Index(path)  # opened again: nothing to add, nothing lost
    assert {s["directory"]: s["part"] for s in again.stem_sets()} == {
        "D:/out/Song/full-song": None,
        "D:/out/Song (bar 2)/full-song": part,
    }
    again.close()
