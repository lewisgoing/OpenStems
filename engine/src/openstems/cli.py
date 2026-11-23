"""Command line entry point: doctor, models, recipes, separate, config, serve."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.progress import (
    BarColumn,
    DownloadColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TransferSpeedColumn,
)
from rich.table import Table

from openstems.cli_inputs import expand_inputs
from openstems.domain.errors import Cancelled, DomainError

app = typer.Typer(
    name="openstems",
    help="Local GPU stem separation.",
    no_args_is_help=True,
    add_completion=False,
    pretty_exceptions_show_locals=False,
)
models_app = typer.Typer(help="List, download and verify models.", no_args_is_help=True)
recipes_app = typer.Typer(help="List recipes.", no_args_is_help=True)
config_app = typer.Typer(help="Show or change settings.", no_args_is_help=True)
app.add_typer(models_app, name="models")
app.add_typer(recipes_app, name="recipes")
app.add_typer(config_app, name="config")
console = Console()


def _fail(message: str, code: int = 1) -> typer.Exit:
    console.print(f"[red]error:[/red] {message}")
    return typer.Exit(code=code)


def _size(n: int) -> str:
    return f"{n / 1024**3:.2f} GB" if n >= 1024**3 else f"{n / 1024**2:.0f} MB"


@app.callback()
def main() -> None:
    """Local GPU stem separation."""


@app.command()
def doctor() -> None:
    """Print the Python, PyTorch, GPU backend, GPU and FFmpeg status.

    Exits non-zero without a working GPU."""
    from openstems.doctor import run_doctor

    report = run_doctor()
    table = Table(show_header=False, box=None, pad_edge=False)
    table.add_column(style="bold")
    table.add_column()
    for key, value in report.lines():
        table.add_row(key, value)
    console.print(table)
    for problem in report.problems:
        console.print(f"[red]problem:[/red] {problem}")
    if not report.ok:
        raise typer.Exit(code=1)
    console.print("[green]ok[/green]")


@app.command()
def selftest(
    models: Annotated[
        list[str] | None,
        typer.Option(
            "--model", "-m", help="Model id to check (repeatable). Default: one per architecture."
        ),
    ] = None,
    seconds: Annotated[float, typer.Option(help="Length of the test signal.")] = 6.0,
    ops_only: Annotated[bool, typer.Option("--ops-only", help="Skip the model runs.")] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Check that the GPU computes what the CPU computes: single operations, then one short
    separation per model on both devices. Exits non-zero on any mismatch."""
    from openstems.domain.errors import DomainError
    from openstems.selftest import run_selftest

    def step(name: str) -> None:
        if not as_json:
            console.print(f"[dim]checking {name}[/dim]")

    try:
        report = run_selftest(models, seconds=seconds, with_models=not ops_only, on_step=step)
    except DomainError as exc:
        raise _fail(str(exc)) from exc
    if as_json:
        print(json.dumps(report.to_dict(), indent=2))
        raise typer.Exit(code=0 if report.ok else 1)

    backend = f"{report.gpu_backend or 'cpu'} {report.gpu_backend_version or ''}".strip()
    console.print(f"PyTorch {report.torch}, {backend}, {report.gpu_name or 'no GPU'}")
    if report.ops:
        table = Table(box=None, pad_edge=False)
        for column in ("operation", "result", "error vs CPU", ""):
            table.add_column(column)
        for op in report.ops:
            table.add_row(
                op.name,
                "[green]ok[/green]" if op.ok else "[red]FAILED[/red]",
                "-" if op.error is None else f"{op.error:.2e}",
                op.detail,
            )
        console.print(table)
    if report.models:
        table = Table(box=None, pad_edge=False)
        for column in ("model", "result", "GPU vs CPU", "half precision", "GPU", "CPU", ""):
            table.add_column(column)
        for m in report.models:
            table.add_row(
                m.id,
                "[green]ok[/green]" if m.ok else "[red]FAILED[/red]",
                "-" if m.difference_db is None else f"{m.difference_db:.1f} dB",
                "-" if m.half_precision_db is None else f"{m.half_precision_db:.1f} dB",
                "-" if m.gpu_seconds is None else f"{m.gpu_seconds:.1f} s",
                "-" if m.cpu_seconds is None else f"{m.cpu_seconds:.1f} s",
                m.detail,
            )
        console.print(table)
    for problem in report.problems:
        console.print(f"[red]problem:[/red] {problem}")
    if not report.ok:
        raise typer.Exit(code=1)
    console.print("[green]ok[/green]")


