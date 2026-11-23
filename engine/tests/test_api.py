"""The local API against the FakeEngine: a real worker process, no GPU, no downloads."""

from __future__ import annotations

import itertools
import json
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from openstems.api.app import create_app, openapi_json
from openstems.api.service import Service
from openstems.audio.write import write_audio
from tests.conftest import RATE, tone

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
TERMINAL = {"done", "failed", "cancelled"}


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENSTEMS_ENGINE", "fake")
    monkeypatch.setenv("OPENSTEMS_FAKE_DELAY", "0.01")


@pytest.fixture
def client(fake_env: None) -> Iterator[TestClient]:
    service = Service()
    service.bus.record = True
    with TestClient(create_app(TOKEN, service), headers=AUTH) as c:
        c.service = service  # type: ignore[attr-defined]
        assert service.jobs.supervisor.ready.wait(30), "worker did not start"
        yield c


@pytest.fixture
def songs(tmp_path: Path) -> list[Path]:
    folder = tmp_path / "in"
    folder.mkdir()
    paths = []
    for i in range(5):
        path = folder / f"Song {i}.wav"
        write_audio(path, tone(0.4, 200 + 20 * i), RATE)
        paths.append(path)
    return paths


def wait_for(client: TestClient, predicate, timeout: float = 30.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    jobs: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        jobs = client.get("/v1/jobs").json()["jobs"]
        if predicate(jobs):
            return jobs
        time.sleep(0.05)
    raise AssertionError(f"timed out; jobs: {[(j['id'], j['state']) for j in jobs]}")


def all_terminal(jobs: list[dict[str, Any]]) -> bool:
    return bool(jobs) and all(j["state"] in TERMINAL for j in jobs)


def service_of(client: TestClient) -> Service:
    return client.service  # type: ignore[attr-defined]


# -- auth ------------------------------------------------------------------------


def test_requests_without_the_token_are_rejected(client: TestClient) -> None:
    bare = TestClient(client.app)
    for method, url in [
        ("get", "/v1/health"),
        ("get", "/v1/jobs"),
        ("get", "/v1/models"),
        ("get", "/v1/settings"),
        ("post", "/v1/jobs/clear-finished"),
        ("get", "/v1/files?path=x"),
    ]:
        assert getattr(bare, method)(url).status_code == 401, url
    assert bare.get("/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert bare.get("/v1/health?token=wrong").status_code == 401
    assert bare.get(f"/v1/health?token={TOKEN}").status_code == 200
    assert client.get("/v1/health").json()["fake_engine"] is True


def test_websocket_needs_the_token(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    bare = TestClient(client.app)
    with pytest.raises(WebSocketDisconnect), bare.websocket_connect("/v1/events"):
        pass
    with (
        pytest.raises(WebSocketDisconnect),
        bare.websocket_connect("/v1/events?token=wrong"),
    ):
        pass
    with bare.websocket_connect(f"/v1/events?token={TOKEN}") as ws:
        assert ws.receive_json()["type"] == "snapshot"


# -- jobs ------------------------------------------------------------------------


def test_batch_of_five_runs_in_order_with_ordered_progress(client: TestClient, songs) -> None:
    response = client.post(
        "/v1/jobs/batch", json={"paths": [str(p) for p in songs], "recipe": "full-song"}
    )
    assert response.status_code == 200, response.text
    ids = [j["id"] for j in response.json()["jobs"]]
    assert len(ids) == 5

    jobs = wait_for(client, all_terminal)
    assert [j["state"] for j in jobs] == ["done"] * 5
    assert all(len(j["stems"]) == 6 and Path(j["stems"][0]["path"]).is_file() for j in jobs)

    history = service_of(client).bus.history
    seqs = [e["seq"] for e in history]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    # Per job: progress never goes backwards.
    for job_id in ids:
        fractions = [
            e["progress"] for e in history if e["type"] == "job.progress" and e["id"] == job_id
        ]
        assert fractions and fractions == sorted(fractions)
    # One job at a time, in the order they were queued.
    finished_at = {
        e["job"]["id"]: e["seq"]
        for e in history
        if e["type"] == "job.updated" and e["job"]["state"] == "done"
    }
    first_progress = {}
    for e in history:
        if e["type"] == "job.progress":
            first_progress.setdefault(e["id"], e["seq"])
    for earlier, later in itertools.pairwise(ids):
        assert finished_at[earlier] < first_progress[later]


def test_cancelling_a_running_job_frees_the_worker_for_the_next(
    client: TestClient, songs, monkeypatch: pytest.MonkeyPatch
) -> None:
    service_of(client).jobs.supervisor.stop()
    monkeypatch.setenv("OPENSTEMS_FAKE_DELAY", "0.25")
    service_of(client).jobs._worker_ready = False
    service_of(client).jobs.supervisor.start()
    assert service_of(client).jobs.supervisor.ready.wait(30)

    first = client.post("/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song"}).json()
    second = client.post("/v1/jobs", json={"path": str(songs[1]), "recipe": "full-song"}).json()
    wait_for(client, lambda jobs: jobs[0]["state"] == "running")
    assert client.post(f"/v1/jobs/{first['id']}/cancel").status_code == 200

    jobs = wait_for(client, all_terminal)
    by_id = {j["id"]: j for j in jobs}
    assert by_id[first["id"]]["state"] == "cancelled"
    assert by_id[second["id"]]["state"] == "done"
    assert not list(Path(service_of(client).runtime.settings.output_dir).rglob("*.tmp-*"))
    out = Path(service_of(client).runtime.settings.output_dir) / "Song 0"
    assert not list(out.rglob("*.wav"))


def test_killing_the_worker_fails_the_job_and_restarts_the_worker(
    client: TestClient, songs, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs_manager = service_of(client).jobs
    jobs_manager.supervisor.stop()
    monkeypatch.setenv("OPENSTEMS_FAKE_DELAY", "0.25")
    jobs_manager._worker_ready = False
    jobs_manager.supervisor.start()
    assert jobs_manager.supervisor.ready.wait(30)
    old_pid = jobs_manager.supervisor.pid

    first = client.post("/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song"}).json()
    wait_for(client, lambda jobs: jobs[0]["state"] == "running")
    jobs_manager.supervisor.kill()

    jobs = wait_for(client, all_terminal)
    assert jobs[0]["id"] == first["id"] and jobs[0]["state"] == "failed"
    assert "worker" in jobs[0]["error"].lower()
    assert client.get("/v1/health").status_code == 200  # the API stayed up

    monkeypatch.setenv("OPENSTEMS_FAKE_DELAY", "0.01")
    second = client.post("/v1/jobs", json={"path": str(songs[1]), "recipe": "full-song"}).json()
    jobs = wait_for(client, all_terminal)
    assert {j["id"]: j["state"] for j in jobs}[second["id"]] == "done"
    status = client.get("/v1/system").json()["worker"]
    assert status["restarts"] == 1 and status["pid"] != old_pid


def test_retry_reorder_remove_and_clear(
    client: TestClient, songs, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs_manager = service_of(client).jobs
    jobs_manager.supervisor.stop()
    monkeypatch.setenv("OPENSTEMS_FAKE_DELAY", "0.15")
    jobs_manager._worker_ready = False
    jobs_manager.supervisor.start()
    assert jobs_manager.supervisor.ready.wait(30)

    ids = [
        client.post("/v1/jobs", json={"path": str(p), "recipe": "full-song"}).json()["id"]
        for p in songs[:4]
    ]
    wait_for(client, lambda jobs: jobs[0]["state"] in ("preparing", "running"))

    # Reorder the three queued jobs: last one first.
    queued = ids[1:]
    new_order = [queued[2], queued[0], queued[1]]
    bad = client.post("/v1/jobs/reorder", json={"ids": queued[:2]})
    assert bad.status_code == 400
    response = client.post("/v1/jobs/reorder", json={"ids": new_order})
    assert response.status_code == 200
    assert [j["id"] for j in response.json()["jobs"]] == [ids[0], *new_order]

    # Cancel a queued job, then retry it: it goes to the back.
    assert client.post(f"/v1/jobs/{new_order[1]}/cancel").json()["state"] == "cancelled"
    assert client.post(f"/v1/jobs/{ids[0]}/retry").status_code == 400  # not failed/cancelled
    assert client.post(f"/v1/jobs/{new_order[1]}/retry").json()["state"] == "queued"

    jobs = wait_for(client, all_terminal)
    assert all(j["state"] == "done" for j in jobs)
    done_order = sorted(jobs, key=lambda j: j["finished_at"])
    assert [j["id"] for j in done_order] == [ids[0], new_order[0], new_order[2], new_order[1]]

    assert client.delete(f"/v1/jobs/{ids[0]}").json() == {"removed": 1}
    assert client.delete("/v1/jobs/nope").status_code == 404
    assert client.post("/v1/jobs/clear-finished").json() == {"removed": 3}
    assert client.get("/v1/jobs").json()["jobs"] == []


def test_bad_job_requests(client: TestClient, songs, tmp_path: Path) -> None:
    assert client.post("/v1/jobs", json={"path": str(tmp_path / "no.wav")}).status_code == 400
    bad_recipe = client.post("/v1/jobs", json={"path": str(songs[0]), "recipe": "nope"})
    assert bad_recipe.status_code == 400 and "unknown recipe" in bad_recipe.json()["detail"]
    bad_quality = client.post("/v1/jobs", json={"path": str(songs[0]), "quality": "ultra"})
    assert bad_quality.status_code == 422
    assert (
        client.post("/v1/jobs/batch", json={"paths": [str(tmp_path / "empty")]}).status_code == 400
    )


def test_single_model_job_and_cache(client: TestClient, songs) -> None:
    body = {"path": str(songs[0]), "model": "bs-roformer-leap-xe-vocals"}
    client.post("/v1/jobs", json=body)
    jobs = wait_for(client, all_terminal)
    assert jobs[0]["state"] == "done" and [s["name"] for s in jobs[0]["stems"]] == ["vocals"]
    assert jobs[0]["cached"] is False
    client.post("/v1/jobs", json=body)
    jobs = wait_for(client, all_terminal)
    assert jobs[1]["state"] == "done" and jobs[1]["cached"] is True


def test_events_arrive_over_the_websocket(client: TestClient, songs) -> None:
    with client.websocket_connect(f"/v1/events?token={TOKEN}") as ws:
        assert ws.receive_json()["type"] == "snapshot"
        job = client.post("/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song"}).json()
        seen: list[dict[str, Any]] = []
        while True:
            event = ws.receive_json()
            seen.append(event)
            if event["type"] == "job.updated" and event["job"]["state"] == "done":
                break
        assert event["job"]["id"] == job["id"]
        assert any(e["type"] == "job.progress" for e in seen)
        assert [e["seq"] for e in seen] == sorted(e["seq"] for e in seen)


# -- tracks, recipes, models, settings --------------------------------------------


def test_register_tracks_probes_and_expands_folders(client: TestClient, songs, tmp_path) -> None:
    (songs[0].parent / "notes.txt").write_text("x", "utf-8")
    bad = tmp_path / "broken.mp3"
    bad.write_bytes(b"nope")
    tracks = client.post("/v1/tracks", json={"paths": [str(songs[0].parent), str(bad)]}).json()[
        "tracks"
    ]
    assert len(tracks) == 6
    good = [t for t in tracks if t["ok"]]
    assert len(good) == 5 and good[0]["sample_rate"] == RATE and good[0]["duration"] > 0.3
    assert tracks[-1]["ok"] is False and tracks[-1]["error"]


def test_recipes_and_models(client: TestClient) -> None:
    recipes = {r["id"]: r for r in client.get("/v1/recipes").json()["recipes"]}
    assert recipes["full-song"]["outputs"] == [
        "vocals",
        "drums",
        "bass",
        "guitar",
        "piano",
        "other",
    ]
    assert recipes["full-song"]["supports_sum_to_mix"] is True
    assert recipes["full-song"]["missing_models"] == []

    listing = client.get("/v1/models").json()
    models = {m["id"]: m for m in listing["models"]}
    assert models["bs-roformer-sw"]["status"] == "installed"  # fake store
    assert "full-song" in models["bs-roformer-sw"]["used_by"]
    assert client.post("/v1/models/nope/pull").status_code == 400

    assert client.post("/v1/models/bs-roformer-sw/pull").status_code == 200
    service_of(client).downloads.wait("bs-roformer-sw")
    progress = [e for e in service_of(client).bus.history if e["type"] == "model.progress"]
    assert progress and progress[-1]["state"] == "installed"
    assert client.post("/v1/models/bs-roformer-sw/verify").json()["ok"] is True


def test_settings_round_trip_and_validation(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENSTEMS_OUTPUT_DIR")  # the environment would override the file
    before = client.get("/v1/settings").json()
    assert before["output_format"] == "wav32f" and before["naming_template"] == "{track} - {stem}"
    new_out = str(tmp_path / "elsewhere")
    after = client.patch(
        "/v1/settings",
        json={"output_dir": new_out, "sum_to_mix": True, "naming_template": "{stem} ({track})"},
    ).json()
    assert after["output_dir"] == new_out and after["sum_to_mix"] is True
    assert client.get("/v1/settings").json()["naming_template"] == "{stem} ({track})"
    assert client.patch("/v1/settings", json={"naming_template": "{track}"}).status_code == 400
    assert client.patch("/v1/settings", json={"output_format": "ogg"}).status_code == 422
    assert client.patch("/v1/settings", json={"default_recipe": "nope"}).status_code == 400


# -- files and history -------------------------------------------------------------


def test_files_support_range_requests_and_stay_inside_outputs(
    client: TestClient, songs, tmp_path: Path
) -> None:
    client.post("/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song"})
    job = wait_for(client, all_terminal)[0]
    stem = job["stems"][0]
    whole = client.get("/v1/files", params={"path": stem["path"]})
    assert whole.status_code == 200 and whole.headers["accept-ranges"] == "bytes"
    assert whole.content == Path(stem["path"]).read_bytes()

    part = client.get("/v1/files", params={"path": stem["path"]}, headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == whole.content[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(whole.content)}"
    tail = client.get("/v1/files", params={"path": stem["path"]}, headers={"Range": "bytes=-4"})
    assert tail.content == whole.content[-4:]
    beyond = client.get(
        "/v1/files", params={"path": stem["path"]}, headers={"Range": "bytes=999999999-"}
    )
    assert beyond.status_code == 416

    peaks = client.get("/v1/peaks", params={"path": stem["peaks"]}).json()
    assert peaks["length"] * 2 == len(peaks["data"])

    secret = tmp_path / "secret.txt"
    secret.write_text("no", "utf-8")
    assert client.get("/v1/files", params={"path": str(secret)}).status_code == 404
    assert client.get("/v1/files", params={"path": str(songs[0])}).status_code == 404


def test_history_lists_and_rebuilds_from_manifests(client: TestClient, songs) -> None:
    for path in songs[:2]:
        client.post("/v1/jobs", json={"path": str(path), "recipe": "full-song"})
    wait_for(client, all_terminal)
    sets = client.get("/v1/stemsets").json()["stem_sets"]
    assert sorted(s["track_name"] for s in sets) == ["Song 0", "Song 1"]
    assert (
        client.get("/v1/stemsets", params={"q": "song 1"}).json()["stem_sets"][0]["track_name"]
        == "Song 1"
    )

    service = service_of(client)
    for directory in service.index.stem_set_dirs():
        service.index.delete_stem_set(directory)
    assert client.get("/v1/stemsets").json()["stem_sets"] == []
    assert client.post("/v1/stemsets/rebuild").json() == {"stem_sets": 2}
    assert len(client.get("/v1/stemsets").json()["stem_sets"]) == 2


def test_jobs_survive_a_restart(fake_env: None, songs) -> None:
    service = Service()
    with TestClient(create_app(TOKEN, service), headers=AUTH) as c:
        assert service.jobs.supervisor.ready.wait(30)
        c.post("/v1/jobs", json={"path": str(songs[0]), "recipe": "full-song"})
        wait_for(c, all_terminal)
    with TestClient(create_app(TOKEN, Service()), headers=AUTH) as c:
        jobs = c.get("/v1/jobs").json()["jobs"]
        assert len(jobs) == 1 and jobs[0]["state"] == "done" and len(jobs[0]["stems"]) == 6


# -- openapi and serve ---------------------------------------------------------------


def test_openapi_document_names_every_operation() -> None:
    doc = json.loads(openapi_json())
    operations = {op["operationId"] for path in doc["paths"].values() for op in path.values()}
    assert {"create_job", "create_batch", "cancel_job", "retry_job", "reorder_jobs",
            "list_models", "pull_model", "delete_model", "verify_model", "get_settings",
            "patch_settings", "register_tracks", "list_recipes", "get_file", "get_peaks",
            "list_stem_sets", "health"} <= operations  # fmt: skip
    assert "JobInfo" in doc["components"]["schemas"]


def test_committed_openapi_file_is_current() -> None:
    """engine/openapi.json feeds the TypeScript client: it must match the code."""
    committed = Path(__file__).resolve().parents[1] / "openapi.json"
    assert json.loads(committed.read_text("utf-8")) == json.loads(openapi_json()), (
        "run: uv run openstems openapi --out openapi.json, then pnpm gen:api in app/"
    )


def test_serve_prints_port_and_token_and_answers(fake_env: None) -> None:
    import httpx

    process = subprocess.Popen(
        [sys.executable, "-m", "openstems.cli", "serve"],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        line = json.loads(process.stdout.readline())
        assert line["event"] == "listening" and line["port"] > 0 and len(line["token"]) >= 32
        base = f"http://127.0.0.1:{line['port']}"
        deadline = time.monotonic() + 20
        while True:
            try:
                ok = httpx.get(
                    f"{base}/v1/health", headers={"Authorization": f"Bearer {line['token']}"}
                )
                break
            except httpx.TransportError:
                assert time.monotonic() < deadline
                time.sleep(0.1)
        assert ok.status_code == 200
        assert httpx.get(f"{base}/v1/health").status_code == 401
    finally:
        process.terminate()
        process.wait(10)


# -- GPU self-test ---------------------------------------------------------------


def test_selftest_reports_and_is_kept_for_diagnostics(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import zipfile

    from openstems.settings import Settings

    logs = tmp_path / "logs"
    monkeypatch.setattr(Settings, "logs_path", property(lambda self: logs))
    body = client.post("/v1/selftest").json()
    assert body["ok"] is False  # the FakeEngine has no GPU
    assert body["problems"]
    assert json.loads((logs / "selftest.json").read_text(encoding="utf-8"))["ok"] is False

    path = Path(client.post("/v1/diagnostics").json()["path"])
    with zipfile.ZipFile(path) as archive:
        assert "selftest.json" in archive.namelist()


def test_selftest_waits_for_the_queue(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    service = service_of(client)
    monkeypatch.setattr(service.jobs, "list", lambda: [{"state": "running"}])
    response = client.post("/v1/selftest")
    assert response.status_code == 400
    assert "queue" in response.json()["detail"]


def test_selftest_process_output_is_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess
    from types import SimpleNamespace

    from openstems.api import service as service_module

    def fake_run(command: list[str], **kwargs: object) -> SimpleNamespace:
        assert command[-2:] == ["selftest", "--json"]
        return fake_run.result  # type: ignore[attr-defined]

    monkeypatch.setattr(subprocess, "run", fake_run)
    # A mismatch exits 1 and still prints the report; warnings may come before it.
    fake_run.result = SimpleNamespace(  # type: ignore[attr-defined]
        returncode=1, stdout='a warning\n{"ok": false, "ops": []}', stderr=""
    )
    assert service_module.run_selftest_process() == {"ok": False, "ops": []}
    fake_run.result = SimpleNamespace(  # type: ignore[attr-defined]
        returncode=3221225477, stdout="", stderr="Traceback\nboom"
    )
    crashed = service_module.run_selftest_process()
    assert crashed["ok"] is False
    assert "crashed" in crashed["problems"][0]
    assert crashed["problems"][-1] == "boom"
