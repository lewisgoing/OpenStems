"""A song's name, by the user: before it is separated, and on stems already written."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from openstems.audio.write import read_audio, write_audio
from openstems.domain.errors import DomainError
from openstems.domain.naming import MAX_COMPONENT, clean_name
from openstems.domain.stem import Track
from openstems.pipeline.mix import render_mix
from openstems.pipeline.rename import rename_song
from openstems.pipeline.run import RunOptions, read_manifest
from tests.conftest import RATE, REFUSED, tone
from tests.test_api import all_terminal, client, fake_env, service_of, songs, wait_for
from tests.test_producer_features import full_song

__all__ = ["client", "fake_env", "songs"]  # fixtures, used by name

CASES = json.loads((Path(__file__).parent / "fixtures" / "song_names.json").read_text("utf-8"))


def files_in(folder: Path) -> dict[str, bytes]:
    return {
        p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()
    }


# -- what the user may type -----------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=[case["note"] for case in CASES])
def test_a_name_is_cleaned_the_way_the_app_cleans_it(case: dict[str, Any]) -> None:
    """The same cases as `cleanName` in the app (`src/test/songname.test.ts`)."""
    if "error" in case:
        with pytest.raises(DomainError):
            clean_name(case["typed"])
    else:
        assert clean_name(case["typed"]) == case["name"]


def test_a_name_must_be_text() -> None:
    assert clean_name(None) is None
    with pytest.raises(DomainError):
        clean_name(12)
    assert len(clean_name("a" * MAX_COMPONENT) or "") == MAX_COMPONENT


def test_a_track_goes_by_its_title_and_keeps_its_part() -> None:
    track = Track(path="/in/y2mate - song (320).mp3", content_hash="", size=0)
    assert track.name == "y2mate - song (320)"
    named = Track(path=track.path, content_hash="", size=0, title="Night Drive")
    assert named.name == "Night Drive"
    part = Track(path=track.path, content_hash="", size=0, title="Night Drive", part="bars 9-16")
    assert part.name == "Night Drive (bars 9-16)"


# -- before the song is separated -----------------------------------------------------


def test_a_run_is_named_by_the_name_it_is_given(pipeline, song: Path, tmp_path: Path) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(name="AC/DC: Live?"))
    folder = Path(result.directory)
    # The name is kept as typed; the folder and files take what a file name can hold.
    assert result.manifest["source"]["name"] == "AC/DC: Live?"
    assert folder == tmp_path / "out" / "AC_DC_ Live_" / "full-song"
    assert all(s.file == f"AC_DC_ Live_ - {s.name}.wav" for s in result.stems)
    assert song.is_file()  # the song's own file keeps its name

    # The same song under the same name is found again; under another it is another folder.
    again = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(name="AC/DC: Live?"))
    assert again.cached
    other = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    assert not other.cached and Path(other.directory).parent.name == "Test Song"


# -- after: stems that are already written --------------------------------------------


def test_renaming_moves_the_folder_the_stems_and_every_recipe(
    pipeline, song: Path, tmp_path: Path
) -> None:
    out = tmp_path / "out"
    first = pipeline.run(song, full_song(), out, RunOptions(midi_stems=["bass"]))
    one_stem = full_song().with_outputs(["vocals"])
    second = pipeline.run(song, _as(one_stem, "vocals-only"), out, RunOptions())
    folder = Path(first.directory)
    audio = {s.name: read_audio(folder / s.file)[0] for s in first.stems}
    mix = Path(render_mix(folder, [s.file for s in first.stems[:2]])["path"])
    (folder.parent / "notes.txt").write_text("mine", encoding="utf-8")

    moved = rename_song(folder, "Night Drive")
    song_folder = out / "Night Drive"
    assert not (out / "Test Song").exists()
    assert sorted(m.now for m in moved) == sorted(
        [song_folder / "full-song", song_folder / Path(second.directory).name]
    )
    for item in moved:
        manifest = read_manifest(item.now)
        assert manifest == item.manifest and manifest is not None
        assert manifest["source"]["name"] == "Night Drive"
        assert manifest["source"]["path"] == str(song.resolve())
        for stem in manifest["stems"]:
            assert stem["file"] == f"Night Drive - {stem['name']}.wav"
            assert (item.now / stem["file"]).is_file()
            assert (item.now / stem["peaks"]).is_file()
            if stem.get("midi"):
                assert stem["midi"] == f"Night Drive - {stem['name']}.mid"
                assert (item.now / stem["midi"]).is_file()
    now = song_folder / "full-song"
    for stem in read_manifest(now)["stems"]:  # type: ignore[index]
        assert (read_audio(now / stem["file"])[0] == audio[stem["name"]]).all()
    # What else was in the song's folder moved with it; a mix keeps the name it has.
    assert (song_folder / "notes.txt").read_text("utf-8") == "mine"
    assert (now / "Mixes" / mix.name).is_file()
    # A mix made now is named after the song as it is called now.
    files = [s["file"] for s in read_manifest(now)["stems"][:2]]  # type: ignore[index]
    assert render_mix(now, files)["name"].startswith("Night Drive - ")
    assert song.is_file()


def _as(recipe: Any, recipe_id: str) -> Any:
    from dataclasses import replace

    return replace(recipe, id=recipe_id)


def test_a_template_without_the_song_renames_only_the_folder(
    pipeline, song: Path, tmp_path: Path
) -> None:
    result = pipeline.run(
        song, full_song(), tmp_path / "out", RunOptions(naming_template="{stem} ({recipe})")
    )
    names = sorted(s.file for s in result.stems)
    (moved,) = rename_song(Path(result.directory), "Night Drive")
    assert moved.now == tmp_path / "out" / "Night Drive" / "full-song"
    assert sorted(s["file"] for s in moved.manifest["stems"]) == names
    assert all((moved.now / name).is_file() for name in names)


def test_the_same_name_changes_nothing_and_a_change_of_case_is_a_rename(
    pipeline, song: Path, tmp_path: Path
) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    folder = Path(result.directory)
    before = files_in(folder)
    (same,) = rename_song(folder, "Test Song")
    assert same.now == folder and files_in(folder) == before

    (moved,) = rename_song(folder, "TEST song")
    assert moved.manifest["source"]["name"] == "TEST song"
    assert "TEST song" in os.listdir(tmp_path / "out")
    assert all(s["file"].startswith("TEST song - ") for s in moved.manifest["stems"])
    assert all((moved.now / s["file"]).is_file() for s in moved.manifest["stems"])


def test_a_name_that_is_taken_changes_nothing(pipeline, song: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    result = pipeline.run(song, full_song(), out, RunOptions())
    folder = Path(result.directory)
    before = files_in(out)

    (out / "Night Drive").mkdir()  # another song's folder
    with pytest.raises(DomainError, match="already a song called"):
        rename_song(folder, "Night Drive")
    (out / "Night Drive").rmdir()

    # A file of the new name in the stem folder is someone's: it is not written over.
    stem = result.stems[0]
    (folder / f"Night Drive - {stem.name}.wav").write_bytes(b"someone else's file")
    with pytest.raises(DomainError, match="already in the stem folder"):
        rename_song(folder, "Night Drive")
    (folder / f"Night Drive - {stem.name}.wav").unlink()

    assert files_in(out) == before
    with pytest.raises(DomainError):
        rename_song(tmp_path, "Night Drive")  # not a stem folder


@pytest.mark.parametrize("failing", ["folder", "file"])
def test_a_file_that_is_open_elsewhere_leaves_the_song_as_it_was(
    pipeline, song: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failing: str
) -> None:
    out = tmp_path / "out"
    result = pipeline.run(song, full_song(), out, RunOptions())
    folder = Path(result.directory)
    render_mix(folder, [s.file for s in result.stems[:2]])
    before = files_in(out)

    import openstems.pipeline.rename as rename

    real_rename, real_replace = os.rename, os.replace
    calls = {"n": 0}

    def busy_folder(src: Any, dst: Any) -> None:
        if Path(dst).name == "Night Drive":  # a DAW holds a stem open: Windows says no
            raise PermissionError(13, "The process cannot access the file", str(src))
        real_rename(src, dst)

    def busy_file(src: Any, dst: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 3:
            raise PermissionError(13, "The process cannot access the file", str(src))
        real_replace(src, dst)

    if failing == "folder":
        monkeypatch.setattr(rename.os, "rename", busy_folder)
    else:
        monkeypatch.setattr(rename.os, "replace", busy_file)
    with pytest.raises(DomainError, match=REFUSED):
        rename_song(folder, "Night Drive")
    monkeypatch.undo()

    assert files_in(out) == before  # every folder, every name and the manifest, byte for byte
    assert not (out / "Night Drive").exists()


# -- through the API ------------------------------------------------------------------


def test_a_waiting_song_is_named_and_runs_under_its_name(
    client: TestClient, songs: list[Path]
) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {}, "start": False}
    job = client.post("/v1/jobs", json=body).json()
    assert job["track_name"] == "Song 0"

    answer = client.post(f"/v1/jobs/{job['id']}/name", json={"name": "  Night   Drive "})
    assert answer.status_code == 200, answer.text
    assert answer.json()["track_name"] == "Night Drive"
    assert answer.json()["options"]["name"] == "Night Drive"
    # null (or nothing typed) gives it its file's name back.
    back = client.post(f"/v1/jobs/{job['id']}/name", json={"name": ""}).json()
    assert back["track_name"] == "Song 0" and "name" not in back["options"]
    assert client.post(f"/v1/jobs/{job['id']}/name", json={"name": "..."}).status_code == 400
    assert client.post(f"/v1/jobs/{job['id']}/name", json={"name": "x" * 121}).status_code == 400
    assert client.post("/v1/jobs/nope/name", json={"name": "x"}).status_code == 404

    client.post(f"/v1/jobs/{job['id']}/name", json={"name": "Night Drive"})
    client.post("/v1/jobs/start")
    done = wait_for(client, all_terminal)[0]
    assert done["state"] == "done" and done["track_name"] == "Night Drive"
    assert Path(done["output_dir"]).parent.name == "Night Drive"
    assert all(s["file"].startswith("Night Drive - ") for s in done["stems"])
    assert client.get("/v1/stemsets").json()["stem_sets"][0]["track_name"] == "Night Drive"
    assert songs[0].is_file()


def test_a_job_can_be_queued_with_its_name(client: TestClient, songs: list[Path]) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {"name": " Night Drive "}}
    job = client.post("/v1/jobs", json=body).json()
    assert job["track_name"] == "Night Drive"
    assert wait_for(client, all_terminal)[0]["output_dir"].endswith(
        os.path.join("Night Drive", "full-song")
    )


def test_finished_stems_are_renamed_through_the_job_and_the_history(
    client: TestClient, songs: list[Path]
) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]
    old_dir = Path(job["output_dir"])

    # From the queue: the job itself.
    answer = client.post(f"/v1/jobs/{job['id']}/name", json={"name": "Night Drive"})
    assert answer.status_code == 200, answer.text
    renamed = answer.json()
    assert renamed["track_name"] == "Night Drive"
    new_dir = old_dir.parent.parent / "Night Drive" / "full-song"
    assert Path(renamed["output_dir"]) == new_dir and not old_dir.parent.exists()
    for stem in renamed["stems"]:
        assert stem["file"] == f"Night Drive - {stem['name']}.wav"
        assert Path(stem["path"]).is_file() and Path(stem["peaks"]).is_file()
    # The renamed files are served, so the app can still play and drag them.
    served = client.get("/v1/files", params={"path": renamed["stems"][0]["path"]})
    assert served.status_code == 200
    listed = client.get("/v1/stemsets").json()["stem_sets"]
    assert [(s["track_name"], Path(s["directory"])) for s in listed] == [("Night Drive", new_dir)]

    # From the history: the folder. The job in the queue follows.
    answer = client.post(
        "/v1/stemsets/name", json={"directory": str(new_dir), "name": "Dusk: Part 2"}
    )
    assert answer.status_code == 200, answer.text
    stem_set = answer.json()
    assert stem_set["track_name"] == "Dusk: Part 2"
    assert Path(stem_set["directory"]) == new_dir.parent.parent / "Dusk_ Part 2" / "full-song"
    assert all(Path(s["path"]).is_file() for s in stem_set["stems"])
    after = client.get(f"/v1/jobs/{job['id']}").json()
    assert after["track_name"] == "Dusk: Part 2"
    assert [s["path"] for s in after["stems"]] == [s["path"] for s in stem_set["stems"]]
    assert len(client.get("/v1/stemsets").json()["stem_sets"]) == 1

    # null gives the song its file's name back, on the disk as well.
    back = client.post(f"/v1/jobs/{job['id']}/name", json={"name": None}).json()
    assert back["track_name"] == "Song 0" and Path(back["output_dir"]) == old_dir
    assert "name" not in back["options"]
    assert all(Path(s["path"]).is_file() for s in back["stems"])

    outside = client.post(
        "/v1/stemsets/name", json={"directory": str(songs[0].parent), "name": "x"}
    )
    assert outside.status_code == 400


def test_a_name_is_the_songs_so_every_row_of_the_file_follows(
    client: TestClient, songs: list[Path]
) -> None:
    done_body = {"path": str(songs[0]), "recipe": "full-song", "options": {}}
    assert client.post("/v1/jobs", json=done_body).status_code == 200
    first = wait_for(client, all_terminal)[0]
    waiting_body = {"path": str(songs[0]), "recipe": "drum-kit", "options": {}, "start": False}
    waiting = client.post("/v1/jobs", json=waiting_body).json()
    other = client.post(
        "/v1/jobs", json={"path": str(songs[1]), "recipe": "full-song", "start": False}
    ).json()

    # Renamed on the row that waits: the finished stems of the same file are renamed too.
    assert (
        client.post(f"/v1/jobs/{waiting['id']}/name", json={"name": "Night Drive"}).status_code
        == 200
    )
    jobs = {j["id"]: j for j in client.get("/v1/jobs").json()["jobs"]}
    assert jobs[first["id"]]["track_name"] == "Night Drive"
    assert Path(jobs[first["id"]]["output_dir"]).parent.name == "Night Drive"
    assert jobs[waiting["id"]]["track_name"] == "Night Drive"
    assert jobs[other["id"]]["track_name"] == "Song 1"  # another song keeps its own

    # The file queued again goes by the name it was given, and its stems join the others.
    again = client.post(
        "/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song", "start": False}
    ).json()
    assert again["track_name"] == "Night Drive"
    client.post("/v1/jobs/start")
    jobs = {j["id"]: j for j in wait_for(client, all_terminal)}
    assert jobs[again["id"]]["cached"] is True
    assert Path(jobs[waiting["id"]]["output_dir"]).parent.name == "Night Drive"
    assert not (Path(first["output_dir"]).parent).exists()


def test_a_named_song_keeps_its_name_once_its_rows_are_gone(
    client: TestClient, songs: list[Path]
) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {"name": "Night Drive"}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    wait_for(client, all_terminal)
    assert client.post("/v1/jobs/clear-finished").status_code == 200
    # From the history alone: "Run another recipe" keeps the song together.
    again = client.post(
        "/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song", "start": False}
    ).json()
    assert again["track_name"] == "Night Drive"


def test_a_song_that_is_running_is_not_renamed(
    client: TestClient, songs: list[Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    service = service_of(client)
    running = {
        "id": "x",
        "state": "running",
        "track_path": str(songs[0]),
        "options": {},
        "output_dir": None,
    }
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]

    # Another file of the same name is on the GPU: it may be writing to this song's folder.
    monkeypatch.setattr(service.jobs, "running", lambda: running)
    refused = client.post(
        "/v1/stemsets/name", json={"directory": job["output_dir"], "name": "Night Drive"}
    )
    assert refused.status_code == 400 and "being separated" in refused.json()["detail"]
    assert Path(job["output_dir"]).is_dir()
    monkeypatch.undo()

    # A row of the song itself that runs refuses the rename from any of its rows.
    listed = service.jobs.list
    monkeypatch.setattr(
        service.jobs, "list", lambda: [*listed(), {**listed()[0], "id": "y", "state": "writing"}]
    )
    refused = client.post(f"/v1/jobs/{job['id']}/name", json={"name": "Night Drive"})
    assert refused.status_code == 400 and "being separated" in refused.json()["detail"]
    assert client.get(f"/v1/jobs/{job['id']}").json()["track_name"] == "Song 0"


def test_a_part_separated_alone_keeps_its_label(client: TestClient, tmp_path: Path) -> None:
    assert client.patch("/v1/settings", json={"separate_selection": True}).status_code == 200
    source = tmp_path / "Long.wav"
    write_audio(source, tone(4.0), RATE)
    body = {"path": str(source), "recipe": "full-song", "options": {}, "start": False}
    job = client.post("/v1/jobs", json=body).json()
    ranged = client.post(f"/v1/jobs/{job['id']}/range", json={"range": {"start": 1, "end": 3}})
    label = ranged.json()["options"]["range"]["label"]
    client.post("/v1/jobs/start")
    done = wait_for(client, all_terminal)[0]
    assert Path(done["output_dir"]).parent.name == f"Long ({label})"

    # On its row the song is "Long": a new name keeps the part's label on the disk.
    renamed = client.post(f"/v1/jobs/{job['id']}/name", json={"name": "Hook"}).json()
    assert renamed["track_name"] == "Hook"
    assert Path(renamed["output_dir"]).parent.name == f"Hook ({label})"
    listed = client.get("/v1/stemsets").json()["stem_sets"][0]
    assert listed["track_name"] == f"Hook ({label})" and listed["part"]["label"] == label

    # In the history its name is typed whole, label and all.
    typed = client.post(
        "/v1/stemsets/name",
        json={"directory": renamed["output_dir"], "name": f"Riff ({label})"},
    ).json()
    assert typed["track_name"] == f"Riff ({label})"
    assert client.get(f"/v1/jobs/{job['id']}").json()["track_name"] == "Riff"


def test_a_clip_of_a_named_songs_own_file_goes_beside_its_stems(
    client: TestClient, songs: list[Path]
) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {"name": "Night Drive"}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]
    answer = client.post(
        "/v1/clips", json={"paths": [str(songs[0])], "start": 0.0, "end": 0.2, "source": True}
    )
    assert answer.status_code == 200, answer.text
    clip = Path(answer.json()["clips"][0]["path"])
    assert clip.parent == Path(job["output_dir"]).parent / "Clips"
    assert clip.name.startswith("Night Drive - ")
