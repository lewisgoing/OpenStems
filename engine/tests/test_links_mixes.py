"""Links that become jobs, and mixes of a song's stems. No network: the FakeEngine's stand-in
fetches, and yt-dlp itself is only checked for being there."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from openstems.audio.write import read_audio
from openstems.links import (
    LinkError,
    check_url,
    clean_error,
    folder_for,
    host_of,
    tidy_title,
)
from openstems.pipeline.mix import mix_label
from tests.test_api import all_terminal, client, fake_env, service_of, songs, wait_for

__all__ = ["client", "fake_env", "songs"]  # fixtures, used by name


def links_of(client: TestClient) -> list[dict[str, Any]]:
    return client.get("/v1/links").json()["links"]


def wait_links(client: TestClient, predicate, timeout: float = 20.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    links: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        links = links_of(client)
        if predicate(links):
            return links
        time.sleep(0.03)
    raise AssertionError(f"timed out; links: {links}")


# -- addresses ------------------------------------------------------------------------


def test_only_web_addresses_are_links() -> None:
    assert check_url("  https://example.com/watch?v=1 ") == "https://example.com/watch?v=1"
    for bad in ("", "song.mp3", "file:///C:/song.mp3", "ftp://example.com/a", "https://", "a b"):
        with pytest.raises(LinkError):
            check_url(bad)
    assert host_of("https://www.youtube.com/watch?v=1") == "youtube.com"


def test_each_address_has_its_own_folder(tmp_path: Path) -> None:
    one = folder_for(tmp_path, "https://example.com/a")
    assert one == folder_for(tmp_path, "https://example.com/a")
    assert one != folder_for(tmp_path, "https://example.com/b")
    assert one.parent == tmp_path


def test_fetch_errors_read_as_sentences() -> None:
    raw = "\x1b[0;31mERROR:\x1b[0m [youtube] abc123: Video unavailable. This video is private"
    assert clean_error(raw) == "Video unavailable. This video is private"
    assert "cannot fetch" in clean_error("ERROR: Unsupported URL: https://example.com/")
    assert clean_error("") == "The link could not be fetched."
    offline = "ERROR: [generic] Unable to download webpage: Failed to resolve 'example.com'"
    assert "could not be reached" in clean_error(offline)


def test_a_title_becomes_a_file_name_that_reads_well() -> None:
    assert tidy_title("Kevin MacLeod: Sneaky Snitch") == "Kevin MacLeod - Sneaky Snitch"
    assert tidy_title('AC/DC | "Live" <1979>?') == "AC-DC - 'Live' (1979)"
    assert tidy_title("  ") == "Untitled"


def test_the_fetcher_and_its_javascript_runtime_are_installed() -> None:
    import yt_dlp
    from yt_dlp.version import __version__

    from openstems.links import _deno

    assert yt_dlp.YoutubeDL
    assert __version__ == "2026.10.26"
    deno = _deno()
    assert deno and Path(deno).is_file()


# -- from a link to a job --------------------------------------------------------------


def test_a_link_is_fetched_and_runs_like_a_dropped_file(client: TestClient) -> None:
    response = client.post(
        "/v1/links", json={"url": "https://example.com/songs/Night-Drive", "recipe": "full-song"}
    )
    assert response.status_code == 200, response.text
    link = response.json()
    assert link["state"] in ("waiting", "resolving", "downloading")
    assert link["name"] == "example.com"

    jobs = wait_for(client, all_terminal)
    assert [job["state"] for job in jobs] == ["done"]
    assert jobs[0]["track_name"] == "Night Drive"
    source = Path(jobs[0]["track_path"])
    assert source.is_file()
    # Kept inside the output folder, in a folder of its own.
    output = service_of(client).runtime.settings.output_path
    assert source.parent.parent == output / "_links"
    assert links_of(client) == []

    kinds = [event["type"] for event in service_of(client).bus.history]
    assert "link.updated" in kinds and "link.removed" in kinds
    named = [
        e["link"]["name"] for e in service_of(client).bus.history if e["type"] == "link.updated"
    ]
    assert "Night Drive" in named


def test_a_fetched_link_waits_for_start_when_songs_do(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_AUTO_START", "0")
    service_of(client).reload()
    client.post("/v1/links", json={"url": "https://example.com/a/Held-Song"})
    jobs = wait_for(client, lambda jobs: len(jobs) == 1)
    assert jobs[0]["state"] == "queued" and jobs[0]["held"] is True
    # Asked to start once fetched, it does.
    client.post("/v1/links", json={"url": "https://example.com/a/Eager-Song", "start": True})
    jobs = wait_for(client, lambda jobs: len(jobs) == 2 and jobs[1]["state"] == "done")
    assert jobs[0]["held"] is True


def test_a_failed_link_stays_to_be_retried_or_dismissed(client: TestClient) -> None:
    link = client.post("/v1/links", json={"url": "https://example.com/fail/song"}).json()
    failed = wait_links(client, lambda links: links and links[0]["state"] == "failed")
    assert "cannot fetch" in failed[0]["error"]
    assert client.get("/v1/jobs").json()["jobs"] == []

    assert client.post(f"/v1/links/{link['id']}/retry").status_code == 200
    wait_links(client, lambda links: links and links[0]["state"] == "failed")
    assert client.delete(f"/v1/links/{link['id']}").json() == {"removed": 1}
    assert links_of(client) == []
    assert client.delete(f"/v1/links/{link['id']}").status_code == 404
    assert client.post(f"/v1/links/{link['id']}/retry").status_code == 404


def test_a_playlist_is_refused_with_a_reason(client: TestClient) -> None:
    client.post("/v1/links", json={"url": "https://example.com/playlist?list=1"})
    failed = wait_links(client, lambda links: links and links[0]["state"] == "failed")
    assert "playlist" in failed[0]["error"]


def test_cancelling_a_fetch_leaves_no_job_and_no_file(client: TestClient) -> None:
    link = client.post("/v1/links", json={"url": "https://example.com/slow/Long-Song"}).json()
    wait_links(client, lambda links: links and links[0]["state"] == "downloading")
    assert client.delete(f"/v1/links/{link['id']}").status_code == 200
    assert links_of(client) == []
    time.sleep(0.6)
    assert client.get("/v1/jobs").json()["jobs"] == []
    root = service_of(client).runtime.settings.output_path / "_links"
    assert not any(p.is_file() for p in root.rglob("*"))


def test_bad_link_requests_fail_at_once(client: TestClient) -> None:
    assert client.post("/v1/links", json={"url": "not a link"}).status_code == 400
    bad_recipe = client.post("/v1/links", json={"url": "https://example.com/a", "recipe": "nope"})
    assert bad_recipe.status_code == 400
    assert links_of(client) == []


def test_only_a_failed_link_can_be_retried(client: TestClient) -> None:
    link = client.post("/v1/links", json={"url": "https://example.com/slow/Another"}).json()
    assert client.post(f"/v1/links/{link['id']}/retry").status_code == 400
    client.delete(f"/v1/links/{link['id']}")


# -- mixes ---------------------------------------------------------------------------


def test_a_mix_is_named_for_what_is_in_it() -> None:
    six = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    assert mix_label(six, six) == "mix"
    assert mix_label(six[1:], six) == "no vocals"
    assert mix_label(["drums", "bass"], six) == "drums + bass"
    assert mix_label(["drums", "bass", "other"], six) == "drums + bass + other"
    assert mix_label(["drums", "bass", "guitar", "piano"], six) == "no vocals, other"
    many = [f"s{i}" for i in range(12)]
    assert mix_label(many[:6], many) == "6 stems"


def done_job(client: TestClient, songs: list[Path], **options: Any) -> dict[str, Any]:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": options}
    assert client.post("/v1/jobs", json=body).status_code == 200
    return wait_for(client, all_terminal)[0]


def test_a_mix_is_the_sum_of_its_stems(client: TestClient, songs: list[Path]) -> None:
    job = done_job(client, songs)
    stems = job["stems"]
    assert len(stems) >= 3
    chosen = stems[1:]
    response = client.post("/v1/mixes", json={"paths": [s["path"] for s in chosen]})
    assert response.status_code == 200, response.text
    mix = response.json()
    assert mix["label"] == f"no {stems[0]['name']}"
    assert mix["stems"] == [s["name"] for s in chosen]
    path = Path(mix["path"])
    assert path.parent == Path(job["output_dir"]) / "Mixes"
    assert path.name == f"{songs[0].stem} - no {stems[0]['name']}.wav"

    audio, rate = read_audio(path)
    expected = sum(read_audio(Path(s["path"]))[0] for s in chosen)
    assert rate == chosen[0]["sample_rate"]
    assert np.allclose(audio, expected, atol=1e-6)
    # The mix can be played and dragged like a stem: it is served.
    assert client.get("/v1/files", params={"path": str(path)}).status_code == 200
    # Asking again writes the same file again.
    again = client.post("/v1/mixes", json={"paths": [s["path"] for s in chosen]}).json()
    assert again["path"] == mix["path"]
    assert [p.name for p in path.parent.iterdir()] == [path.name]


def test_a_mix_follows_the_stems_format(client: TestClient, songs: list[Path]) -> None:
    job = done_job(client, songs, output_format="flac")
    mix = client.post("/v1/mixes", json={"paths": [s["path"] for s in job["stems"][:2]]}).json()
    assert mix["name"].endswith(".flac")
    audio, _ = read_audio(Path(mix["path"]))
    expected = sum(read_audio(Path(s["path"]))[0] for s in job["stems"][:2])
    assert np.allclose(audio, np.clip(expected, -1, 1), atol=1e-4)


def test_a_mix_puts_trimmed_stems_back_in_place(client: TestClient, songs: list[Path]) -> None:
    job = done_job(client, songs, trim_silence=True)
    stems = job["stems"]
    mix = client.post("/v1/mixes", json={"paths": [s["path"] for s in stems]}).json()
    lengths = [read_audio(Path(s["path"]))[0].shape[1] for s in stems]
    assert mix["samples"] >= max(lengths)


def test_bad_mix_requests(client: TestClient, songs: list[Path], tmp_path: Path) -> None:
    job = done_job(client, songs)
    stems = job["stems"]
    one = client.post("/v1/mixes", json={"paths": [stems[0]["path"]]})
    assert one.status_code == 400 and "two" in one.json()["detail"]
    assert client.post("/v1/mixes", json={"paths": []}).status_code == 400
    outside = client.post("/v1/mixes", json={"paths": [str(songs[0]), str(songs[1])]})
    assert outside.status_code == 400
    stray = Path(job["output_dir"]) / "stray.wav"
    stray.write_bytes(Path(stems[0]["path"]).read_bytes())
    not_a_stem = client.post("/v1/mixes", json={"paths": [stems[0]["path"], str(stray)]})
    assert not_a_stem.status_code == 400 and "not a stem" in not_a_stem.json()["detail"]
