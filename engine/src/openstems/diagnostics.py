"""Export diagnostics: one zip with system info, settings, model status, the last GPU
self-test and recent logs."""

from __future__ import annotations

import json
import time
import zipfile
from pathlib import Path
from typing import Any


def export_diagnostics(service: Any, target_dir: Path | None = None) -> Path:
    """Write ``openstems-diagnostics-<time>.zip``. Holds no audio and no model weights."""
    settings = service.runtime.settings
    folder = target_dir or settings.logs_path
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"openstems-diagnostics-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    models = service.models()
    payload = {
        "system": service.system(),
        "settings": settings.to_dict(),
        "models": [
            {"id": m["id"], "status": m["status"], "bytes": m["bytes"]} for m in models["models"]
        ],
        "recipes": [r["id"] for r in service.recipes()],
        "jobs": [
            {k: j[k] for k in ("id", "recipe_id", "quality", "state", "error", "cached")}
            for j in service.jobs.list()
        ],
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("diagnostics.json", json.dumps(payload, indent=2, default=str))
        selftest = settings.logs_path / "selftest.json"
        if selftest.is_file():  # the last GPU self-test, when one was run
            archive.write(selftest, "selftest.json")
        if settings.logs_path.is_dir():
            for log in sorted(settings.logs_path.glob("*.log*")):
                try:
                    archive.write(log, f"logs/{log.name}")
                except OSError:
                    continue
    return path
