"""SQLite index of tracks, jobs and stem sets.

Manifests on disk are the source of truth. This index only makes them quick to list and
search, and it can be rebuilt at any time by scanning the output folders.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from openstems.domain.stem import MANIFEST_NAME
from openstems.pipeline.run import SAMPLE_RATE, read_manifest

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    info TEXT NOT NULL,
    added_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS stem_sets (
    directory TEXT PRIMARY KEY,
    track_name TEXT NOT NULL,
    track_path TEXT NOT NULL,
    track_hash TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    recipe_name TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    stems TEXT NOT NULL,
    analysis TEXT NOT NULL,
    part TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS stem_sets_name ON stem_sets (track_name);
"""
# Columns added since the first version, for an index that was made before them.
_ADDED = {"stem_sets": {"part": "TEXT NOT NULL DEFAULT ''"}}


class Index:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(SCHEMA)
            for table, columns in _ADDED.items():
                have = {row[1] for row in self._db.execute(f"PRAGMA table_info({table})")}
                for column, kind in columns.items():
                    if column not in have:
                        self._db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # -- tracks ---------------------------------------------------------------

    def save_track(self, path: str, name: str, info: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO tracks (path, name, info, added_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET name = excluded.name, info = excluded.info",
                (path, name, json.dumps(info), time.time()),
            )
            self._db.commit()

    def tracks(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM tracks ORDER BY added_at DESC").fetchall()
        return [{"path": r["path"], "name": r["name"], **json.loads(r["info"])} for r in rows]

    # -- jobs -----------------------------------------------------------------

    def save_job(self, job_id: str, position: int, data: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO jobs (id, position, data, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET position = excluded.position, "
                "data = excluded.data, updated_at = excluded.updated_at",
                (job_id, position, json.dumps(data), time.time()),
            )
            self._db.commit()

    def delete_job(self, job_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
            self._db.commit()

    def jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT data FROM jobs ORDER BY position").fetchall()
        return [json.loads(r["data"]) for r in rows]

    # -- stem sets ------------------------------------------------------------

    def save_stem_set(self, directory: str, manifest: dict[str, Any]) -> None:
        source = manifest.get("source", {})
        recipe = manifest.get("recipe", {})
        stems = [
            {
                "name": s["name"],
                "file": s["file"],
                "peaks": s.get("peaks"),
                "midi": s.get("midi"),
                "samples": s.get("samples"),
                "sample_rate": s.get("sample_rate"),
                "group": s.get("group") or None,
                "offset": int(s.get("offset") or 0),
            }
            for s in manifest.get("stems", [])
        ]
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO stem_sets (directory, track_name, track_path, "
                "track_hash, recipe_id, recipe_name, cache_key, created_at, stems, analysis, "
                "part) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    directory,
                    source.get("name", ""),
                    source.get("path", ""),
                    source.get("sha256", ""),
                    recipe.get("id", ""),
                    recipe.get("name", ""),
                    manifest.get("cache_key", ""),
                    manifest.get("created_at", ""),
                    json.dumps(stems),
                    json.dumps(manifest.get("analysis") or {}),
                    # The part of the song, when only a part of it was separated.
                    json.dumps(source["range"]) if source.get("range") else "",
                ),
            )
            self._db.commit()

    def delete_stem_set(self, directory: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM stem_sets WHERE directory = ?", (directory,))
            self._db.commit()

    def stem_sets(self, query: str = "", limit: int = 200) -> list[dict[str, Any]]:
        sql = "SELECT * FROM stem_sets"
        args: list[Any] = []
        if query.strip():
            sql += " WHERE track_name LIKE ? ESCAPE '\\' OR recipe_id LIKE ? ESCAPE '\\'"
            like = "%" + query.strip().replace("\\", "\\\\").replace("%", "\\%") + "%"
            args += [like, like]
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [_stem_set_row(r) for r in rows]

    def stem_set(self, directory: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM stem_sets WHERE directory = ?", (directory,)
            ).fetchone()
        return _stem_set_row(row) if row is not None else None

    def stem_set_dirs(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self._db.execute("SELECT directory FROM stem_sets")]

    def track_paths(self) -> list[str]:
        """The song file of every indexed stem set."""
        with self._lock:
            return [r[0] for r in self._db.execute("SELECT DISTINCT track_path FROM stem_sets")]

    # -- rebuild --------------------------------------------------------------

    def rebuild(self, output_root: Path) -> int:
        """Drop the stem-set index and rebuild it by scanning manifests under the output
        folder. Entries whose folder is gone disappear; nothing on disk is touched."""
        found: list[tuple[str, dict[str, Any]]] = []
        if output_root.is_dir():
            for manifest_path in output_root.glob(f"*/*/{MANIFEST_NAME}"):
                manifest = read_manifest(manifest_path.parent)
                if manifest and manifest.get("complete"):
                    found.append((str(manifest_path.parent), manifest))
        with self._lock:
            self._db.execute("DELETE FROM stem_sets")
            self._db.commit()
        for directory, manifest in found:
            self.save_stem_set(directory, manifest)
        return len(found)

    def prune_missing(self) -> int:
        """Forget stem sets whose manifest no longer exists on disk."""
        gone = [d for d in self.stem_set_dirs() if not (Path(d) / MANIFEST_NAME).is_file()]
        for directory in gone:
            self.delete_stem_set(directory)
        return len(gone)


def _stem_set_row(row: sqlite3.Row) -> dict[str, Any]:
    directory = row["directory"]
    stems = json.loads(row["stems"])
    for stem in stems:
        stem["path"] = str(Path(directory) / stem["file"])
        stem["peaks"] = str(Path(directory) / stem["peaks"]) if stem.get("peaks") else None
        stem["midi"] = str(Path(directory) / stem["midi"]) if stem.get("midi") else None
        # Where the file begins in the song. A row from before offsets were kept has none.
        stem["start"] = int(stem.get("offset") or 0) / SAMPLE_RATE
    return {
        "directory": directory,
        "track_name": row["track_name"],
        "track_path": row["track_path"],
        "track_hash": row["track_hash"],
        "recipe_id": row["recipe_id"],
        "recipe_name": row["recipe_name"],
        "created_at": row["created_at"],
        "analysis": json.loads(row["analysis"]),
        "stems": stems,
        "part": json.loads(row["part"]) if row["part"] else None,
    }
