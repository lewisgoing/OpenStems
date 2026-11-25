"""The worker's idle rule: models stay warm between jobs, but not for ever. And how a job
that fails ends: the user's errors and cancels keep the process, anything else ends it."""

from __future__ import annotations

import queue
import sys
import threading
from types import SimpleNamespace
from typing import Any

import pytest

from openstems.domain.errors import Cancelled, DomainError
from openstems.engines.base import CancelToken
from openstems.engines.fake import PagingFileFull
from openstems.worker import process
from openstems.worker.process import (
    IDLE_UNLOAD_SECONDS,
    PAGING_FILE_NOTE,
    failure_message,
    idle_unload_seconds,
    next_command,
    run_job,
)

Commands = queue.Queue[tuple[str, ...]]


class Host:
    """Stands in for the model host: counts how often its models were unloaded."""

    def __init__(self) -> None:
        self.cleared = 0
        self.unloaded = threading.Event()

    def clear(self) -> None:
        self.cleared += 1
        self.unloaded.set()


def test_a_waiting_command_is_returned_and_the_models_stay_warm() -> None:
    commands: Commands = queue.Queue()
    commands.put(("run", "job"))
    host = Host()
    assert next_command(commands, host, idle_seconds=5) == ("run", "job")
    assert host.cleared == 0


def test_idle_models_are_unloaded_once_and_the_next_command_still_arrives() -> None:
    commands: Commands = queue.Queue()
    host = Host()

    def send_after_unload() -> None:
        assert host.unloaded.wait(10)
        commands.put(("shutdown",))

    threading.Thread(target=send_after_unload, daemon=True).start()
    assert next_command(commands, host, idle_seconds=0.05) == ("shutdown",)
    assert host.cleared == 1


def test_zero_keeps_models_warm_for_ever() -> None:
    commands: Commands = queue.Queue()
    host = Host()
    threading.Timer(0.2, commands.put, [("shutdown",)]).start()
    assert next_command(commands, host, idle_seconds=0) == ("shutdown",)
    assert host.cleared == 0


def test_the_idle_time_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENSTEMS_IDLE_UNLOAD_SECONDS", raising=False)
    assert idle_unload_seconds() == IDLE_UNLOAD_SECONDS == 600
    monkeypatch.setenv("OPENSTEMS_IDLE_UNLOAD_SECONDS", "90")
    assert idle_unload_seconds() == 90
    monkeypatch.setenv("OPENSTEMS_IDLE_UNLOAD_SECONDS", "0")
    assert idle_unload_seconds() == 0
    monkeypatch.setenv("OPENSTEMS_IDLE_UNLOAD_SECONDS", "soon")
    assert idle_unload_seconds() == IDLE_UNLOAD_SECONDS


# -- a job that fails --------------------------------------------------------------------


class Runtime:
    """Stands in for the worker's runtime: its pipeline raises what it is given."""

    def __init__(self, error: BaseException) -> None:
        def run(*_args: Any) -> Any:
            raise error

        self.settings = SimpleNamespace(output_path="out")
        self.pipeline = SimpleNamespace(run=run)

    def reload(self) -> None:
        pass

    def recipe(self, recipe_id: str) -> str:
        return recipe_id

    def options(self, **_overrides: Any) -> None:
        return None


def run_failing(error: BaseException) -> tuple[bool, list[tuple[Any, ...]]]:
    events: queue.Queue[tuple[Any, ...]] = queue.Queue()
    payload = {"id": "job", "track_path": "song.wav", "recipe_id": "full-song"}
    keeps = run_job(Runtime(error), payload, events, CancelToken())  # type: ignore[arg-type]
    return keeps, [events.get_nowait() for _ in range(events.qsize())]


def test_an_unexpected_error_ends_the_process_and_its_traceback_goes_with_it() -> None:
    keeps, events = run_failing(RuntimeError("CUDA error: an illegal memory access"))
    assert not keeps
    [(kind, job, message, trace, ending)] = events
    assert (kind, job, ending) == ("failed", "job", True)
    assert message == "RuntimeError: CUDA error: an illegal memory access"
    assert trace.startswith("Traceback") and "illegal memory access" in trace


def test_the_users_errors_and_cancels_keep_the_process() -> None:
    keeps, events = run_failing(DomainError("no such file: song.wav"))
    assert keeps and events == [("failed", "job", "no such file: song.wav", None, False)]
    keeps, events = run_failing(Cancelled("cancelled"))
    assert keeps and events == [("cancelled", "job")]


def test_a_full_paging_file_says_what_to_do() -> None:
    """Windows' own words name a DLL deep inside PyTorch (`engines.fake.PagingFileFull`)."""
    error = PagingFileFull(
        "[WinError 1455] The paging file is too small for this operation to complete. Error "
        'loading "C:\\...\\torch\\lib\\cublasLt64_13.dll" or one of its dependencies.'
    )
    assert failure_message(error) == PAGING_FILE_NOTE
    assert "paging file is full" in PAGING_FILE_NOTE and "C:" in PAGING_FILE_NOTE
    assert failure_message(OSError(28, "No space left on device")) == (
        "OSError: [Errno 28] No space left on device"
    )


PAGING_WORDS = "The paging file is too small for this operation to complete."


def test_a_dll_python_loads_itself_has_only_windows_words(monkeypatch: pytest.MonkeyPatch) -> None:
    """The DLL behind `torch._C` fails as an ImportError, with no code: its sentence counts."""
    monkeypatch.setattr(process, "windows_words", lambda code: PAGING_WORDS if code == 1455 else "")
    error = ImportError(f"DLL load failed while importing _C: {PAGING_WORDS}")
    assert failure_message(error) == PAGING_FILE_NOTE
    other = ImportError("DLL load failed while importing _C: The specified module was not found.")
    assert failure_message(other).startswith("ImportError: DLL load failed")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows' sentence for its own error code")
def test_windows_gives_its_sentence_for_the_error() -> None:
    assert process.windows_words(1455)  # in the machine's language
    assert process.paging_file_full(ImportError(f"importing _C: {process.windows_words(1455)}"))


def test_elsewhere_there_is_no_windows_sentence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    assert process.windows_words(1455) == ""
    assert not process.paging_file_full(ImportError("DLL load failed while importing _C: "))
