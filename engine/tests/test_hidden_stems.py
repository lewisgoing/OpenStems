"""Stems the user hides from the app's lists, or keeps in them: the choice is kept in the
manifest, travels with the stems, and survives a second separation and a rename."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from openstems.domain.errors import DomainError
from openstems.pipeline.levels import set_hidden
from openstems.pipeline.run import RunOptions, read_manifest, stem_set_from_manifest
from tests.test_api import all_terminal, client, fake_env, songs, wait_for
from tests.test_producer_features import full_song

__all__ = ["client", "fake_env", "songs"]  # fixtures, used by name


def choices(manifest: dict) -> dict[str, bool]:
    return {s["name"]: s["hidden"] for s in manifest["stems"] if "hidden" in s}


def files_in(folder: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file() and p.suffix == ".wav"}


# -- the manifest ---------------------------------------------------------------------


def test_a_choice_is_kept_in_the_manifest_and_no_file_is_touched(
    pipeline, song: Path, tmp_path: Path
) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    folder = Path(result.directory)
    audio = files_in(folder)
    assert choices(result.manifest) == {}  # nothing is written until something is chosen

    manifest = set_hidden(folder, {"drums": True, "bass": False})
    assert choices(manifest) == {"drums": True, "bass": False}
    assert read_manifest(folder) == manifest
    assert files_in(folder) == audio
    stems = {s.name: s.hidden for s in stem_set_from_manifest(folder, manifest).stems}  # type: ignore[union-attr]
    assert stems["drums"] is True and stems["bass"] is False and stems["vocals"] is None

    # Stems that are not named stay as they are; None takes a choice away again.
    manifest = set_hidden(folder, {"bass": None})
    assert choices(manifest) == {"drums": True}
    # The same choice again changes nothing, not even the file.
    stamp = (folder / "manifest.json").stat().st_mtime_ns
    set_hidden(folder, {"drums": True})
    assert (folder / "manifest.json").stat().st_mtime_ns == stamp


def test_a_stem_the_song_does_not_have_and_a_folder_without_stems_are_refused(
    pipeline, song: Path, tmp_path: Path
) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    folder = Path(result.directory)
    with pytest.raises(DomainError, match="not a stem of this song: kazoo"):
        set_hidden(folder, {"drums": True, "kazoo": True})
    assert choices(read_manifest(folder)) == {}  # type: ignore[arg-type]
    with pytest.raises(DomainError):
        set_hidden(tmp_path, {"drums": True})


def test_a_choice_stays_when_the_song_is_separated_again(
    pipeline, song: Path, tmp_path: Path
) -> None:
    out = tmp_path / "out"
    first = pipeline.run(song, full_song(), out, RunOptions())
    set_hidden(Path(first.directory), {"drums": True, "bass": False})

    cached = pipeline.run(song, full_song(), out, RunOptions())
    assert cached.cached and {s.name: s.hidden for s in cached.stems}["drums"] is True
    # Separated anew, the folder is written again: the choices are carried over.
    again = pipeline.run(song, full_song(), out, RunOptions(force=True))
    assert not again.cached
    assert choices(again.manifest) == {"drums": True, "bass": False}
    assert choices(read_manifest(Path(again.directory))) == {"drums": True, "bass": False}  # type: ignore[arg-type]


# -- through the API ------------------------------------------------------------------


def test_stems_are_hidden_and_brought_back_through_the_api(
    client: TestClient, songs: list[Path]
) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]
    assert all(s["hidden"] is None for s in job["stems"])
    directory = job["output_dir"]

    answer = client.post(
        "/v1/stemsets/hidden", json={"directory": directory, "stems": {"drums": True}}
    )
    assert answer.status_code == 200, answer.text
    hidden = {s["name"]: s["hidden"] for s in answer.json()["stems"]}
    assert hidden["drums"] is True and hidden["vocals"] is None
    # The history and the song's row in the queue say the same.
    listed = client.get("/v1/stemsets").json()["stem_sets"][0]
    assert {s["name"]: s["hidden"] for s in listed["stems"]}["drums"] is True
    row = client.get(f"/v1/jobs/{job['id']}").json()
    assert {s["name"]: s["hidden"] for s in row["stems"]}["drums"] is True
    assert all(Path(s["path"]).is_file() for s in row["stems"])  # hidden is not deleted

    # Kept in though empty, and the choice taken away again.
    answer = client.post(
        "/v1/stemsets/hidden",
        json={"directory": directory, "stems": {"drums": None, "bass": False}},
    )
    hidden = {s["name"]: s["hidden"] for s in answer.json()["stems"]}
    assert hidden["drums"] is None and hidden["bass"] is False

    unknown = client.post(
        "/v1/stemsets/hidden", json={"directory": directory, "stems": {"kazoo": True}}
    )
    assert unknown.status_code == 400 and "kazoo" in unknown.json()["detail"]
    outside = client.post(
        "/v1/stemsets/hidden", json={"directory": str(songs[0].parent), "stems": {}}
    )
    assert outside.status_code == 400


def test_a_hidden_stem_stays_hidden_when_the_song_is_renamed(
    client: TestClient, songs: list[Path]
) -> None:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": {}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]
    client.post(
        "/v1/stemsets/hidden", json={"directory": job["output_dir"], "stems": {"drums": True}}
    )
    renamed = client.post(f"/v1/jobs/{job['id']}/name", json={"name": "Night Drive"}).json()
    assert Path(renamed["output_dir"]).parent.name == "Night Drive"
    assert {s["name"]: s["hidden"] for s in renamed["stems"]}["drums"] is True
    listed = client.get("/v1/stemsets").json()["stem_sets"][0]
    assert {s["name"]: s["hidden"] for s in listed["stems"]}["drums"] is True
