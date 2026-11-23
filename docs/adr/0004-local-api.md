# 0004: Local API and job queue

Date: 2026-11-20. Status: accepted.

## Shape

- **FastAPI on 127.0.0.1**, a port chosen by the OS, and a random bearer token. `openstems serve`
  prints one JSON line (`{"event": "listening", "port", "token", "pid"}`) and then serves. The
  launcher reads that line; nothing is written to disk.
- **Every route needs the token, including the health check.** The WebSocket and file URLs also
  accept it as a `token` query parameter, because a browser cannot set headers on those.
- **One WebSocket, `/v1/events`**, carries everything: a snapshot on connect, then `job.updated`,
  `job.progress`, `job.removed`, `jobs.order`, `model.progress`, `models.changed`,
  `settings.changed`, `stemsets.changed` and `worker.status`. Every event has a strictly
  increasing `seq`.
- **The worker is a separate process** (`multiprocessing`, spawn) fed by a queue. It owns the
  models and keeps the last one warm. The API process never imports torch.
- **Cancel is a shared integer**: the sequence number of the job to stop. The worker's cancel
  token compares it with its own job, so a late cancel can never hit the next job.
- **A dead worker is replaced.** The supervisor's pump thread notices the process is gone, marks
  the running job failed, starts a new worker, and the queue carries on.
- **Nothing outlives its parent.** `serve --parent-pid` exits when the launcher is gone, and the
  worker exits when the API process is gone, even if either was killed outright.

## State

- Manifests on disk are the source of truth. `index.sqlite` (in the cache folder) holds tracks,
  the job list and the stem sets, and `POST /v1/stemsets/rebuild` recreates the stem-set index
  from the manifests.
- The job list survives a restart. Jobs that were mid-flight when the engine stopped come back
  as failed; queued jobs stay queued.
- A batch keeps **one job per file**: the same path given twice is queued once.

## Files

`GET /v1/files?path=` serves a file with HTTP range support, and `GET /v1/peaks?path=` returns a
stem's peaks JSON. Both refuse any path outside the output folder and the indexed stem sets, so
the API cannot be used to read arbitrary files.

## Typed client

`openstems openapi --out openapi.json` writes the schema (committed as `engine/openapi.json`),
and the app turns it into `app/src/api/schema.d.ts` with openapi-typescript. The app talks to
the API through openapi-fetch, so requests and responses are checked against the schema at
compile time. A test fails if the committed schema drifts from the code.

## Deviations from the plan

- The plan lists `jobs (create, batch, cancel, retry, reorder)`. Also added: remove one finished
  job, clear all finished jobs, and get one job.
- Model downloads run on threads in the API process, not in the GPU worker, so a download never
  blocks a separation.
- Custom model import and the diagnostics export are API routes as well, for the app.