# -- models -------------------------------------------------------------------


@models_app.command("list")
def models_list(
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """List catalog models and whether each is installed."""
    from openstems.runtime import build_runtime

    rt = build_runtime()
    rows = [
        {
            "id": spec.id,
            "name": spec.name,
            "status": rt.store.status(spec),
            "bytes": spec.total_bytes,
            "stems": list(spec.stems),
            "license": spec.license,
            "seed": spec.seed,
        }
        for spec in rt.catalog
    ]
    if as_json:
        typer.echo(json.dumps(rows, indent=2))
        return
    table = Table(box=None, pad_edge=False)
    for column in ("id", "status", "size", "stems", "license"):
        table.add_column(column, style="bold" if column == "id" else None, no_wrap=column == "id")
    for row in rows:
        color = {"installed": "green", "missing": "dim"}.get(row["status"], "yellow")
        stems = ", ".join(row["stems"])
        table.add_row(
            row["id"],
            f"[{color}]{row['status']}[/{color}]",
            _size(row["bytes"]),
            stems if len(stems) < 48 else f"{len(row['stems'])} stems",
            row["license"],
        )
    console.print(table)
    console.print(f"[dim]models folder: {rt.store.root}[/dim]")


def _pick_models(rt, ids: list[str], model_set: str | None):
    if model_set == "seed":
        return rt.catalog.seed()
    if model_set == "all":
        return list(rt.catalog)
    if model_set:
        raise _fail(f"unknown set {model_set!r}; use 'seed' or 'all'")
    if not ids:
        raise _fail("name at least one model, or pass --set seed")
    try:
        return [rt.catalog.get(i) for i in ids]
    except DomainError as exc:
        raise _fail(str(exc)) from exc


@models_app.command("pull")
def models_pull(
    ids: Annotated[list[str] | None, typer.Argument(help="Model ids.")] = None,
    model_set: Annotated[
        str | None, typer.Option("--set", help="'seed' (the default set) or 'all'.")
    ] = None,
) -> None:
    """Download models with resume and sha256 verification."""
    from openstems.catalog.download import pull_model
    from openstems.runtime import build_runtime

    rt = build_runtime()
    specs = _pick_models(rt, ids or [], model_set)
    failed = 0
    with Progress(
        TextColumn("[bold]{task.description}"),
        BarColumn(),
        DownloadColumn(),
        TransferSpeedColumn(),
        console=console,
    ) as bar:
        for spec in specs:
            task = bar.add_task(spec.id, total=spec.total_bytes)
            try:
                pull_model(spec, rt.store, lambda d, t, task=task: bar.update(task, completed=d))
            except KeyboardInterrupt:
                bar.stop()
                console.print("cancelled; rerun to resume")
                raise typer.Exit(code=130) from None
            except DomainError as exc:
                failed += 1
                bar.console.print(f"[red]{spec.id}:[/red] {exc}")
    if failed:
        raise typer.Exit(code=1)
    console.print("[green]ok[/green]")


@models_app.command("verify")
def models_verify(
    ids: Annotated[list[str] | None, typer.Argument(help="Model ids (default: installed).")] = None,
) -> None:
    """Re-hash installed models against the catalog."""
    from openstems.runtime import build_runtime

    rt = build_runtime()
    if ids:
        specs = _pick_models(rt, ids, None)
    else:
        specs = [s for s in rt.catalog if rt.store.status(s) != "missing"]
    if not specs:
        console.print("no models installed")
        return
    bad = 0
    for spec in specs:
        problems = rt.store.verify(spec)
        if problems:
            bad += 1
            console.print(f"[red]FAIL[/red] {spec.id}: " + "; ".join(problems))
        else:
            console.print(f"[green]ok[/green]   {spec.id}")
    if bad:
        raise typer.Exit(code=1)


@models_app.command("check")
def models_check(
    ids: Annotated[list[str] | None, typer.Argument(help="Model ids (default: all).")] = None,
) -> None:
    """Liveness check: every catalog URL answers with the catalogued size."""
    from openstems.catalog.download import check_live
    from openstems.runtime import build_runtime

    rt = build_runtime()
    specs = _pick_models(rt, ids, None) if ids else [s for s in rt.catalog if not s.custom]
    bad = 0
    for spec in specs:
        problems = check_live(spec)
        if problems:
            bad += 1
            console.print(f"[red]DEAD[/red] {spec.id}: " + "; ".join(problems))
        else:
            console.print(f"[green]live[/green] {spec.id}")
    if bad:
        raise typer.Exit(code=1)


@models_app.command("import")
def models_import(
    checkpoint: Annotated[Path, typer.Argument(help="Local checkpoint file.")],
    config: Annotated[Path, typer.Option("--config", help="The model's YAML config.")],
    architecture: Annotated[
        str, typer.Option("--arch", help="bs_roformer, mel_band_roformer or mdx23c.")
    ],
    model_id: Annotated[str | None, typer.Option("--id", help="Catalog id.")] = None,
    name: Annotated[str | None, typer.Option("--name")] = None,
    yes: Annotated[bool, typer.Option("--yes", help="Skip the pickle warning.")] = False,
) -> None:
    """Import a local checkpoint as a custom model."""
    from openstems.catalog.custom import PICKLE_WARNING, import_model
    from openstems.runtime import build_runtime

    console.print(f"[yellow]warning:[/yellow] {PICKLE_WARNING}")
    if not yes and not typer.confirm("Import this checkpoint?"):
        raise typer.Exit(code=1)
    rt = build_runtime()
    try:
        spec = import_model(
            rt.store.root, checkpoint, config, architecture, model_id=model_id, name=name
        )
    except DomainError as exc:
        raise _fail(str(exc)) from exc
    console.print(f"[green]imported[/green] {spec.id}: stems {', '.join(spec.stems)}")


# -- recipes ------------------------------------------------------------------


@recipes_app.command("list")
def recipes_list() -> None:
    """List recipes and the stems each one writes."""
    from openstems.runtime import build_runtime

    rt = build_runtime()
    table = Table(box=None, pad_edge=False)
    for column in ("recipe", "models", "stems"):
        table.add_column(column, style="bold" if column == "recipe" else None)
    for recipe in rt.recipes.values():
        stems = ", ".join(o.name for o in recipe.outputs)
        table.add_row(
            recipe.id + (" [dim](experimental)[/dim]" if recipe.experimental else ""),
            ", ".join(recipe.model_ids),
            stems if len(stems) < 60 else f"{len(recipe.outputs)} stems",
        )
    console.print(table)


# -- separate -----------------------------------------------------------------


def _interrupt_on_termination() -> None:
    """Treat Ctrl+Break and termination like Ctrl+C, so the pipeline cleans up after itself."""
    import signal

    def handler(signum: int, frame: object) -> None:
        raise KeyboardInterrupt

    for name in ("SIGBREAK", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), handler)


