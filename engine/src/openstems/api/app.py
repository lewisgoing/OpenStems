"""The local HTTP API: everything the CLI does, with live progress over one WebSocket.

It binds to 127.0.0.1 only and every request needs the bearer token.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import secrets
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from openstems import __version__
from openstems.api import schemas as s
from openstems.api.jobs import JobNotFound
from openstems.api.links import LinkNotFound
from openstems.api.service import Service
from openstems.domain.errors import DomainError
from openstems.engines.host import fake_mode

FILE_CHUNK = 256 * 1024
_bearer = HTTPBearer(auto_error=False)


def _service(request: Request) -> Service:
    return request.app.state.service


# Module level on purpose: with postponed annotations FastAPI resolves names from here.
Svc = Annotated[Service, Depends(_service)]


def _operation_id(route: APIRoute) -> str:
    return route.name


def create_app(token: str, service: Service | None = None) -> FastAPI:
    """Build the app. ``service`` is injectable for tests."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        svc: Service = app.state.service or Service()
        app.state.service = svc
        svc.bus.bind(asyncio.get_running_loop())
        await asyncio.to_thread(svc.start)
        try:
            yield
        finally:
            await asyncio.to_thread(svc.stop)

    app = FastAPI(
        title="OpenStems local API",
        version=__version__,
        lifespan=lifespan,
        generate_unique_id_function=_operation_id,
    )
    app.state.service = service
    app.state.token = token
    # `pnpm dev` serves the interface from a local web server, which is another origin than
    # this API, so the browser asks permission before each call. The app sets this to that
    # server's address in development only; the built app loads files and never asks.
    dev_origin = os.environ.get("OPENSTEMS_DEV_ORIGIN", "")
    if dev_origin:
        app.add_middleware(
            CORSMiddleware, allow_origins=[dev_origin], allow_methods=["*"], allow_headers=["*"]
        )

    def check_token(candidate: str | None) -> bool:
        return bool(candidate) and secrets.compare_digest(candidate or "", token)

    def auth(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
        query_token: Annotated[str | None, Query(alias="token", include_in_schema=False)] = None,
    ) -> None:
        supplied = credentials.credentials if credentials else query_token
        if not check_token(supplied):
            raise HTTPException(401, "missing or wrong token", {"WWW-Authenticate": "Bearer"})

    secured = [Depends(auth)]
    errors: dict[int | str, dict[str, Any]] = {
        400: {"model": s.ErrorBody},
        401: {"model": s.ErrorBody},
        404: {"model": s.ErrorBody},
    }

    @app.exception_handler(JobNotFound)
    async def _not_found(request: Request, exc: JobNotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(LinkNotFound)
    async def _no_link(request: Request, exc: LinkNotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(DomainError)
    async def _domain_error(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=400)

    # -- system ---------------------------------------------------------------

    @app.get("/v1/health", response_model=s.Health, dependencies=secured, responses=errors)
    def health() -> dict[str, Any]:
        return {"status": "ok", "version": __version__, "fake_engine": fake_mode()}

    @app.get("/v1/system", response_model=s.SystemInfo, dependencies=secured, responses=errors)
    def system(service: Svc) -> dict[str, Any]:
        return service.system()

    @app.post(
        "/v1/diagnostics", response_model=s.Diagnostics, dependencies=secured, responses=errors
    )
    def export_diagnostics(service: Svc) -> dict[str, Any]:
        from openstems.diagnostics import export_diagnostics as export

        return {"path": str(export(service))}

    @app.post("/v1/selftest", response_model=s.SelfTest, dependencies=secured, responses=errors)
    def run_selftest(service: Svc) -> dict[str, Any]:
        """Compare the GPU with the CPU. Takes a minute or two; refused while a job runs."""
        return service.selftest()

    # -- tracks ---------------------------------------------------------------

    @app.post("/v1/tracks", response_model=s.TrackList, dependencies=secured, responses=errors)
    def register_tracks(body: s.RegisterTracks, service: Svc) -> dict[str, Any]:
        return {"tracks": service.register_tracks(body.paths)}

    # -- recipes --------------------------------------------------------------

    @app.get("/v1/recipes", response_model=s.RecipeList, dependencies=secured, responses=errors)
    def list_recipes(service: Svc) -> dict[str, Any]:
        return {"recipes": service.recipes()}

    # -- models ---------------------------------------------------------------

    @app.get("/v1/models", response_model=s.ModelList, dependencies=secured, responses=errors)
    def list_models(service: Svc) -> dict[str, Any]:
        return service.models()

    @app.post(
        "/v1/models/import", response_model=s.ModelInfo, dependencies=secured, responses=errors
    )
    def import_model(body: s.ImportModel, service: Svc) -> dict[str, Any]:
        from openstems.catalog.custom import PICKLE_WARNING
        from openstems.catalog.custom import import_model as do_import

        if not body.acknowledge_pickle_risk:
            raise DomainError(PICKLE_WARNING)
        spec = do_import(
            service.runtime.store.root,
            Path(body.checkpoint),
            Path(body.config),
            body.architecture,
            model_id=body.id,
            name=body.name,
        )
        service.reload()
        service.bus.publish("models.changed", id=spec.id)
        return service.model_info(spec.id)

    @app.post(
        "/v1/models/{model_id}/pull",
        response_model=s.ModelInfo,
        dependencies=secured,
        responses=errors,
    )
    def pull_model(model_id: str, service: Svc) -> dict[str, Any]:
        spec = service.runtime.catalog.get(model_id)
        service.downloads.start(spec, service.runtime.store)
        return service.model_info(model_id)

    @app.post(
        "/v1/models/{model_id}/cancel",
        response_model=s.ModelInfo,
        dependencies=secured,
        responses=errors,
    )
    def cancel_pull(model_id: str, service: Svc) -> dict[str, Any]:
        service.runtime.catalog.get(model_id)
        service.downloads.cancel(model_id)
        return service.model_info(model_id)

    @app.post(
        "/v1/models/{model_id}/verify",
        response_model=s.VerifyResult,
        dependencies=secured,
        responses=errors,
    )
    def verify_model(model_id: str, service: Svc) -> dict[str, Any]:
        spec = service.runtime.catalog.get(model_id)
        problems = service.runtime.store.verify(spec)
        service.bus.publish("models.changed", id=model_id)
        return {"id": model_id, "ok": not problems, "problems": problems}

    @app.delete(
        "/v1/models/{model_id}", response_model=s.ModelInfo, dependencies=secured, responses=errors
    )
    def delete_model(model_id: str, service: Svc) -> dict[str, Any]:
        info = service.model_info(model_id)
        service.delete_model(model_id)
        info.update(status="missing", download=None)
        return info

    # -- jobs -----------------------------------------------------------------

    @app.get("/v1/jobs", response_model=s.JobList, dependencies=secured, responses=errors)
    def list_jobs(service: Svc) -> dict[str, Any]:
        return {"jobs": service.jobs.list()}

    @app.post("/v1/jobs", response_model=s.JobInfo, dependencies=secured, responses=errors)
    def create_job(body: s.CreateJob, service: Svc) -> dict[str, Any]:
        return service.create_job(
            body.path, body.recipe, body.model, body.quality, body.options.model_dump(), body.start
        )

    @app.post("/v1/jobs/batch", response_model=s.JobList, dependencies=secured, responses=errors)
    def create_batch(body: s.CreateBatch, service: Svc) -> dict[str, Any]:
        from openstems.cli_inputs import expand_inputs

        paths = expand_inputs([Path(p) for p in body.paths])
        if not paths:
            raise DomainError("no media files in the request")
        options = body.options.model_dump()
        # Validate the recipe once before queuing anything.
        service.resolve_recipe(body.recipe, body.model)
        jobs = [
            service.create_job(str(p), body.recipe, body.model, body.quality, options, body.start)
            for p in paths
        ]
        return {"jobs": jobs}

    @app.post("/v1/jobs/start", response_model=s.JobList, dependencies=secured, responses=errors)
    def start_jobs(service: Svc) -> dict[str, Any]:
        """Start every job that is waiting for the user's Start."""
        return {"jobs": service.jobs.release()}

    @app.post("/v1/jobs/reorder", response_model=s.JobList, dependencies=secured, responses=errors)
    def reorder_jobs(body: s.Reorder, service: Svc) -> dict[str, Any]:
        return {"jobs": service.jobs.reorder(body.ids)}

    @app.post(
        "/v1/jobs/clear-finished", response_model=s.Removed, dependencies=secured, responses=errors
    )
    def clear_finished_jobs(service: Svc) -> dict[str, Any]:
        return {"removed": service.jobs.clear_finished()}

    @app.get("/v1/jobs/{job_id}", response_model=s.JobInfo, dependencies=secured, responses=errors)
    def get_job(job_id: str, service: Svc) -> dict[str, Any]:
        return service.jobs.get(job_id)

    @app.post(
        "/v1/jobs/{job_id}/start", response_model=s.JobInfo, dependencies=secured, responses=errors
    )
    def start_job(job_id: str, service: Svc) -> dict[str, Any]:
        """Start one job that is waiting for the user's Start."""
        service.jobs.release(job_id)
        return service.jobs.get(job_id)

    @app.post(
        "/v1/jobs/{job_id}/cancel", response_model=s.JobInfo, dependencies=secured, responses=errors
    )
    def cancel_job(job_id: str, service: Svc) -> dict[str, Any]:
        return service.jobs.cancel(job_id)

    @app.post(
        "/v1/jobs/{job_id}/retry", response_model=s.JobInfo, dependencies=secured, responses=errors
    )
    def retry_job(job_id: str, service: Svc) -> dict[str, Any]:
        return service.jobs.retry(job_id)

    @app.post(
        "/v1/jobs/{job_id}/analysis",
        response_model=s.JobInfo,
        dependencies=secured,
        responses=errors,
    )
    def set_job_analysis(job_id: str, body: s.SetAnalysis, service: Svc) -> dict[str, Any]:
        """Set a job's tempo and key by hand: before it runs, or on its finished stems."""
        return service.set_job_analysis(job_id, body.model_dump(exclude_unset=True))

    @app.delete(
        "/v1/jobs/{job_id}", response_model=s.Removed, dependencies=secured, responses=errors
    )
    def remove_job(job_id: str, service: Svc) -> dict[str, Any]:
        service.jobs.remove(job_id)
        return {"removed": 1}

    # -- links ----------------------------------------------------------------

    @app.get("/v1/links", response_model=s.LinkList, dependencies=secured, responses=errors)
    def list_links(service: Svc) -> dict[str, Any]:
        """Songs being fetched from links, and the ones whose fetch failed."""
        return {"links": service.links.list()}

    @app.post("/v1/links", response_model=s.LinkInfo, dependencies=secured, responses=errors)
    def create_link(body: s.CreateLink, service: Svc) -> dict[str, Any]:
        """Fetch the song behind a link. Once it is here it is queued like a dropped file."""
        return service.add_link(
            body.url, body.recipe, body.model, body.quality, body.options.model_dump(), body.start
        )

    @app.post(
        "/v1/links/{link_id}/retry",
        response_model=s.LinkInfo,
        dependencies=secured,
        responses=errors,
    )
    def retry_link(link_id: str, service: Svc) -> dict[str, Any]:
        return service.links.retry(link_id)

    @app.delete(
        "/v1/links/{link_id}", response_model=s.Removed, dependencies=secured, responses=errors
    )
    def remove_link(link_id: str, service: Svc) -> dict[str, Any]:
        """Cancel a fetch that is under way, or dismiss one that failed."""
        service.links.remove(link_id)
        return {"removed": 1}

    # -- mixes ----------------------------------------------------------------

    @app.post("/v1/mixes", response_model=s.MixInfo, dependencies=secured, responses=errors)
    def create_mix(body: s.CreateMix, service: Svc) -> dict[str, Any]:
        """Write some of a song's stems as one file, next to them."""
        return service.mix(body.paths)

    # -- settings -------------------------------------------------------------

    @app.get("/v1/settings", response_model=s.SettingsModel, dependencies=secured, responses=errors)
    def get_settings(service: Svc) -> dict[str, Any]:
        return service.runtime.settings.to_dict()

    @app.patch(
        "/v1/settings", response_model=s.SettingsModel, dependencies=secured, responses=errors
    )
    def patch_settings(body: s.SettingsPatch, service: Svc) -> dict[str, Any]:
        return service.patch_settings(body.model_dump(exclude_none=True))

    # -- history --------------------------------------------------------------

    @app.get("/v1/stemsets", response_model=s.StemSetList, dependencies=secured, responses=errors)
    def list_stem_sets(service: Svc, q: str = "") -> dict[str, Any]:
        return {"stem_sets": service.stem_sets(q)}

    @app.post(
        "/v1/stemsets/analysis",
        response_model=s.StemSetInfo,
        dependencies=secured,
        responses=errors,
    )
    def set_stem_set_analysis(body: s.SetStemSetAnalysis, service: Svc) -> dict[str, Any]:
        """Set the tempo and key of a song's finished stems by hand."""
        changes = body.model_dump(exclude_unset=True)
        return service.set_analysis(changes.pop("directory"), changes)

    @app.post(
        "/v1/stemsets/rebuild", response_model=s.Rebuilt, dependencies=secured, responses=errors
    )
    def rebuild_index(service: Svc) -> dict[str, Any]:
        count = service.index.rebuild(service.runtime.settings.output_path)
        service.bus.publish("stemsets.changed")
        return {"stem_sets": count}

    # -- files ----------------------------------------------------------------

    def served_file(service: Service, path: str) -> Path:
        target = Path(path)
        if not service.is_served(target) or not target.is_file():
            raise HTTPException(404, "no such file in the output folders")
        return target

    @app.get(
        "/v1/files",
        dependencies=secured,
        responses={**errors, 200: {"content": {"audio/*": {}}}, 206: {"description": "Partial"}},
    )
    def get_file(request: Request, service: Svc, path: str) -> Response:
        """Serve an output file. Supports HTTP range requests for audio."""
        target = served_file(service, path)
        size = target.stat().st_size
        media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
        header = request.headers.get("range")
        start, end, status = 0, size - 1, 200
        if header and header.startswith("bytes="):
            first, _, last = header[6:].split(",")[0].strip().partition("-")
            try:
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                else:  # suffix range: the last N bytes
                    start = max(0, size - int(last))
            except ValueError:
                raise HTTPException(416, "bad range") from None
            if start > end or start >= size:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            status = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)

        def stream() -> Iterator[bytes]:
            with target.open("rb") as handle:
                handle.seek(start)
                left = end - start + 1
                while left > 0:
                    block = handle.read(min(FILE_CHUNK, left))
                    if not block:
                        return
                    left -= len(block)
                    yield block

        return StreamingResponse(stream(), status_code=status, media_type=media, headers=headers)

    @app.get("/v1/peaks", response_model=s.Peaks, dependencies=secured, responses=errors)
    def get_peaks(service: Svc, path: str) -> Any:
        """The peaks JSON written next to a stem."""
        target = served_file(service, path)
        try:
            return json.loads(target.read_text("utf-8"))
        except ValueError:
            raise HTTPException(404, "not a peaks file") from None

    # -- events ---------------------------------------------------------------

    @app.websocket("/v1/events")
    async def events(ws: WebSocket) -> None:
        """One WebSocket for everything: a snapshot, then job and download events."""
        supplied = ws.query_params.get("token")
        header = ws.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            supplied = header[7:]
        if not check_token(supplied):
            await ws.close(code=4401)
            return
        service: Service = ws.app.state.service
        await ws.accept()
        queue = service.bus.subscribe()
        try:
            await ws.send_json(
                {
                    "type": "snapshot",
                    "seq": 0,
                    "jobs": service.jobs.list(),
                    "links": service.links.list(),
                    "worker": service.jobs.worker_status,
                }
            )

            # A reader task notices the client going away; the loop forwards bus events.
            async def read_until_closed() -> None:
                try:
                    while True:
                        await ws.receive_text()
                except (WebSocketDisconnect, RuntimeError):
                    return

            reader = asyncio.ensure_future(read_until_closed())
            try:
                while not reader.done():
                    get = asyncio.ensure_future(queue.get())
                    done, _ = await asyncio.wait({get, reader}, return_when=asyncio.FIRST_COMPLETED)
                    if get in done:
                        await ws.send_json(get.result())
                    else:
                        get.cancel()
            finally:
                reader.cancel()
        except (WebSocketDisconnect, RuntimeError):
            return
        finally:
            service.bus.unsubscribe(queue)

    return app


def openapi_json() -> str:
    """The OpenAPI document, for generating the TypeScript client."""
    app = create_app("unused", service=None)
    return json.dumps(app.openapi(), indent=2, sort_keys=True) + os.linesep
