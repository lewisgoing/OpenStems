"""Manual start: files added to the queue wait there until the user presses Start."""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from openstems.api.app import create_app
from openstems.api.service import Service
from openstems.audio.write import write_audio
from openstems.settings import Settings, load_settings
from tests.conftest import RATE, tone

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("OPENSTEMS_ENGINE", "fake")
    monkeypatch.setenv("OPENSTEMS_FAKE_DELAY", "0.01")
    monkeypatch.delenv("OPENSTEMS_AUTO_START", raising=False)
    service = Service()
    with TestClient(create_app(TOKEN, service), headers=AUTH) as c:
        c.service = service  # type: ignore[attr-defined]
        assert service.jobs.supervisor.ready.wait(30), "worker did not start"
        yield c


@pytest.fixture
def songs(tmp_path: Path) -> list[str]:
    folder = tmp_path / "in"
    folder.mkdir()
    paths = []
    for i in range(3):
        path = folder / f"Song {i}.wav"
        write_audio(path, tone(0.4, 200 + 20 * i), RATE)
        paths.append(str(path))
    return paths


def jobs(client: TestClient) -> list[dict[str, Any]]:
    return client.get("/v1/jobs").json()["jobs"]


def wait_until(client: TestClient, predicate, timeout: float = 30.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = jobs(client)
        if predicate(current):
            return current
        time.sleep(0.05)
    raise AssertionError(
        f"timed out: {[(j['track_name'], j['state'], j['held']) for j in jobs(client)]}"
    )


def states(current: list[dict[str, Any]]) -> list[str]:
    return [j["state"] for j in current]


def test_manual_start_is_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENSTEMS_AUTO_START", raising=False)
    assert Settings().auto_start is False
    assert load_settings().auto_start is False
    monkeypatch.setenv("OPENSTEMS_AUTO_START", "1")
    assert load_settings().auto_start is True
    monkeypatch.setenv("OPENSTEMS_AUTO_START", "0")
    assert load_settings().auto_start is False


def test_added_files_wait_until_start_then_run_in_order(client: TestClient, songs) -> None:
    added = client.post("/v1/jobs/batch", json={"paths": songs}).json()["jobs"]
    assert [j["held"] for j in added] == [True, True, True]
    assert states(added) == ["queued", "queued", "queued"]
    # A held job is not in line: it has no position.
    assert [j["queue_position"] for j in added] == [None, None, None]

    # Nothing runs by itself.
    time.sleep(0.5)
    assert states(jobs(client)) == ["queued", "queued", "queued"]
    assert not Path(load_settings().output_dir).exists()

    started = client.post("/v1/jobs/start").json()["jobs"]
    assert [j["held"] for j in started] == [False, False, False]
    done = wait_until(client, lambda js: all(j["state"] == "done" for j in js))
    finished = [j["finished_at"] for j in done]
    assert finished == sorted(finished)


def test_one_job_can_be_started_by_itself(client: TestClient, songs) -> None:
    added = client.post("/v1/jobs/batch", json={"paths": songs}).json()["jobs"]
    second = added[1]["id"]
    assert client.post(f"/v1/jobs/{second}/start").json()["held"] is False
    current = wait_until(client, lambda js: js[1]["state"] == "done")
    assert states(current) == ["queued", "done", "queued"]
    assert [j["held"] for j in current] == [True, False, True]
    assert client.post("/v1/jobs/nope/start").status_code == 404


def test_a_request_can_say_start_and_the_watch_folder_always_does(
    client: TestClient, songs
) -> None:
    now = client.post("/v1/jobs", json={"path": songs[0], "start": True}).json()
    assert now["held"] is False
    later = client.post("/v1/jobs", json={"path": songs[1]}).json()
    assert later["held"] is True

    client.service._queue_watched(Path(songs[2]))  # type: ignore[attr-defined]
    current = wait_until(client, lambda js: [j["state"] for j in js].count("done") == 2)
    assert states(current) == ["done", "queued", "done"]


def test_with_auto_start_on_files_run_as_they_arrive(client: TestClient, songs) -> None:
    assert client.get("/v1/settings").json()["auto_start"] is False
    assert client.patch("/v1/settings", json={"auto_start": True}).json()["auto_start"] is True
    added = client.post("/v1/jobs/batch", json={"paths": songs}).json()["jobs"]
    assert [j["held"] for j in added] == [False, False, False]
    wait_until(client, lambda js: all(j["state"] == "done" for j in js))
    # A request can still ask to wait.
    waiting = client.post("/v1/jobs", json={"path": songs[0], "start": False}).json()
    assert waiting["held"] is True


def test_a_held_job_can_be_cancelled_and_a_retry_runs_it(client: TestClient, songs) -> None:
    job = client.post("/v1/jobs", json={"path": songs[0]}).json()
    assert client.post(f"/v1/jobs/{job['id']}/cancel").json()["state"] == "cancelled"
    retried = client.post(f"/v1/jobs/{job['id']}/retry").json()
    assert retried["held"] is False
    wait_until(client, lambda js: js[0]["state"] == "done")


def test_held_jobs_still_wait_after_the_engine_restarts(client: TestClient, songs) -> None:
    client.post("/v1/jobs/batch", json={"paths": songs[:2]})
    from openstems.api.events import EventBus
    from openstems.api.jobs import JobManager

    restored = JobManager(client.service.index, EventBus())  # type: ignore[attr-defined]
    assert [(j["state"], j["held"]) for j in restored.list()] == [
        ("queued", True),
        ("queued", True),
    ]