@app.command()
def separate(
    files: Annotated[list[Path], typer.Argument(help="Audio or video files, or folders.")],
    recipe: Annotated[str | None, typer.Option("--recipe", "-r", help="Recipe id.")] = None,
    model: Annotated[
        str | None, typer.Option("--model", "-m", help="Run a single model instead of a recipe.")
    ] = None,
    quality: Annotated[
        str | None, typer.Option("--quality", "-q", help="fast, balanced or best.")
    ] = None,
    out: Annotated[Path | None, typer.Option("--out", "-o", help="Output root folder.")] = None,
    sum_to_mix: Annotated[
        bool | None,
        typer.Option("--sum-to-mix/--no-sum-to-mix", help="Fold the residual into 'other'."),
    ] = None,
    fmt: Annotated[
        str | None, typer.Option("--format", "-f", help="wav32f, wav24, flac or mp3.")
    ] = None,
    stems: Annotated[
        str | None, typer.Option("--stems", help="Comma-separated subset of output stems.")
    ] = None,
    match_source_rate: Annotated[
        bool | None, typer.Option("--match-source-rate/--no-match-source-rate")
    ] = None,
    trim_silence: Annotated[bool | None, typer.Option("--trim-silence/--no-trim-silence")] = None,
    normalize: Annotated[bool | None, typer.Option("--normalize/--no-normalize")] = None,
    midi: Annotated[
        str | None, typer.Option("--midi", help="Comma-separated stems to also write as MIDI.")
    ] = None,
    force: Annotated[bool, typer.Option("--force", help="Ignore the cache.")] = False,
) -> None:
    """Separate files into stems with a recipe or a single model."""
    from openstems.engines.base import CancelToken
    from openstems.runtime import build_runtime

    try:
        rt = build_runtime()
        chosen = rt.recipe(recipe, model)
        options = rt.options(
            quality=quality,
            sum_to_mix=sum_to_mix,
            output_format=fmt,
            match_source_rate=match_source_rate,
            trim_silence=trim_silence,
            normalize=normalize,
            outputs=[s.strip() for s in stems.split(",") if s.strip()] if stems else None,
            midi_stems=[s.strip() for s in midi.split(",") if s.strip()] if midi else None,
            force=force or None,
        )
        rt.pipeline.plan(chosen, options)  # fail early on missing models or bad options
    except DomainError as exc:
        raise _fail(str(exc)) from exc

    inputs = expand_inputs(files)
    if not inputs:
        raise _fail("no input files")
    _interrupt_on_termination()
    output_root = out or rt.settings.output_path
    cancel = CancelToken()
    failures = 0

    for source in inputs:
        started = time.perf_counter()
        with Progress(
            TextColumn("[bold]{task.fields[track]}"),
            BarColumn(),
            TextColumn("{task.percentage:>3.0f}%"),
            TimeElapsedColumn(),
            TextColumn("[dim]{task.description}"),
            console=console,
        ) as bar:
            task = bar.add_task("starting", total=1.0, track=source.name)

            def on_progress(p, bar=bar, task=task) -> None:
                bar.update(task, completed=p.fraction, description=p.message)

            try:
                result = rt.pipeline.run(source, chosen, output_root, options, on_progress, cancel)
            except KeyboardInterrupt:
                cancel.cancel()
                bar.stop()
                console.print("cancelled: no partial files were left behind")
                raise typer.Exit(code=130) from None
            except Cancelled:
                bar.stop()
                console.print("cancelled: no partial files were left behind")
                raise typer.Exit(code=130) from None
            except DomainError as exc:
                failures += 1
                bar.stop()
                console.print(f"[red]failed:[/red] {source.name}: {exc}")
                continue
        elapsed = time.perf_counter() - started
        note = "from cache" if result.cached else f"{elapsed:.1f}s"
        console.print(
            f"[green]done[/green] {source.name}: {len(result.stems)} stems ({note})\n"
            f"  {result.directory}"
        )
    if failures:
        raise typer.Exit(code=1)


