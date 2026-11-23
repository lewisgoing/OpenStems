"""Phase 3 acceptance against the real engine: batch, cancel, worker kill, token.

Usage (from engine/):
    uv run python ../scripts/accept_api.py FILE FILE FILE FILE FILE

Starts `openstems serve` with a temporary output folder, then checks that:
  1. requests without the token are rejected;
  2. a batch of files runs in order, one at a time, with ordered progress events;
  3. cancelling the running job lets the next job start and finish;
  4. killing the worker mid-job leaves the API up, fails the job and restarts the worker.
"""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

import httpx
from websockets.sync.client import connect


def kill(pid: int) -> None:
    """Kill a process outright, the way a crash would."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, check=False)
    else:
        import signal

        os.kill(pid, signal.SIGKILL)


def main() -> int:
    songs = sys.argv[1:]
    if len(set(songs)) < 5:
        print("give five different files: a batch keeps one job per file")
        return 2
    batch = songs[:5]
    out = tempfile.mkdtemp(prefix="openstems-api-accept-")
    env = {**os.environ, "OPENSTEMS_OUTPUT_DIR": out, "PYTHONUTF8": "1"}
    server = subprocess.Popen(
        [sys.executable, "-m", "openstems.cli", "serve"], stdout=subprocess.PIPE, text=True, env=env
    )
    assert server.stdout is not None
    hello = json.loads(server.stdout.readline())
    base = f"http://127.0.0.1:{hello['port']}"
    client = httpx.Client(
        base_url=base, headers={"Authorization": f"Bearer {hello['token']}"}, timeout=60
    )
    events: list[dict] = []
    ok = True

    def check(name: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        ok &= passed
        print(f"{'ok  ' if passed else 'FAIL'} {name}{': ' + detail if detail else ''}", flush=True)

    def listen() -> None:
        try:
            with connect(f"ws://127.0.0.1:{hello['port']}/v1/events?token={hello['token']}") as ws:
                for message in ws:
                    events.append(json.loads(message))
        except Exception:
            pass

    def jobs() -> list[dict]:
        return client.get("/v1/jobs").json()["jobs"]

    def wait(predicate, timeout: float = 600.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = jobs()
            if predicate(current):
                return current
            time.sleep(0.2)
        raise TimeoutError([(j["track_name"], j["state"]) for j in jobs()])

    def terminal(current: list[dict]) -> bool:
        return bool(current) and all(j["state"] in ("done", "failed", "cancelled") for j in current)

    try:
        for _ in range(300):
            try:
                if client.get("/v1/health").status_code == 200:
                    break
            except httpx.TransportError:
                time.sleep(0.2)
        client.post("/v1/jobs/clear-finished")
        threading.Thread(target=listen, daemon=True).start()
        deadline = time.monotonic() + 120
        while not client.get("/v1/system").json()["worker"]["ready"]:
            assert time.monotonic() < deadline, "worker did not become ready"
            time.sleep(0.2)

        # 1. token
        check("no token is rejected", httpx.get(f"{base}/v1/jobs").status_code == 401)

        # 2. batch of five, fast preset; every job is forced so none comes from the cache
        body = {
            "paths": batch,
            "recipe": "full-song",
            "quality": "fast",
            "options": {"force": True},
        }
        ids = [j["id"] for j in client.post("/v1/jobs/batch", json=body).json()["jobs"]]
        # Jobs from an earlier session are restored on start: look only at this batch.
        done = [j for j in wait(terminal) if j["id"] in ids]
        check(
            "batch of five finished",
            [j["state"] for j in done] == ["done"] * 5,
            ", ".join(f"{j['track_name']}: {j['error'] or j['state']}" for j in done),
        )
        seqs = [e["seq"] for e in events]
        check("event sequence is strictly increasing", seqs == sorted(set(seqs)))
        per_job = {
            i: [e["progress"] for e in events if e["type"] == "job.progress" and e["id"] == i]
            for i in ids
        }
        check(
            "progress per job never goes backwards",
            all(p and p == sorted(p) for p in per_job.values()),
            f"{sum(len(p) for p in per_job.values())} progress events",
        )
        finished = {
            e["job"]["id"]: e["seq"]
            for e in events
            if e["type"] == "job.updated" and e["job"]["state"] == "done"
        }
        started = {}
        for e in events:
            if e["type"] == "job.progress":
                started.setdefault(e["id"], e["seq"])
        check(
            "one job at a time, in order",
            all(finished[a] < started[b] for a, b in itertools.pairwise(ids)),
        )
        client.post("/v1/jobs/clear-finished")

        # 3. cancel the running job; the next one must run
        body = {
            "paths": batch[:2],
            "recipe": "full-song",
            "quality": "balanced",
            "options": {"force": True},
        }
        first, second = (j["id"] for j in client.post("/v1/jobs/batch", json=body).json()["jobs"])
        wait(lambda js: js[0]["state"] == "running" and js[0]["progress"] > 0.15)
        t0 = time.monotonic()
        client.post(f"/v1/jobs/{first}/cancel")
        wait(lambda js: js[0]["state"] == "cancelled")
        took = time.monotonic() - t0
        result = {j["id"]: j["state"] for j in wait(terminal)}
        check("cancelled job stops", result[first] == "cancelled", f"{took:.1f}s to stop")
        check("the next job then runs to completion", result[second] == "done")
        client.post("/v1/jobs/clear-finished")

        # 4. kill the worker mid-job
        body = {
            "path": batch[0],
            "recipe": "full-song",
            "quality": "balanced",
            "options": {"force": True},
        }
        victim = client.post("/v1/jobs", json=body).json()["id"]
        wait(lambda js: js[0]["state"] == "running" and js[0]["progress"] > 0.15)
        old_pid = client.get("/v1/system").json()["worker"]["pid"]
        kill(old_pid)
        failed = wait(terminal)[0]
        check(
            "job is marked failed",
            failed["id"] == victim and failed["state"] == "failed",
            failed["error"] or "",
        )
        check("the API stayed up", client.get("/v1/health").status_code == 200)
        deadline = time.monotonic() + 120
        status = client.get("/v1/system").json()["worker"]
        while not status["ready"] and time.monotonic() < deadline:
            time.sleep(0.3)
            status = client.get("/v1/system").json()["worker"]
        check(
            "the worker restarted",
            status["ready"] and status["pid"] != old_pid and status["restarts"] == 1,
            f"pid {old_pid} -> {status['pid']}",
        )
        again = client.post(f"/v1/jobs/{victim}/retry").json()["id"]
        check(
            "the retried job completes",
            {j["id"]: j["state"] for j in wait(terminal)}[again] == "done",
        )
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
    print("outputs in", out)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
