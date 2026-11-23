"""`openstems serve`: run the API on 127.0.0.1 with a random port and a bearer token."""

from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import sys
import threading
import time
from logging.handlers import RotatingFileHandler

import uvicorn

from openstems.api.app import create_app
from openstems.procutil import process_alive
from openstems.settings import load_settings

HOST = "127.0.0.1"


def _watch_parent(pid: int, server: uvicorn.Server) -> None:
    """Stop the engine when the app that started it is gone, so nothing is left running."""
    while process_alive(pid):
        time.sleep(1.0)
    server.should_exit = True
    time.sleep(8.0)
    os._exit(0)  # the graceful path did not finish in time


def _setup_logging() -> None:
    logs = load_settings().logs_path
    try:
        logs.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            logs / "engine.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root = logging.getLogger()
        root.addHandler(handler)
        root.setLevel(logging.INFO)
    except OSError:
        pass


def run_server(port: int = 0, token: str | None = None, parent_pid: int | None = None) -> None:
    token = token or os.environ.get("OPENSTEMS_TOKEN") or secrets.token_urlsafe(32)
    _setup_logging()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind((HOST, port))  # port 0: the OS picks a free port
    actual_port = sock.getsockname()[1]

    config = uvicorn.Config(
        create_app(token),
        host=HOST,
        port=actual_port,
        log_level="warning",
        access_log=False,
        ws_ping_interval=20,
    )
    server = uvicorn.Server(config)

    # One JSON line on stdout tells the launcher where the API is and how to talk to it.
    print(
        json.dumps({"event": "listening", "port": actual_port, "token": token, "pid": os.getpid()}),
        flush=True,
    )
    if parent_pid:
        threading.Thread(target=_watch_parent, args=(parent_pid, server), daemon=True).start()
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.flush()
