"""The worker's idle rule: models stay warm between jobs, but not for ever."""

from __future__ import annotations

import queue
import threading

import pytest

from openstems.worker.process import IDLE_UNLOAD_SECONDS, idle_unload_seconds, next_command

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