# -- config -------------------------------------------------------------------


@config_app.command("show")
def config_show() -> None:
    """Print the current settings."""
    from openstems.settings import load_settings, settings_file

    console.print_json(json.dumps(load_settings().to_dict()))
    console.print(f"[dim]{settings_file()}[/dim]")


@config_app.command("set")
def config_set(key: str, value: str) -> None:
    """Change one setting, for example: config set models_dir D:\\models"""
    from openstems.settings import Settings, update_settings

    current = getattr(Settings(), key, None)
    if current is None:
        raise _fail(f"unknown setting {key!r}")
    parsed: object = value
    if isinstance(current, bool):
        parsed = value.lower() in ("1", "true", "yes", "on")
    elif isinstance(current, float):
        parsed = float(value)
    try:
        update_settings({key: parsed})
    except DomainError as exc:
        raise _fail(str(exc)) from exc
    console.print(f"{key} = {parsed}")


@app.command()
def serve(
    port: Annotated[int, typer.Option(help="Port (0 picks a free one).")] = 0,
    token: Annotated[str | None, typer.Option(help="Bearer token (default: random).")] = None,
    parent_pid: Annotated[int | None, typer.Option(help="Exit when this process is gone.")] = None,
) -> None:
    """Start the local API on 127.0.0.1. Prints one JSON line with the port and token."""
    from openstems.api.server import run_server

    run_server(port=port, token=token, parent_pid=parent_pid)


@app.command()
def openapi(
    out: Annotated[Path | None, typer.Option("--out", "-o", help="Write to a file.")] = None,
) -> None:
    """Print the API's OpenAPI document (used to generate the TypeScript client)."""
    from openstems.api.app import openapi_json

    text = openapi_json()
    if out is None:
        typer.echo(text, nl=False)
    else:
        out.write_text(text, encoding="utf-8", newline=chr(10))


if __name__ == "__main__":
    app()
