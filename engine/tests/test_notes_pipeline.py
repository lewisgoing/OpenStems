"""Stem to MIDI around a run (Phase 7, stage M3): the notes file and the MIDI file a run
writes beside a stem, what a new tempo or name does to them, and reading a stem that is
already written (`pipeline/notes.py`, `POST /v1/notes`)."""

from __future__ import annotations

import contextlib
import dataclasses
import json
import os
import stat
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from openstems.audio.midi import read_midi_notes, read_tracks
from openstems.audio.transcribe import Transcription
from openstems.audio.write import write_audio
from openstems.domain import OutputStem, PassSpec, Recipe
from openstems.domain.errors import DomainError
from openstems.domain.notes import MIDI_STEMS, Note, from_sidecar
from openstems.pipeline import notes as notes_module
from openstems.pipeline import run as run_module
from openstems.pipeline.levels import set_hidden
from openstems.pipeline.notes import (
    changed,
    failed_note,
    find_notes,
    midi_from_sidecar,
    read_stems,
    readable,
    song_tuning,
    stale,
    track_name,
    write_notes,
)
from openstems.pipeline.rename import rename_song
from openstems.pipeline.retag import set_analysis
from openstems.pipeline.run import Pipeline, RunOptions, read_manifest, stem_set_from_manifest
from tests.conftest import RATE, REFUSED
from tests.test_api import all_terminal, client, fake_env, service_of, songs, wait_for
from tests.test_transcribe import sung

__all__ = ["client", "fake_env", "songs"]  # fixtures, used by name

SIX = ("bass", "drums", "other", "vocals", "guitar", "piano")
WANTED = [57, 60, 64, 69]


def vocals_only() -> Recipe:
    return Recipe(
        id="vox",
        name="Vocals",
        version=1,
        passes=(PassSpec("v", ("vox",)),),
        outputs=(OutputStem("vocals", "v.vocals"),),
    )


def full_song() -> Recipe:
    return Recipe(
        id="full-song",
        name="Full song",
        version=1,
        passes=(PassSpec("sw", ("six",)),),
        outputs=tuple(OutputStem(s, f"sw.{s}") for s in SIX),
        residual_into="other",
    )


def tune(tmp_path: Path, lead: float = 0.0) -> Path:
    """The test song, written once per test: a float WAV holds the second it was written in,
    so a second copy can be another file to the cache."""
    source = tmp_path / "Tune.wav"
    if not source.is_file():
        mono = np.concatenate([np.zeros(int(lead * RATE), dtype=np.float32), sung(WANTED)])
        write_audio(source, np.stack([mono, mono]), RATE)
    return source


MINE = b"MThd and the user's own notes, exported from Melodyne"


def keys_of(path: Path) -> list[int]:
    return [note for _, _, note, _ in read_midi_notes(path.read_bytes())[0]]


def files_of(folder: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()}


def separated(catalog: Any, store: Any, tmp_path: Path, **options: Any) -> Path:
    """The test song's six stems, with no notes yet."""
    run = Pipeline(catalog, store).run
    return Path(run(tune(tmp_path), full_song(), tmp_path / "out", RunOptions(**options)).directory)


def by_name(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {stem["name"]: stem for stem in manifest["stems"]}


def as_0_4_6_left_it(folder: Path, ago: float = 86400.0) -> dict[str, Any]:
    """The stem folder as 0.4.6 wrote it, ``ago`` seconds back: a MIDI file named, no notes
    file and no hash, and all of it of that moment: every file's time, and the time the
    manifest gives for the run. Returns the manifest."""
    manifest = read_manifest(folder)
    assert manifest is not None
    for stem in manifest["stems"]:
        if stem.get("notes"):
            (folder / stem["notes"]).unlink()
        for field in ("notes", "midi_hash", "midi_was"):
            stem.pop(field, None)
    then = time.time() - ago
    manifest["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(then))
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for path in folder.rglob("*"):
        if path.is_file():
            os.utime(path, (then, then))
    return manifest


def saved_later(folder: Path, name: str, after: float = 3600.0) -> Path:
    """Somebody's own MIDI file saved over a stem's, ``after`` seconds after the stem."""
    midi = folder / name
    then = midi.with_suffix(".wav").stat().st_mtime + after
    midi.write_bytes(MINE)
    os.utime(midi, (then, then))
    return midi


@contextlib.contextmanager
def unreadable(
    monkeypatch: pytest.MonkeyPatch, path: Path, times: int = 10**6
) -> Iterator[list[str]]:
    """Within it, the next ``times`` reads of the file at ``path`` are refused: as Windows
    refuses a file another program holds, a Mac one the user may not read, and a sync
    client one it has not fetched. Yields the reads it refused."""
    read = Path.read_bytes
    refused: list[str] = []

    def read_bytes(self: Path) -> bytes:
        if self == path and len(refused) < times:
            refused.append(self.name)
            raise PermissionError(13, "Permission denied", str(self))
        return read(self)

    with monkeypatch.context() as patched:
        patched.setattr(Path, "read_bytes", read_bytes)
        yield refused


@contextlib.contextmanager
def ended_at(
    monkeypatch: pytest.MonkeyPatch,
    file: str = "",
    *,
    second_of: str = "",
    before_it_lands: bool = False,
) -> Iterator[None]:
    """Within it, the process "ends" partway through `write_notes`: nothing after that is
    written, moved, removed or put back, as when a process is killed. It ends as ``file``
    is about to be written; with ``before_it_lands``, once its new bytes are written and
    what it held is parked, but before the new file is in its place; or as the second
    file whose name starts with ``second_of`` is about to be written."""
    swap, remove, replace = notes_module._swap, notes_module._remove, os.replace
    ended: list[str] = []
    seen: list[str] = []

    def end(name: str) -> None:
        ended.append(name)
        raise SystemExit("the process ends here")

    def swap_or_end(path: Path, data: bytes, parked: Any) -> None:
        if second_of and path.name.startswith(second_of):
            seen.append(path.name)
            if len(seen) == 2:
                end(path.name)
        if path.name == file and not before_it_lands:
            end(path.name)
        swap(path, data, parked)

    def replace_until_then(src: Any, dst: Any) -> None:
        if ended:
            return
        if before_it_lands and Path(src).name == file + ".tmp":
            end(file)
        replace(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "_swap", swap_or_end)
        patched.setattr("openstems.pipeline.notes.os.replace", replace_until_then)
        patched.setattr(notes_module, "_undo", lambda parked: None)
        patched.setattr(notes_module, "_remove", lambda path: None if ended else remove(path))
        yield


@contextlib.contextmanager
def held_open(monkeypatch: pytest.MonkeyPatch, file: str) -> Iterator[None]:
    """Within it, ``file`` cannot be read: another program has it open."""
    read = Path.read_bytes

    def refused(self: Path) -> bytes:
        if self.name == file:
            raise PermissionError(13, "in use", str(self))
        return read(self)

    with monkeypatch.context() as patched:
        patched.setattr(Path, "read_bytes", refused)
        yield


def test_a_run_writes_the_notes_and_the_midi_beside_the_stem(catalog, store, tmp_path) -> None:
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals", "bass"])
    result = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    stem = result.stems[0]
    assert stem.midi == "Tune - vocals.mid" and stem.notes == "Tune - vocals.notes.json"
    manifest = read_manifest(folder)
    assert manifest is not None and manifest["stems"][0]["notes"] == stem.notes

    # The notes file: every note found, each with a confidence, and where the line is drawn.
    notes, meta = from_sidecar(json.loads((folder / stem.notes).read_text("utf-8")))
    assert meta["stem"] == "vocals" and meta["kind"] == "pitched" and 0 < meta["threshold"] < 1
    shown = [n for n in notes if (n.confidence or 0) >= meta["threshold"]]
    assert [round(n.pitch) for n in shown] == WANTED

    # The MIDI file: one track holding the tempo and the notes that count.
    data = (folder / stem.midi).read_bytes()
    fmt, _, tracks = read_tracks(data)
    assert fmt == 0 and len(tracks) == 1
    midi_notes, bpm = read_midi_notes(data)
    assert bpm == 120.0 and [n for _, _, n, _ in midi_notes] == WANTED
    assert [round(s, 2) for s, _, _, _ in midi_notes] == [round(n.start, 2) for n in shown]

    # Running again without MIDI replaces the result cleanly, both files included.
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", RunOptions(force=True))
    assert again.stems[0].midi is None and again.stems[0].notes is None
    assert not (folder / "Tune - vocals.mid").exists()
    assert not (folder / "Tune - vocals.notes.json").exists()


def test_only_stems_with_a_line_are_read(catalog, store, tmp_path) -> None:
    peaks = {"vocals": 0.5, "bass": 0.4, "drums": 0.6, "guitar": 0.00001, "instrumental": 0.5}
    every = list(peaks)
    assert readable(every, every, peaks) == ["vocals", "bass"]  # no drums, mixture or hiss
    assert readable(every, ["bass"], peaks) == ["bass"]
    assert readable(every, [], peaks) == []
    # A recipe of the user's may write its names otherwise than the setting does.
    assert readable(["Bass", "Lead Vocals"], ["bass", "lead vocals"], {}) == ["Bass", "Lead Vocals"]
    # In a run: the kit of a full song is asked for and left alone.
    options = RunOptions(midi_stems=["vocals", "drums"])
    result = Pipeline(catalog, store).run(tune(tmp_path), full_song(), tmp_path / "out", options)
    by_name = {s.name: s for s in result.stems}
    assert by_name["vocals"].midi and by_name["vocals"].notes
    assert by_name["drums"].midi is None and by_name["drums"].notes is None


def test_a_stem_with_no_notes_gets_the_notes_file_alone(catalog, store, tmp_path) -> None:
    source = tmp_path / "Hiss.wav"
    noise = (np.random.default_rng(3).standard_normal(RATE * 2) * 0.2).astype(np.float32)
    write_audio(source, np.stack([noise, noise]), RATE)
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(source, vocals_only(), tmp_path / "out", options)
    stem = result.stems[0]
    assert stem.midi is None and stem.notes == "Hiss - vocals.notes.json"
    assert not list(Path(result.directory).glob("*.mid"))


def test_times_are_the_written_files_own(catalog, store, tmp_path) -> None:
    # A second of silence, then the melody. With the silence trimmed the stem's file starts
    # at the melody, and so do its notes.
    pipeline = Pipeline(catalog, store)
    plain = pipeline.run(
        tune(tmp_path, lead=1.0), vocals_only(), tmp_path / "a", RunOptions(midi_stems=["vocals"])
    )
    trimmed = pipeline.run(
        tune(tmp_path, lead=1.0),
        vocals_only(),
        tmp_path / "b",
        RunOptions(midi_stems=["vocals"], trim_silence=True),
    )
    first = read_midi_notes((Path(plain.directory) / "Tune - vocals.mid").read_bytes())[0][0][0]
    cut = read_midi_notes((Path(trimmed.directory) / "Tune - vocals.mid").read_bytes())[0][0][0]
    offset = trimmed.stems[0].offset / RATE
    assert first == pytest.approx(1.0, abs=0.03) and offset > 0.9
    assert cut == pytest.approx(first - offset, abs=0.03)


def test_a_cached_song_with_the_old_trackers_midi_is_read_again(catalog, store, tmp_path) -> None:
    # Before the notes file there was only the MIDI. The same song queued again comes from
    # the cache, and its stems are read where they lie: nothing is separated again.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    first = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(first.directory)
    manifest = read_manifest(folder)
    assert manifest is not None
    del manifest["stems"][0]["notes"]  # as an earlier version wrote it:
    del manifest["stems"][0]["midi_hash"]  # no notes file, and no word of what the MIDI held
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (folder / "Tune - vocals.notes.json").unlink()
    (folder / "Tune - vocals.mid").write_bytes(b"the old tracker's notes")
    written = (folder / "Tune - vocals.wav").stat().st_mtime_ns

    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and (folder / "Tune - vocals.wav").stat().st_mtime_ns == written
    assert again.stems[0].notes == "Tune - vocals.notes.json"
    assert keys_of(folder / "Tune - vocals.mid") == WANTED
    # Once read, a third time changes nothing.
    held = (folder / "Tune - vocals.notes.json").read_bytes()
    assert pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).cached
    assert (folder / "Tune - vocals.notes.json").read_bytes() == held
    # Without MIDI asked for, a cached song is left as it is.
    plain = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "plain")
    assert pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "plain").stems[0].notes is None
    assert plain.stems[0].midi is None


def test_a_midi_file_saved_over_the_old_trackers_is_not_replaced(catalog, store, tmp_path) -> None:
    # An earlier version kept no word of what its MIDI file held. It wrote that file in the
    # moment it wrote the stem, so one that is a good deal newer than its stem was saved
    # there since: Melodyne's export, say, over the old tracker's poor one.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    folder = Path(pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).directory)
    manifest = read_manifest(folder)
    assert manifest is not None
    del manifest["stems"][0]["notes"], manifest["stems"][0]["midi_hash"]
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (folder / "Tune - vocals.notes.json").unlink()
    midi = folder / "Tune - vocals.mid"
    midi.write_bytes(b"the user's own, saved an hour later")
    assert not changed(folder, manifest["stems"][0])  # of the same moment: the app's
    later = (folder / "Tune - vocals.wav").stat().st_mtime + 3600
    os.utime(midi, (later, later))
    assert changed(folder, manifest["stems"][0])

    with pytest.raises(DomainError, match="was changed since the app wrote it"):
        find_notes(folder, ["Tune - vocals.wav"])
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and midi.read_bytes() == b"the user's own, saved an hour later"
    assert any("was changed since the app wrote it" in note for note in again.manifest["notes"])
    assert not (folder / "Tune - vocals.notes.json").exists()
    # So does the song separated anew, which replaces every file of the stem's own.
    forced = RunOptions(**{**vars(options), "force": True})
    fresh = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", forced)
    assert not fresh.cached and midi.read_bytes() == b"the user's own, saved an hour later"
    assert fresh.manifest["stems"][0]["midi"] is None
    assert any("was changed since the app wrote it" in note for note in fresh.manifest["notes"])


@pytest.mark.filterwarnings("ignore:n_fft=1024 is too large")  # tempo detection, 2 s of it
def test_a_tempo_typed_does_not_make_somebodys_midi_the_apps(catalog, store, tmp_path) -> None:
    # Whose a MIDI file from before hashes is goes by the time of the run that wrote the
    # folder, which the manifest keeps. At first it went by the stem's own time, and the
    # app moves that itself: with tempo sync on, a new tempo rewrites the mark inside each
    # WAV. From then on the stem was newer than a file saved beside it long after the
    # separation, which was taken for the app's own: replaced by the next reading, removed
    # by the next run, and nothing said.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"], tempo_sync=True)
    folder = Path(pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).directory)
    manifest = as_0_4_6_left_it(folder)
    assert not changed(folder, manifest["stems"][0])  # the old tracker's own, of the run
    midi = saved_later(folder, "Tune - vocals.mid")
    assert changed(folder, manifest["stems"][0])

    # In one job: the song queued again with a tempo typed in its row.
    typed = dataclasses.replace(options, bpm=90.0)
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", typed)
    assert again.cached and midi.read_bytes() == MINE
    assert any("was changed since the app wrote it" in note for note in again.manifest["notes"])
    # The tempo marked the stem, which is newer than the file now. Somebody's still.
    assert (folder / "Tune - vocals.wav").stat().st_mtime > midi.stat().st_mtime
    after = read_manifest(folder)
    assert after is not None and changed(folder, after["stems"][0])
    # So the next reading leaves it, and so does a new run that writes no MIDI.
    assert pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).cached
    assert midi.read_bytes() == MINE
    plain = RunOptions(tempo_sync=True, force=True)
    assert not pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", plain).cached
    assert midi.read_bytes() == MINE
    # With no word of when the run was, there is nothing to go by: not the app's to replace.
    last = read_manifest(folder)
    assert last is not None
    old = {"name": "vocals", "file": "Tune - vocals.wav", "midi": "Tune - vocals.mid"}
    last["created_at"] = "some day"
    (folder / "manifest.json").write_text(json.dumps(last), encoding="utf-8")
    os.utime(midi, (0, 0))
    assert changed(folder, old)


def test_a_midi_file_whose_stem_is_gone_is_somebodys_still(catalog, store, tmp_path) -> None:
    # The user moved the bass stem into a project. With a stem missing the song is
    # separated again, which replaces every file of a stem's own. The export saved beside
    # the bass is not one, though its stem can no longer be asked its time.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["bass", "vocals"])
    folder = Path(pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", options).directory)
    manifest = as_0_4_6_left_it(folder)
    midi = saved_later(folder, "Tune - bass.mid")
    (folder / "Tune - bass.wav").rename(tmp_path / "bass, in my project.wav")
    assert changed(folder, by_name(manifest)["bass"])
    again = pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", options)
    assert not again.cached and midi.read_bytes() == MINE
    # The vocals' MIDI file was the old tracker's own, and is the new transcriber's now.
    assert keys_of(folder / "Tune - vocals.mid") == WANTED


def test_a_midi_file_that_cannot_be_read_is_never_taken_for_the_apps(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Whose a MIDI file is, is read from its bytes. One that is there and cannot be read
    # used to count as the app's own, and somebody's file was then written over or removed.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    folder = Path(pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).directory)
    midi = folder / "Tune - vocals.mid"
    midi.write_bytes(MINE)
    held = files_of(folder)

    # One read that fails stops a new tempo and a rename, which say which file.
    names_it = pytest.raises(DomainError, match=REFUSED + r".*Tune - vocals\.mid")
    with unreadable(monkeypatch, midi, times=1) as refused, names_it:
        set_analysis(folder, {"bpm": 90})
    assert refused == [midi.name] and files_of(folder) == held
    renamed = folder.parent.parent / "Night Drive" / folder.name / "Night Drive - vocals.mid"
    with unreadable(monkeypatch, renamed, times=1) as refused, pytest.raises(DomainError) as no:
        rename_song(folder, "Night Drive")
    assert REFUSED in str(no.value)
    assert len(refused) == 1 and files_of(folder) == held
    # A reading is refused, the one asked for and the one that comes with a cached song.
    with unreadable(monkeypatch, midi), pytest.raises(DomainError, match="cannot be read now"):
        find_notes(folder, ["Tune - vocals.wav"])
    assert files_of(folder) == held
    with monkeypatch.context() as patched, unreadable(monkeypatch, midi):
        patched.setattr(notes_module, "METHOD", "a later transcriber")
        again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and files_of(folder) == held
    assert any("Tune - vocals.mid cannot be read now" in note for note in again.manifest["notes"])
    # Read between a reading and its write, it stops the write.
    midi.rename(folder / "aside.mid")
    reading = read_stems(folder, ["Tune - vocals.wav"])
    (folder / "aside.mid").rename(midi)
    with unreadable(monkeypatch, midi, times=1), pytest.raises(DomainError):
        write_notes(folder, reading)
    assert files_of(folder) == held
    # And a new run, with MIDI or without, leaves the file where it is.
    for fresh in (RunOptions(midi_stems=["vocals"], force=True), RunOptions(force=True)):
        with unreadable(monkeypatch, midi):
            assert not pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", fresh).cached
        assert midi.read_bytes() == MINE


def test_another_stems_midi_that_cannot_be_read_stops_the_write(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # The bass settles another tuning, and the vocals' MIDI file would be rounded again in
    # it. It cannot be read just then, so whose it is cannot be told, and nothing is
    # written: as when a notes file cannot be read. Written without it, the song would have
    # two tunings and nothing said. The next reading sees that the file is somebody's.
    folder = sharp_song(catalog, store, tmp_path)
    midi = folder / "Sharp - vocals.mid"
    midi.write_bytes(MINE)
    held = files_of(folder)
    reading = read_stems(folder, ["Sharp - bass.wav"])
    names_it = pytest.raises(DomainError, match=REFUSED + r".*Sharp - vocals\.mid")
    with unreadable(monkeypatch, midi, times=1) as refused, names_it:
        write_notes(folder, reading)
    assert refused == [midi.name] and files_of(folder) == held
    find_notes(folder, ["Sharp - bass.wav"])
    assert midi.read_bytes() == MINE and keys_of(folder / "Sharp - bass.mid") == IN_TUNE
    assert tuning_of(folder, "vocals") == tuning_of(folder, "bass") == SHARP_BY
    # A stem that needs no change is not asked: a file of its that cannot be read is no
    # matter to a reading of another stem.
    with unreadable(monkeypatch, midi) as refused:
        find_notes(folder, ["Sharp - bass.wav"])
    assert refused == []


def test_a_midi_file_saved_while_a_run_writes_its_stems_is_left(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # A run writes its stems into a folder of its own and swaps them in at the end, seconds
    # later for a long song. Whose the files in the stem folder are is asked last, just
    # before the swap, as a reading asks just before it writes. Asked stem by stem as each
    # was written, a file saved in between was removed by the swap.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["bass", "vocals"])
    write = run_module.write_audio

    def saving_while_the_last_stem_is_written(mine: Path) -> Any:
        def write_audio(path: Path, *args: Any, **kwargs: Any) -> None:
            write(path, *args, **kwargs)
            if path.name == "Tune - piano.wav":  # the last of six; the bass was the first
                mine.write_bytes(MINE)

        return write_audio

    # Saved where there was none, and saved over the app's own.
    for first in (RunOptions(), options):
        out = tmp_path / ("over" if first.midi_stems else "new")
        folder = Path(pipeline.run(tune(tmp_path), full_song(), out, first).directory)
        mine = folder / "Tune - bass.mid"
        with monkeypatch.context() as patched:
            patched.setattr(run_module, "write_audio", saving_while_the_last_stem_is_written(mine))
            again = pipeline.run(
                tune(tmp_path), full_song(), out, dataclasses.replace(options, force=True)
            )
        assert not again.cached and mine.read_bytes() == MINE
        stems = by_name(again.manifest)
        assert stems["bass"]["midi"] is None and stems["bass"].get("notes") is None
        assert any(note.startswith("bass: Tune - bass.mid ") for note in again.manifest["notes"])
        assert keys_of(folder / "Tune - vocals.mid") == WANTED
        assert not list(folder.glob("*.tmp"))


def test_the_swap_itself_never_writes_over_a_midi_file_that_is_not_the_apps(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # The last line of defence: a file that appears after the run has asked, in the moment
    # before its folder is swapped in. A notes or MIDI file that still stands where a new
    # one would go, once the old manifest's own are gone, is somebody's.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["bass", "vocals"])
    folder = Path(pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", options).directory)
    mine = folder / "Tune - bass.mid"
    swap = run_module._replace_dir

    def saved_just_before(tmp: Path, out_dir: Path) -> None:
        mine.write_bytes(MINE)
        swap(tmp, out_dir)

    monkeypatch.setattr(run_module, "_replace_dir", saved_just_before)
    again = pipeline.run(
        tune(tmp_path), full_song(), tmp_path / "out", dataclasses.replace(options, force=True)
    )
    assert not again.cached and mine.read_bytes() == MINE
    # The manifest names it, with the hash of the file the app meant to put there: so it
    # is known as somebody's from then on.
    on_disk = read_manifest(folder)
    assert on_disk is not None and changed(folder, by_name(on_disk)["bass"])
    assert keys_of(folder / "Tune - vocals.mid") == WANTED


def test_a_name_the_disk_holds_in_another_case_is_the_same_file(catalog, store, tmp_path) -> None:
    # Windows and a Mac do not tell "TUNE - vocals.mid" from "Tune - vocals.mid". A run of
    # the song under a name that differs only in case goes into the same folder, and its
    # own notes and MIDI files there are its own: asked by spelling, they were "already in
    # the stem folder", not written anew, and then removed with the old stems.
    (tmp_path / "probe").write_text("", encoding="utf-8")
    if not (tmp_path / "PROBE").exists():
        pytest.skip("this disk tells case")
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    folder = Path(pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).directory)
    assert keys_of(folder / "Tune - vocals.mid") == WANTED
    named = dataclasses.replace(options, name="TUNE", force=True)
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", named)
    assert Path(again.directory).samefile(folder)  # one folder to the disk
    assert again.manifest["notes"] == []
    assert again.manifest["stems"][0]["midi"] == "TUNE - vocals.mid"
    assert keys_of(folder / "TUNE - vocals.mid") == WANTED
    assert sorted(p.name for p in folder.glob("*.mid")) == ["TUNE - vocals.mid"]


def test_a_song_from_the_cache_finishes_a_write_that_was_cut_short(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # A reading starts only for a stem whose notes file is missing or stale. A cut that
    # leaves every notes file in place and a MIDI file moved aside is followed by none, so
    # a song from the cache finishes it by itself (`notes.mend`). The cut: a guitar read
    # later settles the song's tuning, the vocals' MIDI file is rounded again, and the
    # process ends between the two renames that replace it.
    pipeline = Pipeline(catalog, store)
    first = RunOptions(midi_stems=["vocals"])  # a voice sets no tuning: its MIDI is on A440
    out = tmp_path / "out"
    folder = Path(pipeline.run(sharp_source(tmp_path), full_song(), out, first).directory)
    midi = folder / "Sharp - vocals.mid"
    assert keys_of(midi) == AT_A440
    more = RunOptions(midi_stems=["vocals", "guitar"])  # the same cache key
    ended = ended_at(monkeypatch, "Sharp - vocals.mid", before_it_lands=True)
    with ended, pytest.raises(SystemExit):
        pipeline.run(sharp_source(tmp_path), full_song(), out, more)
    assert not midi.exists() and (folder / "Sharp - vocals.mid.old.tmp").is_file()

    again = pipeline.run(sharp_source(tmp_path), full_song(), out, more)
    assert again.cached and again.manifest["notes"] == []
    assert keys_of(midi) == IN_TUNE and not list(folder.glob("*.tmp"))
    assert not changed(folder, by_name(again.manifest)["vocals"])
    # With nothing left undone, a song from the cache writes nothing.
    held = {path.name: path.stat().st_mtime_ns for path in folder.iterdir()}
    assert pipeline.run(sharp_source(tmp_path), full_song(), out, more).cached
    assert {path.name: path.stat().st_mtime_ns for path in folder.iterdir()} == held


def test_what_a_cut_left_is_cleared_before_a_rename_moves_the_names(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # What a write that was cut short left is found by the names the manifest has. A rename
    # (a new tempo too, when the names hold the tempo) gives the files other names, so it
    # clears up first: a notes file that was moved aside comes back and takes the new name.
    folder = separated(catalog, store, tmp_path)
    find_notes(folder, ["Tune - bass.wav", "Tune - vocals.wav"])
    held = (folder / "Tune - bass.notes.json").read_bytes()
    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "METHOD", "another transcriber")  # other bytes
        ended = ended_at(monkeypatch, "Tune - bass.notes.json", before_it_lands=True)
        with ended, pytest.raises(SystemExit):
            find_notes(folder, ["Tune - bass.wav"])
    assert (folder / "Tune - bass.notes.json.old.tmp").read_bytes() == held
    folder = rename_song(folder, "Night Drive")[-1].now
    assert (folder / "Night Drive - bass.notes.json").read_bytes() == held
    assert not [p.name for p in folder.iterdir() if p.name.endswith(".tmp")]
    # And a leftover that is marked read-only is cleared like any other.
    left = folder / "Night Drive - bass.mid.old.tmp"
    left.write_bytes(b"what the file held")
    left.chmod(stat.S_IREAD)
    set_analysis(folder, {"bpm": 90})
    assert not left.exists()


def test_another_stems_read_only_files_stay_on_their_tuning(catalog, store, tmp_path) -> None:
    # The bass settles another tuning for the song. The vocals' MIDI file is marked
    # read-only, so neither it nor the notes file beside it is touched: half of the stem
    # moved would leave its MIDI file on another tuning than its notes file says.
    folder = sharp_song(catalog, store, tmp_path)
    midi = folder / "Sharp - vocals.mid"
    held = {name: data for name, data in files_of(folder).items() if "vocals" in name}
    midi.chmod(stat.S_IREAD)
    try:
        find_notes(folder, ["Sharp - bass.wav"])
        now = {name: data for name, data in files_of(folder).items() if "vocals" in name}
        assert now == held
        assert keys_of(midi) == AT_A440 and tuning_of(folder, "vocals") == 0.0
        assert keys_of(folder / "Sharp - bass.mid") == IN_TUNE
    finally:
        midi.chmod(stat.S_IWRITE | stat.S_IREAD)
    # Writable again, the next reading of the song brings the stem along.
    find_notes(folder, ["Sharp - bass.wav"])
    assert keys_of(midi) == IN_TUNE and tuning_of(folder, "vocals") == SHARP_BY


def test_a_midi_file_rounded_again_is_still_the_apps_own(catalog, store, tmp_path) -> None:
    # The bass settles another tuning, and the vocals' MIDI file is rounded again in it. The
    # manifest must learn the new file's hash, or the app takes its own file for somebody's.
    folder = sharp_song(catalog, store, tmp_path)
    manifest = find_notes(folder, ["Sharp - bass.wav"])
    assert keys_of(folder / "Sharp - vocals.mid") == IN_TUNE
    assert not changed(folder, by_name(manifest)["vocals"])
    on_disk = read_manifest(folder)
    assert on_disk is not None and not changed(folder, by_name(on_disk)["vocals"])


def test_a_read_only_midi_file_is_left_by_a_new_tempo_a_rename_and_a_new_run(
    catalog, store, tmp_path
) -> None:
    # Marked read-only by its owner, the app's own MIDI file is left as it is, the same on
    # both systems. Windows refused the whole change for it and gave another reason; a Mac
    # wrote over it, and a new run removed it.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    marked: list[Path] = []

    def read_only_midi(out: Path) -> tuple[Path, Path, bytes]:
        folder = Path(pipeline.run(tune(tmp_path), vocals_only(), out, options).directory)
        midi = folder / "Tune - vocals.mid"
        midi.chmod(stat.S_IREAD)
        marked.append(midi)
        return folder, midi, midi.read_bytes()

    try:
        # A new tempo goes through without it, and a rename takes it along as it is.
        folder, midi, held = read_only_midi(tmp_path / "out")
        assert set_analysis(folder, {"bpm": 90})["analysis"]["bpm"] == 90.0
        assert midi.read_bytes() == held
        now = rename_song(folder, "Night Drive")[-1].now
        marked.append(now / "Night Drive - vocals.mid")
        assert marked[-1].read_bytes() == held
        # A new run leaves it where it is, writes the stem without notes, and says so.
        folder, midi, held = read_only_midi(tmp_path / "again")
        forced = dataclasses.replace(options, force=True)
        fresh = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "again", forced)
        assert not fresh.cached and midi.read_bytes() == held
        assert fresh.manifest["stems"][0]["midi"] is None
        said = "vocals: Tune - vocals.mid is read-only, so this stem's notes and MIDI"
        assert any(note.startswith(said) for note in fresh.manifest["notes"])
    finally:
        for path in marked:
            if path.exists():
                path.chmod(stat.S_IWRITE | stat.S_IREAD)


def test_a_new_tempo_ended_before_the_first_midi_file(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Ended after the manifest that says what is to come and before the file itself, the
    # file still holds its old bytes, which that manifest names as well (`midi_was`).
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    midi = folder / "Tune - vocals.mid"
    held = midi.read_bytes()
    replace = os.replace

    def ends_at_the_midi(src: Any, dst: Any) -> None:
        if Path(dst).name == midi.name:
            raise SystemExit("the process ends here")
        replace(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.retag.os.replace", ends_at_the_midi)
        with pytest.raises(SystemExit):
            set_analysis(folder, {"bpm": 90})
    left = read_manifest(folder)
    assert left is not None and midi.read_bytes() == held
    assert not changed(folder, left["stems"][0])
    set_analysis(folder, {"bpm": 96})  # and the next tempo reaches it
    assert read_midi_notes(midi.read_bytes())[1] == pytest.approx(96)


def test_a_rename_ended_before_its_manifest(catalog, store, tmp_path, monkeypatch) -> None:
    # A rename, like a new tempo, first writes the manifest that knows each MIDI file's new
    # bytes. With a naming template that holds no {track} the files keep their names, so
    # the manifest a cut leaves behind still names them.
    options = RunOptions(midi_stems=["vocals"], naming_template="{stem}")
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    replace = os.replace
    seen: list[str] = []

    def ends_at_the_last_manifest(src: Any, dst: Any) -> None:
        if Path(dst).name == "manifest.json":
            seen.append(str(src))
            if len(seen) == 2:
                raise SystemExit("the process ends here")
        replace(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.retag.os.replace", ends_at_the_last_manifest)
        patched.setattr("openstems.pipeline.rename.os.replace", ends_at_the_last_manifest)
        with pytest.raises(SystemExit):
            rename_song(folder, "Night Drive")
    now = folder.parent.parent / "Night Drive" / folder.name
    left = read_manifest(now)
    assert left is not None and b"Night Drive vocals" in (now / "vocals.mid").read_bytes()
    assert not changed(now, left["stems"][0])


def test_a_rename_leaves_a_changed_midi_file_from_before_hashes(catalog, store, tmp_path) -> None:
    # A manifest with a notes file and no hash (a build from before hashes were kept): a
    # rename makes the MIDI file again only if it is, to the byte, what the app makes.
    options = RunOptions(midi_stems=["vocals"])
    pipeline = Pipeline(catalog, store)
    for edited in (True, False):
        out = tmp_path / ("edited" if edited else "as it was")
        folder = Path(pipeline.run(tune(tmp_path), vocals_only(), out, options).directory)
        manifest = read_manifest(folder)
        assert manifest is not None
        del manifest["stems"][0]["midi_hash"]
        (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        if edited:
            (folder / "Tune - vocals.mid").write_bytes(b"MThd, edited by hand")
        now = rename_song(folder, "Night Drive")[-1].now
        data = (now / "Night Drive - vocals.mid").read_bytes()
        assert (data == b"MThd, edited by hand") if edited else (b"Night Drive vocals" in data)


def test_a_tempo_undone_in_part_keeps_the_manifest_that_knows_both(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # The manifest written before the MIDI files goes back only if every MIDI file is back.
    # Here the new tempo fails at its last manifest, and the MIDI file cannot be put back
    # either: the manifest that stays knows the file's new bytes and its old.
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    midi = folder / "Tune - vocals.mid"
    replace = os.replace
    seen: list[str] = []

    def refuses(src: Any, dst: Any) -> None:
        if Path(dst).name == "manifest.json":
            seen.append(str(src))
            if len(seen) == 2:
                raise PermissionError(13, "in use", str(dst))
        if Path(dst).name == midi.name and len(seen) >= 2:
            raise PermissionError(13, "in use", str(dst))  # it cannot be put back
        replace(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.retag.os.replace", refuses)
        with pytest.raises(DomainError, match=REFUSED):
            set_analysis(folder, {"bpm": 90})
    left = read_manifest(folder)
    assert left is not None and read_midi_notes(midi.read_bytes())[1] == pytest.approx(90)
    assert not changed(folder, left["stems"][0])

    # A change that fails for want of room says that, not that a file is open elsewhere.
    def full(src: Any, dst: Any) -> None:
        raise OSError(28, "No space left on device", str(dst))

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.retag.os.replace", full)
        with pytest.raises(DomainError, match="nothing was changed: No space left on device"):
            set_analysis(folder, {"bpm": 100})


def test_a_cached_song_takes_its_own_unnamed_files_as_its_own(catalog, store, tmp_path) -> None:
    # Files the app made that no manifest names (a write cut short by an earlier build left
    # such) are not "already in the stem folder" to a song from the cache either.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    folder = Path(pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options).directory)
    manifest = read_manifest(folder)
    assert manifest is not None
    for field in ("notes", "midi_hash"):
        del manifest["stems"][0][field]
    manifest["stems"][0]["midi"] = None
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and again.manifest["notes"] == []
    assert again.stems[0].notes == "Tune - vocals.notes.json"
    assert again.stems[0].midi == "Tune - vocals.mid" and again.stems[0].midi_hash


def test_a_cached_song_leaves_out_only_the_stem_whose_midi_is_somebodys(
    catalog, store, tmp_path, monkeypatch
) -> None:
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["bass", "vocals"])
    folder = Path(pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", options).directory)
    (folder / "Tune - bass.mid").write_bytes(b"somebody's own bass line")
    held = (folder / "Tune - bass.notes.json").read_bytes()
    monkeypatch.setattr(notes_module, "METHOD", "a later transcriber")
    again = pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", options)
    assert again.cached
    said = (
        "bass: Tune - bass.mid was changed since the app wrote it, "
        "so this stem's notes and MIDI were not written"
    )
    assert said in again.manifest["notes"]
    assert (folder / "Tune - bass.mid").read_bytes() == b"somebody's own bass line"
    assert (folder / "Tune - bass.notes.json").read_bytes() == held
    # The other stem is read by the later transcriber all the same.
    vocals = json.loads((folder / "Tune - vocals.notes.json").read_text("utf-8"))
    assert vocals["method"] == "a later transcriber"
    # Only the job says it: the manifest in the folder does not.
    on_disk = read_manifest(folder)
    assert on_disk is not None and said not in (on_disk.get("notes") or [])


def test_the_cache_key_is_what_it_was_before_the_transcriber() -> None:
    # A song separated by 0.4.x with Write MIDI on must still come from the cache: its key
    # held the five names the setting had then, and holds exactly those now. The names the
    # setting has gained are not in the key.
    old = ["bass", "dry vocals", "lead", "melody", "vocals"]
    assert RunOptions(midi_stems=list(MIDI_STEMS)).key_dict()["midi"] == old
    assert (
        RunOptions(midi_stems=old).key_dict() == RunOptions(midi_stems=list(MIDI_STEMS)).key_dict()
    )
    assert RunOptions(midi_stems=["lead vocals", "guitar"]).key_dict() == RunOptions().key_dict()
    assert RunOptions(midi_stems=["bass"]).key_dict()["midi"] == ["bass"]
    assert "notes" not in RunOptions(midi_stems=["bass"]).key_dict()


def test_a_cached_songs_notes_are_read_when_they_are_missing_or_stale(
    catalog, store, tmp_path
) -> None:
    pipeline = Pipeline(catalog, store)
    first = pipeline.run(tune(tmp_path), full_song(), tmp_path / "out")
    folder = Path(first.directory)
    audio = folder / "Tune - guitar.wav"
    written = audio.stat().st_mtime_ns
    # MIDI asked for a stem whose name is not in the key: the song comes from the cache and
    # that stem is read where it lies.
    again = pipeline.run(
        tune(tmp_path), full_song(), tmp_path / "out", RunOptions(midi_stems=["guitar"])
    )
    assert again.cached and audio.stat().st_mtime_ns == written
    guitar = {s.name: s for s in again.stems}["guitar"]
    assert guitar.notes == "Tune - guitar.notes.json" and guitar.midi == "Tune - guitar.mid"
    notes_file = folder / guitar.notes
    assert not stale(notes_file)
    # Notes another version of the transcriber wrote are read again; current ones are kept.
    held = notes_file.read_bytes()
    pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", RunOptions(midi_stems=["guitar"]))
    assert notes_file.read_bytes() == held
    data = json.loads(held)
    data["method"] = "an earlier transcriber"
    data["notes"] = []
    notes_file.write_text(json.dumps(data), encoding="utf-8")
    assert stale(notes_file) and stale(folder / "nothing.json")
    pipeline.run(tune(tmp_path), full_song(), tmp_path / "out", RunOptions(midi_stems=["guitar"]))
    assert notes_file.read_bytes() == held


def test_a_separation_is_never_lost_to_its_midi(catalog, store, tmp_path, monkeypatch) -> None:
    def broken(*_: Any, **__: Any) -> Transcription:
        raise RuntimeError("the pitch tracker would not start")

    monkeypatch.setattr("openstems.audio.transcribe.transcribe_line", broken)
    monkeypatch.setattr("openstems.pipeline.notes.transcribe_line", broken)
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    result = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    stem = result.stems[0]
    assert (Path(result.directory) / stem.file).is_file()
    assert stem.midi is None and stem.notes is None
    assert "vocals: its notes could not be read, so it has no MIDI" in result.manifest["notes"]
    # From the cache the same: the stems are returned, whatever became of the notes, and
    # the job says why it has none. The manifest on the disk is not touched for that.
    held = (Path(result.directory) / "manifest.json").read_bytes()
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and again.stems[0].notes is None
    (said,) = [n for n in again.manifest["notes"] if n.startswith("MIDI was not written")]
    assert "cannot read the notes of Tune - vocals.wav" in said
    assert (Path(result.directory) / "manifest.json").read_bytes() == held


def test_a_new_tempo_rewrites_the_midi_from_the_notes_file(catalog, store, tmp_path) -> None:
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    midi = folder / "Tune - vocals.mid"
    before, bpm = read_midi_notes(midi.read_bytes())
    assert bpm == 120.0
    set_analysis(folder, {"bpm": 90, "key": "Am"})
    after, bpm = read_midi_notes(midi.read_bytes())
    assert bpm == pytest.approx(90.0, abs=0.001)  # a tempo is whole microseconds per beat
    # The same notes at the same seconds, now counted in beats of the new tempo.
    assert [n[2] for n in after] == [n[2] for n in before]
    assert [n[0] for n in after] == pytest.approx([n[0] for n in before], abs=0.002)
    assert any(m[:2] == b"\xff\x59" for _, m in read_tracks(midi.read_bytes())[2][0])  # A minor
    # Bar 1 alone moves nothing in the file.
    held = midi.read_bytes()
    set_analysis(folder, {"downbeat": 0.5})
    assert midi.read_bytes() == held
    # A notes file that is gone leaves the MIDI as it is.
    (folder / "Tune - vocals.notes.json").unlink()
    set_analysis(folder, {"bpm": 100})
    assert midi.read_bytes() == held


def test_a_tempo_that_cannot_be_written_leaves_every_file_as_it_was(
    catalog, store, tmp_path, monkeypatch
) -> None:
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    held = files_of(folder)
    real = os.replace

    def in_use(src: Any, dst: Any) -> None:
        if str(dst).endswith(".mid"):
            raise PermissionError(13, "in use", str(dst))
        real(src, dst)

    with monkeypatch.context() as patched:  # the MIDI file is open in a DAW
        patched.setattr("openstems.pipeline.retag.os.replace", in_use)
        with pytest.raises(DomainError, match=REFUSED):
            set_analysis(folder, {"bpm": 90})
    assert files_of(folder) == held

    write = Path.write_bytes

    def disk_full(self: Path, data: bytes) -> int:
        if self.name.endswith(".mid.tmp"):
            write(self, data[:10])
            raise OSError(28, "No space left on device", str(self))
        return write(self, data)

    with monkeypatch.context() as patched:  # the write stops halfway
        patched.setattr(Path, "write_bytes", disk_full)
        with pytest.raises(DomainError):
            set_analysis(folder, {"bpm": 90})
    assert files_of(folder) == held


def test_a_notes_file_that_cannot_be_read_now_stops_a_new_tempo(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Gone or damaged, a notes file never stops a new tempo. Open in another program it
    # does: carrying on would leave the MIDI file on the old tempo with nothing said.
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    held = files_of(folder)
    locked = held_open(monkeypatch, "Tune - vocals.notes.json")
    with locked, pytest.raises(DomainError, match=REFUSED):
        set_analysis(folder, {"bpm": 90})
    assert files_of(folder) == held
    set_analysis(folder, {"bpm": 90})
    midi = (folder / "Tune - vocals.mid").read_bytes()
    assert read_midi_notes(midi)[1] == pytest.approx(90.0, abs=0.001)


@pytest.mark.filterwarnings("ignore:n_fft=1024 is too large")  # tempo detection, 2 s of it
def test_a_tempo_in_the_file_names_takes_notes_and_midi_along(catalog, store, tmp_path) -> None:
    options = RunOptions(
        midi_stems=["vocals"], naming_template="{track} {stem} {bpm}bpm", bpm=120.0
    )
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    before = by_name(result.manifest)["vocals"]
    assert before["notes"] == Path(before["file"]).stem + ".notes.json"

    after = by_name(set_analysis(folder, {"bpm": 90}))["vocals"]
    assert after["file"] != before["file"] and "90" in after["file"]
    assert after["notes"] == Path(after["file"]).stem + ".notes.json"
    assert after["midi"] == Path(after["file"]).stem + ".mid"
    for field in ("file", "notes", "midi"):
        assert (folder / after[field]).is_file() and not (folder / before[field]).exists()
    assert read_midi_notes((folder / after["midi"]).read_bytes())[1] == pytest.approx(
        90.0, abs=0.001
    )

    # A notes or MIDI file the user took away does not stop the next change: its entry is
    # renamed with the rest, and there is nothing to move.
    (folder / after["notes"]).unlink()
    (folder / after["midi"]).unlink()
    last = set_analysis(folder, {"bpm": 100})
    assert "100" in by_name(last)["vocals"]["file"]
    assert stem_set_from_manifest(folder, last) is not None
    # A stem that is gone still does.
    (folder / by_name(last)["vocals"]["file"]).unlink()
    with pytest.raises(DomainError, match="missing from the stem folder"):
        set_analysis(folder, {"bpm": 110})


@pytest.mark.filterwarnings("ignore:n_fft=1024 is too large")  # tempo detection, 2 s of it
@pytest.mark.parametrize(
    ("was", "now"),
    [
        ('"velocity":', '"velocity":1e999,"was":'),  # not a number an integer can hold
        ('"threshold":', '"threshold":[0.5],"was":'),
        ('"tuning_cents":', '"tuning_cents":{},"was":'),
        ('"notes":[', '"notes":[7,'),
    ],
)
def test_a_damaged_notes_file_never_stops_a_new_tempo(
    catalog, store, tmp_path, was: str, now: str
) -> None:
    options = RunOptions(
        midi_stems=["vocals"], naming_template="{track} {stem} {bpm}bpm", bpm=120.0
    )
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    stem = by_name(result.manifest)["vocals"]
    notes_file = folder / stem["notes"]
    text = notes_file.read_text("utf-8")
    assert was in text
    notes_file.write_text(text.replace(was, now, 1), encoding="utf-8")
    with pytest.raises(DomainError, match="damaged"):
        from_sidecar(json.loads(notes_file.read_text("utf-8")))
    midi = (folder / stem["midi"]).read_bytes()

    manifest = set_analysis(folder, {"bpm": 90})
    after = by_name(manifest)["vocals"]
    assert manifest["analysis"]["bpm"] == 90.0 and read_manifest(folder) == manifest
    # Everything took its new name; the MIDI, which could not be made again, is as it was.
    assert all((folder / after[field]).is_file() for field in ("file", "notes", "midi"))
    assert (folder / after["midi"]).read_bytes() == midi


def test_a_new_name_takes_both_files_along(catalog, store, tmp_path, monkeypatch) -> None:
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    moved = rename_song(Path(result.directory), "Night Drive")
    folder = moved[-1].now if moved else Path(result.directory)
    manifest = read_manifest(folder)
    assert manifest is not None
    stem = manifest["stems"][0]
    assert stem["midi"] == "Night Drive - vocals.mid"
    assert stem["notes"] == "Night Drive - vocals.notes.json"
    assert (folder / stem["midi"]).is_file() and (folder / stem["notes"]).is_file()
    # The name inside the MIDI file, which a DAW gives the track, is the song's new one.
    data = (folder / stem["midi"]).read_bytes()
    assert b"Night Drive vocals" in data and b"Tune vocals" not in data
    assert keys_of(folder / stem["midi"]) == WANTED
    # A notes file that cannot be read now stops a rename, as a stem that is open does.
    held = files_of(folder)
    locked = held_open(monkeypatch, "Elsewhere - vocals.notes.json")
    with locked, pytest.raises(DomainError, match=REFUSED):
        rename_song(folder, "Elsewhere")
    assert files_of(folder) == held and not (folder.parent.parent / "Elsewhere").exists()
    # A MIDI file somebody changed keeps its bytes: it moves with the song, no more.
    (folder / stem["midi"]).write_bytes(b"MThd, and then the user's own edit")
    moved = rename_song(folder, "Day Drive")
    folder = moved[-1].now
    assert (folder / "Day Drive - vocals.mid").read_bytes() == b"MThd, and then the user's own edit"


def test_the_songs_tuning_comes_from_a_stem_with_fixed_pitches() -> None:
    def found(profile: str, cents: float, strength: float) -> Transcription:
        note = Note(0.0, 1.0, 60.0, confidence=1.0)
        return Transcription((note,), 0.5, cents, strength, profile)

    # A voice does not set the tuning, however sure it is of its own.
    assert song_tuning({"vocals": found("voice", 30.0, 0.95)}) == 0.0
    assert (
        song_tuning({"vocals": found("voice", 30.0, 0.95), "bass": found("bass", -20.0, 0.9)})
        == -20.0
    )
    assert song_tuning({"bass": found("bass", -20.0, 0.5)}) == 0.0  # not sure enough
    assert song_tuning({"bass": found("bass", 3.0, 0.99)}) == 0.0  # as good as A440
    assert song_tuning({}) == 0.0


def test_a_notes_file_becomes_its_midi_again() -> None:
    notes = [Note(0.0, 0.5, 60.2, confidence=0.9), Note(0.5, 1.0, 62.0, confidence=0.2)]
    from openstems.domain.notes import to_sidecar

    sidecar = to_sidecar(notes, stem="bass", threshold=0.5)
    data = midi_from_sidecar(sidecar, name="Song bass", bpm=100, key="C")
    assert data is not None
    found, bpm = read_midi_notes(data)
    assert bpm == pytest.approx(100.0, abs=0.001) and [n[2] for n in found] == [60]
    assert (
        midi_from_sidecar(
            to_sidecar(notes[1:], stem="bass", threshold=0.5), name="x", bpm=None, key=None
        )
        is None
    )


# -- a stem that is already written -------------------------------------------------------


def test_notes_are_found_in_stems_already_written(catalog, store, tmp_path) -> None:
    result = Pipeline(catalog, store).run(tune(tmp_path), full_song(), tmp_path / "out")
    folder = Path(result.directory)
    assert all(s.midi is None and s.notes is None for s in result.stems)

    manifest = find_notes(folder, ["Tune - bass.wav", "Tune - vocals.wav"])
    stems = {s["name"]: s for s in manifest["stems"]}
    assert stems["bass"]["midi"] == "Tune - bass.mid"
    assert stems["bass"]["notes"] == "Tune - bass.notes.json"
    assert stems["vocals"]["midi"] == "Tune - vocals.mid"
    assert stems["guitar"].get("midi") is None and stems["guitar"].get("notes") is None
    assert keys_of(folder / "Tune - bass.mid") == WANTED
    assert read_manifest(folder) == manifest
    assert not list(folder.glob("*.tmp"))
    # Asked again, the files are written again.
    assert find_notes(folder, ["Tune - bass.wav"])["stems"] == manifest["stems"]

    # What is refused, with nothing changed.
    before = {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()}
    for files, message in (
        (["Tune - drums.wav"], "no single line"),
        (["Elsewhere.wav"], "not a stem of this song"),
    ):
        with pytest.raises(DomainError, match=message):
            find_notes(folder, files)
    (folder / "Tune - guitar.mid").write_bytes(b"the user's own")
    with pytest.raises(DomainError, match="already in the stem folder"):
        find_notes(folder, ["Tune - guitar.wav"])
    (folder / "Tune - guitar.mid").unlink()
    (folder / "Tune - piano.wav").unlink()
    with pytest.raises(DomainError, match="no longer in its folder"):
        find_notes(folder, ["Tune - piano.wav"])
    del before["Tune - piano.wav"]
    assert {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()} == before
    with pytest.raises(DomainError, match="does not hold a set of stems"):
        find_notes(tmp_path, ["Tune.wav"])


def test_what_changes_while_stems_are_read_is_kept(catalog, store, tmp_path) -> None:
    # Reading takes seconds. A tempo typed and a stem hidden meanwhile used to be lost: the
    # manifest read before the reading was written back after it.
    folder = separated(catalog, store, tmp_path)
    reading = read_stems(folder, ["Tune - bass.wav"])
    assert not list(folder.glob("*.notes.json")) and not list(folder.glob("*.mid"))
    set_analysis(folder, {"bpm": 90})
    set_hidden(folder, {"piano": True})
    manifest = write_notes(folder, reading)
    assert manifest["analysis"]["bpm"] == 90.0 and read_manifest(folder) == manifest
    stems = by_name(manifest)
    assert stems["piano"]["hidden"] is True and stems["bass"]["notes"] == "Tune - bass.notes.json"
    midi = (folder / "Tune - bass.mid").read_bytes()
    assert read_midi_notes(midi)[1] == pytest.approx(90.0, abs=0.001)  # on the tempo typed


@pytest.mark.filterwarnings("ignore:n_fft=1024 is too large")  # tempo detection, 2 s of it
def test_stems_renamed_while_they_are_read_get_their_notes_all_the_same(
    catalog, store, tmp_path
) -> None:
    folder = separated(
        catalog, store, tmp_path, naming_template="{track} {stem} {bpm}bpm", bpm=120.0
    )
    manifest = read_manifest(folder)
    assert manifest is not None
    old = by_name(manifest)["bass"]["file"]
    reading = read_stems(folder, [old])
    new = by_name(set_analysis(folder, {"bpm": 90}))["bass"]["file"]
    assert new != old and not (folder / old).exists()
    written = write_notes(folder, reading)
    stem = by_name(written)["bass"]
    assert stem["file"] == new and stem["notes"] == Path(new).stem + ".notes.json"
    assert (folder / stem["notes"]).is_file() and keys_of(folder / stem["midi"]) == WANTED
    assert stem_set_from_manifest(folder, written) is not None
    assert not [p.name for p in folder.iterdir() if Path(old).stem in p.name]


def test_a_reading_of_other_stems_is_refused(catalog, store, tmp_path) -> None:
    folder = separated(catalog, store, tmp_path)
    reading = read_stems(folder, ["Tune - bass.wav"])
    held = files_of(folder)
    # The song separated again meanwhile: these are other stems now.
    manifest = read_manifest(folder)
    assert manifest is not None
    again = {**manifest, "created_at": "2001-01-01T00:00:00+0000"}
    (folder / "manifest.json").write_text(json.dumps(again), encoding="utf-8")
    with pytest.raises(DomainError, match="separated again"):
        write_notes(folder, reading)
    (folder / "manifest.json").write_bytes(held["manifest.json"])
    assert files_of(folder) == held
    # The song renamed meanwhile: its folder is elsewhere.
    with pytest.raises(DomainError, match="moved or renamed"):
        write_notes(tmp_path / "elsewhere", reading)


def test_a_write_cut_short_is_finished_by_the_next_reading(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # The manifest is written before the files it names, and a stem's notes file after its
    # MIDI file. A process that ends in between (the worker is ended five seconds after the
    # app quits) leaves a manifest naming a file that is not there, and the next reading
    # writes it. Written in the other order, it left files no manifest named, refused for
    # ever as "already in the stem folder".
    folder = separated(catalog, store, tmp_path)
    with ended_at(monkeypatch, "Tune - guitar.notes.json"), pytest.raises(SystemExit):
        find_notes(folder, ["Tune - guitar.wav"])
    left = read_manifest(folder)
    assert left is not None and by_name(left)["guitar"]["notes"] == "Tune - guitar.notes.json"
    assert (folder / "Tune - guitar.mid").is_file()
    assert not (folder / "Tune - guitar.notes.json").exists()
    # A song from the cache reads a stem whose notes file its manifest names and is not there.
    run = Pipeline(catalog, store).run
    again = run(tune(tmp_path), full_song(), tmp_path / "out", RunOptions(midi_stems=["guitar"]))
    assert again.cached and (folder / "Tune - guitar.notes.json").is_file()
    assert keys_of(folder / "Tune - guitar.mid") == WANTED and not list(folder.glob("*.tmp"))
    # Ended a step earlier, with neither file written: asked again, nothing is in the way.
    with ended_at(monkeypatch, "Tune - bass.mid"), pytest.raises(SystemExit):
        find_notes(folder, ["Tune - bass.wav"])
    assert not (folder / "Tune - bass.mid").exists()
    manifest = find_notes(folder, ["Tune - bass.wav"])
    assert by_name(manifest)["bass"]["midi"] == "Tune - bass.mid"
    assert keys_of(folder / "Tune - bass.mid") == WANTED and not list(folder.glob("*.tmp"))
    # Ended between the two renames that replace one file: what it held is parked, the new
    # file is not in its place yet. A notes file comes back; a MIDI file is made again.
    for file in ("Tune - bass.notes.json", "Tune - bass.mid"):
        with monkeypatch.context() as patched:
            patched.setattr(notes_module, "METHOD", "another transcriber")  # other bytes
            ended = ended_at(monkeypatch, file, before_it_lands=True)
            with ended, pytest.raises(SystemExit):
                find_notes(folder, ["Tune - bass.wav"])
        assert not (folder / file).exists() and (folder / (file + ".old.tmp")).is_file()
        manifest = find_notes(folder, ["Tune - vocals.wav"])  # another stem's reading
        assert (folder / "Tune - bass.notes.json").is_file() and not list(folder.glob("*.tmp"))
        assert keys_of(folder / "Tune - bass.mid") == WANTED
        assert not changed(folder, by_name(manifest)["bass"])


def test_a_new_tempo_cut_short_does_not_cost_a_midi_file_its_standing(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # A new tempo writes the MIDI files and then the manifest. Were the process to end
    # between the two, the manifest would know only the hash of the file as it was, and the
    # app would take its own MIDI file for one somebody changed: never given a tempo again,
    # and in the way of its stem's notes. So the manifest is written once before a file is
    # touched, with the hash the file is about to have beside the one it has.
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    midi = folder / "Tune - vocals.mid"
    replace = os.replace

    def at_the_last_manifest(what: BaseException) -> Any:
        seen: list[str] = []

        def replacing(src: Any, dst: Any) -> None:
            if Path(dst).name == "manifest.json":
                seen.append(str(src))
                if len(seen) == 2:  # the first says what is to come, the second is the new one
                    raise what
            replace(src, dst)

        return replacing

    with monkeypatch.context() as patched:
        ends = at_the_last_manifest(SystemExit("the process ends here"))
        patched.setattr("openstems.pipeline.retag.os.replace", ends)
        with pytest.raises(SystemExit):
            set_analysis(folder, {"bpm": 90})
    left = read_manifest(folder)
    assert left is not None and read_midi_notes(midi.read_bytes())[1] == pytest.approx(90)
    assert not changed(folder, left["stems"][0])
    # The next tempo reaches the file, and its stem can be read again.
    set_analysis(folder, {"bpm": 96})
    assert read_midi_notes(midi.read_bytes())[1] == pytest.approx(96)
    found = find_notes(folder, ["Tune - vocals.wav"])
    assert not changed(folder, found["stems"][0]) and keys_of(midi) == WANTED
    # A new tempo that fails and is undone leaves the file the app's own as well.
    with monkeypatch.context() as patched:
        fails = at_the_last_manifest(PermissionError(13, "in use", "manifest.json"))
        patched.setattr("openstems.pipeline.retag.os.replace", fails)
        with pytest.raises(DomainError, match=REFUSED):
            set_analysis(folder, {"bpm": 120})
    undone = read_manifest(folder)
    assert undone is not None and read_midi_notes(midi.read_bytes())[1] == pytest.approx(96)
    assert not changed(folder, undone["stems"][0])
    assert set_analysis(folder, {"bpm": 120})["analysis"]["bpm"] == 120.0
    assert read_midi_notes(midi.read_bytes())[1] == pytest.approx(120)


def test_a_parked_file_that_cannot_come_back_yet_is_kept(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # After a write that was cut short, the only copy of a notes file may be the one that
    # was moved aside. If it cannot be moved back now (a scanner holds it), it stays where
    # it is for the next time: it is not cleared away with the rest.
    folder = separated(catalog, store, tmp_path)
    find_notes(folder, ["Tune - bass.wav"])
    held = (folder / "Tune - bass.notes.json").read_bytes()
    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "METHOD", "another transcriber")  # other bytes
        ended = ended_at(monkeypatch, "Tune - bass.notes.json", before_it_lands=True)
        with ended, pytest.raises(SystemExit):
            find_notes(folder, ["Tune - bass.wav"])
    parked = folder / "Tune - bass.notes.json.old.tmp"
    assert parked.read_bytes() == held and not (folder / "Tune - bass.notes.json").exists()
    replace = os.replace

    def busy(src: Any, dst: Any) -> None:
        if Path(src) == parked:
            raise PermissionError(13, "in use", str(src))
        replace(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.notes.os.replace", busy)
        find_notes(folder, ["Tune - vocals.wav"])
    assert parked.read_bytes() == held
    find_notes(folder, ["Tune - vocals.wav"])
    assert (folder / "Tune - bass.notes.json").read_bytes() == held
    assert not list(folder.glob("*.tmp"))


def test_a_midi_file_somebody_changed_is_theirs(catalog, store, tmp_path, monkeypatch) -> None:
    # Melodyne saves its export as <audio name>.mid beside the audio: over the app's own
    # MIDI file, when the stem has one. The manifest keeps the sha256 of what the app wrote,
    # so the app knows the file is no longer its, and neither replaces nor removes it:
    # not when the stem is read again, not for a new tempo or a new name, not in a new run.
    pipeline = Pipeline(catalog, store)
    options = RunOptions(midi_stems=["vocals"])
    result = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)
    midi = folder / "Tune - vocals.mid"
    assert not changed(folder, result.manifest["stems"][0])
    mine = b"MThd and the user's own notes, from Melodyne"
    midi.write_bytes(mine)
    assert changed(folder, result.manifest["stems"][0])

    with pytest.raises(DomainError, match="was changed since the app wrote it"):
        find_notes(folder, ["Tune - vocals.wav"])
    with monkeypatch.context() as patched:  # nor is it taken away when no notes are found
        patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
        with pytest.raises(DomainError, match="was changed since the app wrote it"):
            find_notes(folder, ["Tune - vocals.wav"])
    # A song from the cache whose notes another transcriber wrote: read again, not written.
    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "METHOD", "a later transcriber")
        again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and "was changed since the app wrote it" in "".join(again.manifest["notes"])
    # A new tempo goes through and leaves it; so does a new name, which takes it along.
    assert set_analysis(folder, {"bpm": 90})["analysis"]["bpm"] == 90.0
    assert midi.read_bytes() == mine
    folder = rename_song(folder, "Night Drive")[-1].now
    assert (folder / "Night Drive - vocals.mid").read_bytes() == mine
    # Separated again from scratch, the stem's own files are replaced, and that one is not.
    source = tmp_path / "Night Drive.wav"
    source.write_bytes(tune(tmp_path).read_bytes())
    fresh = pipeline.run(
        source, vocals_only(), tmp_path / "out", RunOptions(**{**vars(options), "force": True})
    )
    assert Path(fresh.directory) == folder and not fresh.cached
    assert (folder / "Night Drive - vocals.mid").read_bytes() == mine
    stem = fresh.manifest["stems"][0]
    assert stem["midi"] is None and stem.get("notes") is None
    said = "vocals: Night Drive - vocals.mid was changed since the app wrote it"
    assert any(note.startswith(said) for note in fresh.manifest["notes"])
    # Moved out of the way, the stem gets its notes and its MIDI again.
    (folder / "Night Drive - vocals.mid").rename(folder / "my own take.mid")
    manifest = find_notes(folder, ["Night Drive - vocals.wav"])
    assert keys_of(folder / "Night Drive - vocals.mid") == WANTED
    assert not changed(folder, by_name(manifest)["vocals"])
    assert (folder / "my own take.mid").read_bytes() == mine


def test_a_new_run_leaves_a_midi_file_it_did_not_write(catalog, store, tmp_path) -> None:
    # Separated without MIDI; the user saves one beside a stem under the stem's name; then
    # MIDI is switched on and the song is queued again, which is a new run. It replaces the
    # folder's files, and used to take any file named like a new one with them.
    pipeline = Pipeline(catalog, store)
    folder = Path(pipeline.run(tune(tmp_path), full_song(), tmp_path / "out").directory)
    (folder / "Tune - bass.mid").write_bytes(b"the user's own bass line")
    (folder / "something else.txt").write_text("and a file of no stem's name", "utf-8")
    again = pipeline.run(
        tune(tmp_path), full_song(), tmp_path / "out", RunOptions(midi_stems=["bass", "vocals"])
    )
    assert not again.cached
    stems = by_name(again.manifest)
    assert (folder / "Tune - bass.mid").read_bytes() == b"the user's own bass line"
    assert stems["bass"]["midi"] is None and stems["bass"].get("notes") is None
    assert not (folder / "Tune - bass.notes.json").exists()
    said = "bass: Tune - bass.mid is already in the stem folder, so this stem's notes and MIDI"
    assert any(note.startswith(said) for note in again.manifest["notes"])
    # The stem beside it is read as usual, and nothing else in the folder is touched.
    assert stems["vocals"]["midi"] == "Tune - vocals.mid" and stems["vocals"]["midi_hash"]
    assert keys_of(folder / "Tune - vocals.mid") == WANTED
    assert (folder / "something else.txt").is_file()
    # With the file out of the way the stem is read, and what was said of it is taken back.
    (folder / "Tune - bass.mid").rename(folder / "mine.mid")
    found = find_notes(folder, ["Tune - bass.wav"])
    assert keys_of(folder / "Tune - bass.mid") == WANTED
    assert not any(note.startswith("bass: ") for note in found["notes"])


def test_a_read_only_file_is_left_as_it_is(catalog, store, tmp_path, monkeypatch) -> None:
    # Marked read-only by its owner, a file is not replaced: the reading is refused, where
    # it used to be replaced all the same and then stood in the way of every later one.
    folder = separated(catalog, store, tmp_path)
    find_notes(folder, ["Tune - bass.wav"])
    midi = folder / "Tune - bass.mid"
    midi.chmod(stat.S_IREAD)
    try:
        held = files_of(folder)
        with pytest.raises(DomainError, match=r"Tune - bass\.mid is read-only"):
            find_notes(folder, ["Tune - bass.wav"])
        with monkeypatch.context() as patched:  # nor taken away
            patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
            with pytest.raises(DomainError, match="read-only"):
                find_notes(folder, ["Tune - bass.wav"])
        assert files_of(folder) == held
        # Another stem's reading goes through and leaves it alone.
        find_notes(folder, ["Tune - vocals.wav"])
        assert midi.read_bytes() == held["Tune - bass.mid"] and not list(folder.glob("*.tmp"))
    finally:
        midi.chmod(stat.S_IWRITE | stat.S_IREAD)
    find_notes(folder, ["Tune - bass.wav"])
    assert keys_of(midi) == WANTED and not list(folder.glob("*.tmp"))


def test_a_disk_that_stays_full_still_gets_everything_back(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Room for the manifest and then no more, for good: every write after it fails, those of
    # putting things back included. Putting back is renames, which need no room.
    folder = separated(catalog, store, tmp_path)
    find_notes(folder, ["Tune - bass.wav"])
    held = files_of(folder)
    write = Path.write_bytes
    for room_for in range(6):
        written: list[Path] = []

        def full(
            self: Path, data: bytes, room_for: int = room_for, written: list[Path] = written
        ) -> int:
            if self.parent == folder:
                written.append(self)
                if len(written) > room_for:
                    write(self, data[:10])
                    raise OSError(28, "No space left on device", str(self))
            return write(self, data)

        with monkeypatch.context() as patched:
            patched.setattr(Path, "write_bytes", full)
            patched.setattr(notes_module, "METHOD", "another transcriber")  # other bytes
            with pytest.raises(DomainError, match="No space left on device"):
                find_notes(folder, ["Tune - bass.wav", "Tune - vocals.wav"])
        assert files_of(folder) == held, room_for


def test_a_name_in_a_manifest_that_leaves_its_folder_is_not_followed(
    catalog, store, tmp_path
) -> None:
    # A stem's files are joined to its folder and then moved, written over and removed. A
    # manifest somebody made by hand could name "../../x" and have the app remove x.
    folder = separated(catalog, store, tmp_path)
    outside = folder.parent / "precious.mid"
    outside.write_bytes(b"not a stem's")
    manifest = read_manifest(folder)
    assert manifest is not None
    good = (folder / "manifest.json").read_bytes()
    for field, name in (
        ("midi", "../precious.mid"),
        ("notes", "..\\precious.mid"),
        ("midi", str(outside)),
        ("file", "../Tune - bass.wav"),
        ("midi", ".."),
        ("peaks", "../../x.json"),
        ("peaks", "/x.json"),
        ("peaks", "\\x.json"),
        ("peaks", "C:x.json"),
    ):
        crafted = json.loads(good)
        crafted["stems"][0][field] = name
        (folder / "manifest.json").write_text(json.dumps(crafted), encoding="utf-8")
        assert read_manifest(folder) is None, name
        with pytest.raises(DomainError, match="does not hold a set of stems"):
            find_notes(folder, ["Tune - bass.wav"])
        with pytest.raises(DomainError, match="does not hold a set of stems"):
            set_analysis(folder, {"bpm": 90})
    assert outside.read_bytes() == b"not a stem's"
    (folder / "manifest.json").write_bytes(good)
    assert read_manifest(folder) is not None
    # A manifest nested deeper than can be read is no manifest, not a fault.
    (folder / "manifest.json").write_text("[" * 100_000, encoding="utf-8")
    assert read_manifest(folder) is None
    # A stem with no MIDI or notes file names none, however that is written.
    for nothing in (None, ""):
        plain = json.loads(good)
        plain["stems"][0]["midi"] = nothing
        plain["stems"][0]["notes"] = nothing
        (folder / "manifest.json").write_text(json.dumps(plain), encoding="utf-8")
        assert read_manifest(folder) is not None
    (folder / "manifest.json").write_bytes(good)


def test_why_nothing_was_written_is_said_as_the_system_means_it() -> None:
    # Windows refuses to read, move or replace a file another program has open. A Mac does
    # none of that, so being refused there means the app is not allowed to.
    refused = PermissionError(13, "Permission denied", "/Music/OpenStems/Tune/x/Tune - bass.mid")
    elsewhere = "a file of this song is open in another program"
    not_allowed = "the app is not allowed to read or write a file of this song"
    assert notes_module._why(refused, "win32") == (
        f"{elsewhere}, so its notes were not written (Tune - bass.mid)"
    )
    assert notes_module._why(refused, "darwin") == (
        f"{not_allowed}, so its notes were not written (Tune - bass.mid)"
    )
    # A new tempo and a rename say it the same way. Only on Windows is there a program to
    # close.
    why = notes_module.why_refused
    assert why(refused, "nothing was changed", "Tune - bass.mid", "win32") == (
        f"{elsewhere}, so nothing was changed (Tune - bass.mid). Close it there and try again."
    )
    assert why(refused, "nothing was changed", "Tune - bass.mid", "darwin") == (
        f"{not_allowed}, so nothing was changed (Tune - bass.mid)."
    )
    assert why(refused, "nothing was renamed", platform="win32") == (
        f"{elsewhere}, so nothing was renamed. Close it there and try again."
    )
    assert why(refused, "nothing was renamed", platform="darwin") == (
        f"{not_allowed}, so nothing was renamed."
    )
    assert REFUSED in str(why(refused, "nothing was changed"))  # what the other tests go by
    full = OSError(28, "No space left on device", "/Music/OpenStems/Tune/x/Tune - bass.mid")
    for platform in ("win32", "darwin"):
        assert notes_module._why(full, platform) == (
            "the notes could not be written: No space left on device (Tune - bass.mid)"
        )
        assert why(full, "nothing was changed", platform=platform) is None


def test_a_file_that_appears_while_a_stem_is_read_is_not_written_over(
    catalog, store, tmp_path
) -> None:
    folder = separated(catalog, store, tmp_path)
    reading = read_stems(folder, ["Tune - bass.wav"])
    (folder / "Tune - bass.mid").write_bytes(b"saved there meanwhile")  # the seconds it took
    held = files_of(folder)
    with pytest.raises(DomainError, match="already in the stem folder"):
        write_notes(folder, reading)
    assert files_of(folder) == held


def test_the_midi_file_is_the_notes_file_and_three_things_from_the_manifest(
    catalog, store, tmp_path
) -> None:
    # Wherever a MIDI file is written, it is `midi_from_sidecar` of the notes file beside it,
    # to the byte: a song whose file name starts with a space used to be an exception.
    source = tmp_path / " Lead in.wav"
    source.write_bytes(tune(tmp_path).read_bytes())
    options = RunOptions(midi_stems=["vocals"])
    result = Pipeline(catalog, store).run(source, vocals_only(), tmp_path / "out", options)
    folder = Path(result.directory)

    def made(manifest: dict[str, Any]) -> bytes | None:
        stem = manifest["stems"][0]
        sidecar = json.loads((folder / stem["notes"]).read_text("utf-8"))
        analysis = manifest["analysis"]
        name = track_name(manifest["source"]["name"], stem["name"])
        return midi_from_sidecar(
            sidecar, name=name, bpm=analysis.get("bpm"), key=analysis.get("key")
        )

    def on_disk(manifest: dict[str, Any]) -> bytes:
        return (folder / manifest["stems"][0]["midi"]).read_bytes()

    assert made(result.manifest) == on_disk(result.manifest)
    retagged = set_analysis(folder, {"bpm": 96, "key": "Dm"})
    assert made(retagged) == on_disk(retagged)
    found = find_notes(folder, [result.manifest["stems"][0]["file"]])
    assert made(found) == on_disk(found) and not changed(folder, found["stems"][0])
    folder = rename_song(folder, "Night Drive")[-1].now
    renamed = read_manifest(folder)
    assert renamed is not None and made(renamed) == on_disk(renamed)
    assert b"Night Drive vocals" in on_disk(renamed) and not changed(folder, renamed["stems"][0])


def test_files_the_app_made_are_a_stems_own_though_no_manifest_names_them(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # A version that wrote its manifest last, cut short, left a notes file and a MIDI file
    # no manifest named, and they were in the way of that stem for ever. They are told from
    # a user's files by what they hold: a notes file of the app's for this stem, and the
    # MIDI file made from it, to the byte.
    folder = separated(catalog, store, tmp_path)
    unread = (folder / "manifest.json").read_bytes()
    find_notes(folder, ["Tune - bass.wav"])
    (folder / "manifest.json").write_bytes(unread)  # both files there, neither named
    manifest = find_notes(folder, ["Tune - bass.wav"])
    assert by_name(manifest)["bass"]["notes"] == "Tune - bass.notes.json"
    assert keys_of(folder / "Tune - bass.mid") == WANTED and not list(folder.glob("*.tmp"))
    # With no notes this time, the MIDI file the app left goes with the reading.
    (folder / "manifest.json").write_bytes(unread)
    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
        manifest = find_notes(folder, ["Tune - bass.wav"])
    assert by_name(manifest)["bass"]["midi"] is None
    assert not (folder / "Tune - bass.mid").exists() and not list(folder.glob("*.tmp"))

    # What is not the app's for this stem stays in the way: a notes file for another stem
    # under this one's name, and a MIDI file that is not what the app makes of the notes
    # file beside it.
    find_notes(folder, ["Tune - bass.wav"])
    notes_file, midi_file = folder / "Tune - bass.notes.json", folder / "Tune - bass.mid"
    own = json.loads(notes_file.read_text("utf-8"))
    (folder / "manifest.json").write_bytes(unread)
    notes_file.write_text(json.dumps({**own, "stem": "vocals"}), encoding="utf-8")
    with pytest.raises(DomainError, match=r"bass\.notes\.json is already in the stem folder"):
        find_notes(folder, ["Tune - bass.wav"])
    notes_file.write_text(json.dumps(own), encoding="utf-8")
    midi_file.write_bytes(b"somebody's own")
    with pytest.raises(DomainError, match=r"bass\.mid is already in the stem folder"):
        find_notes(folder, ["Tune - bass.wav"])
    assert midi_file.read_bytes() == b"somebody's own"


def test_a_file_the_manifest_does_not_name_is_never_touched(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Melodyne saves the MIDI it exports as <audio name>.mid beside the audio: a file of the
    # user's under the very name a stem's own MIDI takes. Only the manifest says which files
    # are a stem's own, so that one is neither written over nor taken away.
    folder = separated(catalog, store, tmp_path)
    with monkeypatch.context() as patched:  # the stem was read once, and held no notes
        patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
        first = find_notes(folder, ["Tune - bass.wav"])
    assert by_name(first)["bass"]["notes"] and by_name(first)["bass"]["midi"] is None
    (folder / "Tune - bass.mid").write_bytes(b"the user's own notes, from Melodyne")
    (folder / "Tune - vocals.notes.json").write_text("something of the user's", "utf-8")
    held = files_of(folder)
    for files in (["Tune - bass.wav"], ["Tune - vocals.wav"]):
        with pytest.raises(DomainError, match="already in the stem folder"):
            find_notes(folder, files)  # notes are found: they would go to that name
    with monkeypatch.context() as patched:  # none are found: a MIDI file would be taken away
        patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
        with pytest.raises(DomainError, match="already in the stem folder"):
            find_notes(folder, ["Tune - bass.wav"])
    assert files_of(folder) == held
    # A song from the cache says so on its job, and leaves the file alone too.
    run = Pipeline(catalog, store).run
    (folder / "Tune - guitar.mid").write_bytes(b"another of the user's")
    again = run(tune(tmp_path), full_song(), tmp_path / "out", RunOptions(midi_stems=["guitar"]))
    assert again.cached and "Tune - guitar.mid is already in the stem folder" in "".join(
        again.manifest["notes"]
    )
    assert (folder / "Tune - guitar.mid").read_bytes() == b"another of the user's"


def test_a_write_that_fails_puts_every_file_back(catalog, store, tmp_path, monkeypatch) -> None:
    folder = separated(catalog, store, tmp_path)
    find_notes(folder, ["Tune - bass.wav"])
    held = files_of(folder)
    real = os.replace

    def in_use(src: Any, dst: Any) -> None:
        if Path(dst).name == "manifest.json":
            raise PermissionError(13, "in use", str(dst))
        real(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.notes.os.replace", in_use)
        patched.setattr(notes_module, "METHOD", "another transcriber")  # so the bytes differ
        with pytest.raises(DomainError, match=REFUSED):
            find_notes(folder, ["Tune - bass.wav", "Tune - vocals.wav"])
    # The bass's files hold what they held, the vocals' new ones are gone, no temp file.
    assert files_of(folder) == held

    def last_in_use(src: Any, dst: Any) -> None:
        if Path(dst).name == "Tune - vocals.mid":  # the last file, after the manifest
            raise PermissionError(13, "in use", str(dst))
        real(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr("openstems.pipeline.notes.os.replace", last_in_use)
        patched.setattr(notes_module, "METHOD", "another transcriber")
        with pytest.raises(DomainError, match=REFUSED + r".*Tune - vocals\.mid"):
            find_notes(folder, ["Tune - bass.wav", "Tune - vocals.wav"])
    assert files_of(folder) == held  # the manifest too is as it was


def test_a_stem_that_cannot_be_read_is_refused_in_plain_words(
    catalog, store, tmp_path, monkeypatch
) -> None:
    folder = separated(catalog, store, tmp_path)
    audio = (folder / "Tune - bass.wav").read_bytes()
    (folder / "Tune - bass.wav").write_bytes(b"not audio at all")
    held = files_of(folder)
    with pytest.raises(DomainError, match="cannot read the notes of Tune - bass"):
        find_notes(folder, ["Tune - vocals.wav", "Tune - bass.wav"])
    assert files_of(folder) == held
    (folder / "Tune - bass.wav").write_bytes(audio)

    def broken(*_: Any, **__: Any) -> Transcription:
        raise RuntimeError("the pitch tracker would not start")

    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "transcribe_line", broken)
        with pytest.raises(DomainError, match="cannot read the notes of"):
            find_notes(folder, ["Tune - bass.wav"])
    assert not list(folder.glob("*.notes.json"))


def test_a_midi_file_open_elsewhere_stops_the_write_before_it_starts(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # A stem that had notes holds none this time, so its MIDI file goes. Open in a DAW it
    # cannot: then nothing is changed, where once the manifest dropped it and the file stayed
    # behind, in the way of every reading after.
    folder = separated(catalog, store, tmp_path)
    find_notes(folder, ["Tune - bass.wav"])
    held = files_of(folder)
    real = os.replace

    def in_use(src: Any, dst: Any) -> None:
        if str(src).endswith(".mid"):
            raise PermissionError(13, "in use", str(src))
        real(src, dst)

    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
        patched.setattr("openstems.pipeline.notes.os.replace", in_use)
        with pytest.raises(DomainError, match=REFUSED):
            find_notes(folder, ["Tune - bass.wav"])
    assert files_of(folder) == held
    # Closed there, it goes with the reading that finds no notes, and nothing is left behind.
    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "transcribe_line", lambda *_, **__: Transcription())
        manifest = find_notes(folder, ["Tune - bass.wav"])
    assert by_name(manifest)["bass"]["midi"] is None and read_manifest(folder) == manifest
    assert not (folder / "Tune - bass.mid").exists() and not list(folder.glob("*.tmp"))
    # The next reading that finds notes writes it again.
    manifest = find_notes(folder, ["Tune - bass.wav"])
    assert by_name(manifest)["bass"]["midi"] == "Tune - bass.mid"
    assert keys_of(folder / "Tune - bass.mid") == WANTED


def test_one_tuning_for_a_song_whichever_stem_is_read_first(catalog, store, tmp_path) -> None:
    # A voice follows the song's tuning and does not set it, so read first it is written at
    # A440; the bass, read later, settles the tuning, and the voice's MIDI file is rounded
    # again in it. Read in the other order the answer is the same.
    pipeline = Pipeline(catalog, store)

    def tunings(folder: Path) -> dict[str, float]:
        return {name: tuning_of(folder, name) for name in ("vocals", "bass")}

    for order in (("vocals", "bass"), ("bass", "vocals")):
        run = pipeline.run(sharp_source(tmp_path), full_song(), tmp_path / order[0])
        folder = Path(run.directory)
        find_notes(folder, [f"Sharp - {order[0]}.wav"])
        first = tuning_of(folder, order[0])
        if order[0] == "vocals":
            assert first == 0.0 and keys_of(folder / "Sharp - vocals.mid") == AT_A440
        else:
            assert first == SHARP_BY
        find_notes(folder, [f"Sharp - {order[1]}.wav"])
        found = tunings(folder)
        assert found["bass"] == found["vocals"] == SHARP_BY, order
        assert keys_of(folder / "Sharp - vocals.mid") == IN_TUNE, order
        assert keys_of(folder / "Sharp - bass.mid") == IN_TUNE, order
        assert not list(folder.glob("*.tmp"))
    # A stem read again sets nothing by what its own old file says.
    stale_file = folder / "Sharp - bass.notes.json"
    old = json.loads(stale_file.read_text("utf-8"))
    stale_file.write_text(json.dumps({**old, "tuning_cents": -40.0}), encoding="utf-8")
    find_notes(folder, ["Sharp - bass.wav"])
    assert tunings(folder)["bass"] == SHARP_BY


# A song some 35 cents sharp whose last note is 62 cents over its key. Rounded at A440 that
# note is the key above; rounded in the song's own tuning it is the key it was meant as. So
# the keys tell which tuning a MIDI file was rounded in, not only the figure in a notes file.
# Seven notes agree on the tuning, so the eighth does not unsettle it.
SHARP = [57.35, 60.35, 64.35, 67.35, 64.35, 60.35, 57.35, 69.62]
AT_A440 = [57, 60, 64, 67, 64, 60, 57, 70]
IN_TUNE = [57, 60, 64, 67, 64, 60, 57, 69]
SHARP_BY = pytest.approx(36, abs=5)  # cents


def sharp_source(tmp_path: Path) -> Path:
    source = tmp_path / "Sharp.wav"
    if not source.is_file():
        mono = sung(SHARP)
        write_audio(source, np.stack([mono, mono]), RATE)
    return source


def sharp_song(catalog: Any, store: Any, tmp_path: Path) -> Path:
    """Six stems of that song, the vocals read: a voice sets no tuning, so their files are
    on A440."""
    run = Pipeline(catalog, store).run
    folder = Path(run(sharp_source(tmp_path), full_song(), tmp_path / "out").directory)
    find_notes(folder, ["Sharp - vocals.wav"])
    assert keys_of(folder / "Sharp - vocals.mid") == AT_A440
    return folder


def tuning_of(folder: Path, stem: str) -> float:
    return json.loads((folder / f"Sharp - {stem}.notes.json").read_text("utf-8"))["tuning_cents"]


def test_a_reading_of_one_stem_leaves_anothers_changed_midi_alone(catalog, store, tmp_path) -> None:
    # The bass settles another tuning, and the vocals' MIDI file would be rounded again in
    # it. Changed by somebody since the app wrote it, it is theirs: only the notes file
    # takes the new tuning.
    folder = sharp_song(catalog, store, tmp_path)
    (folder / "Sharp - vocals.mid").write_bytes(b"somebody's own")
    find_notes(folder, ["Sharp - bass.wav"])
    assert (folder / "Sharp - vocals.mid").read_bytes() == b"somebody's own"
    assert tuning_of(folder, "vocals") == tuning_of(folder, "bass") == SHARP_BY
    assert keys_of(folder / "Sharp - bass.mid") == IN_TUNE


def test_a_change_of_tuning_cut_short_is_finished_by_the_next_reading(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Reading the bass settles the song's tuning, so the vocals' MIDI file is rounded again
    # and then their notes file says so. Ended between the two, the notes file still says
    # A440, and the next reading does both again. In the other order the notes file would
    # say the new tuning with the MIDI file on A440 for good.
    folder = sharp_song(catalog, store, tmp_path)
    assert tuning_of(folder, "vocals") == 0.0
    # Ended before the vocals' MIDI file is replaced: the manifest, written first, holds
    # the hash of the file to come, and the file still holds what the app wrote before.
    # That is the app's own too, and is not taken for one somebody changed.
    with ended_at(monkeypatch, "Sharp - vocals.mid"), pytest.raises(SystemExit):
        find_notes(folder, ["Sharp - bass.wav"])
    left = read_manifest(folder)
    assert left is not None and keys_of(folder / "Sharp - vocals.mid") == AT_A440
    assert not changed(folder, by_name(left)["vocals"])
    with ended_at(monkeypatch, second_of="Sharp - vocals"), pytest.raises(SystemExit):
        find_notes(folder, ["Sharp - bass.wav"])
    assert keys_of(folder / "Sharp - vocals.mid") == IN_TUNE and tuning_of(folder, "vocals") == 0.0
    assert tuning_of(folder, "bass") == SHARP_BY
    find_notes(folder, ["Sharp - bass.wav"])
    assert tuning_of(folder, "vocals") == tuning_of(folder, "bass") == SHARP_BY
    assert keys_of(folder / "Sharp - vocals.mid") == IN_TUNE
    assert keys_of(folder / "Sharp - bass.mid") == IN_TUNE
    # Read once more, nothing is written that is as it should be already.
    held = files_of(folder)
    find_notes(folder, ["Sharp - bass.wav"])
    assert files_of(folder) == held and not list(folder.glob("*.tmp"))
    # A MIDI file that has gone missing is made again with any reading of the song.
    (folder / "Sharp - vocals.mid").unlink()
    find_notes(folder, ["Sharp - bass.wav"])
    assert files_of(folder) == held


def test_another_stems_damaged_notes_file_is_left_out_and_left_alone(
    catalog, store, tmp_path, monkeypatch
) -> None:
    folder = sharp_song(catalog, store, tmp_path)
    notes_file = folder / "Sharp - vocals.notes.json"
    good = notes_file.read_text("utf-8")
    huge = good.replace('"threshold":', '"threshold":1' + "0" * 400 + ',"was":', 1)
    for damaged in (huge, "[" * 100_000, "not a notes file", ""):
        notes_file.write_text(damaged, encoding="utf-8")
        manifest = find_notes(folder, ["Sharp - bass.wav"])  # no fault of the bass's
        assert by_name(manifest)["bass"]["midi"] == "Sharp - bass.mid"
        assert notes_file.read_text("utf-8") == damaged
        assert stale(notes_file)
    # One that is there and cannot be read now stops the write: decided without it, the
    # song's tuning could be another than the vocals' MIDI file is on.
    notes_file.write_text(good, encoding="utf-8")
    (folder / "Sharp - bass.notes.json").unlink()
    (folder / "Sharp - bass.mid").unlink()
    held = files_of(folder)
    locked = held_open(monkeypatch, notes_file.name)
    with locked, pytest.raises(DomainError, match=REFUSED):
        find_notes(folder, ["Sharp - bass.wav"])
    assert files_of(folder) == held


def test_a_reading_takes_back_what_was_said_of_the_stem(catalog, store, tmp_path) -> None:
    folder = separated(catalog, store, tmp_path)
    manifest = read_manifest(folder)
    assert manifest is not None
    manifest["notes"] = [failed_note("bass"), failed_note("vocals"), "something else"]
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert find_notes(folder, ["Tune - bass.wav"])["notes"] == [
        failed_note("vocals"),
        "something else",
    ]


def test_notes_are_found_in_stems_that_are_not_wav(catalog, store, tmp_path) -> None:
    folder = separated(catalog, store, tmp_path, output_format="flac")
    manifest = find_notes(folder, ["Tune - bass.flac", "Tune - vocals.flac"])
    stems = by_name(manifest)
    assert stems["bass"]["notes"] == "Tune - bass.notes.json"
    assert stems["bass"]["midi"] == "Tune - bass.mid"
    assert keys_of(folder / "Tune - bass.mid") == WANTED
    assert keys_of(folder / "Tune - vocals.mid") == WANTED


def test_a_stem_with_chords_says_so(catalog, store, tmp_path) -> None:
    source = tmp_path / "Chords.wav"
    triads = np.concatenate(
        [
            sum(sung([root + k], seconds=1.0, gap=0.05) for k in (0, 4, 7, 12))
            for root in (48, 53, 55)
        ]
    )
    write_audio(source, np.stack([triads, triads]).astype(np.float32), RATE)
    said = "guitar plays chords: its MIDI holds one line of them"
    pipeline = Pipeline(catalog, store)
    # Read with the song: the job's notes say it, and the notes file marks the stem.
    options = RunOptions(midi_stems=["guitar", "bass"])
    result = pipeline.run(source, full_song(), tmp_path / "with", options)
    assert said in result.manifest["notes"]
    notes_file = Path(result.directory) / "Chords - guitar.notes.json"
    assert json.loads(notes_file.read_text("utf-8"))["texture"] == "chords"
    # Read afterwards: said once, however often it is asked.
    later = pipeline.run(source, full_song(), tmp_path / "later")
    folder = Path(later.directory)
    assert said not in (later.manifest.get("notes") or [])
    for _ in range(2):
        manifest = find_notes(folder, ["Chords - guitar.wav"])
        assert manifest["notes"].count(said) == 1


def done_job(client: TestClient, songs: list[Path], **options: Any) -> dict[str, Any]:
    body = {"path": str(songs[0]), "recipe": "full-song", "options": options}
    assert client.post("/v1/jobs", json=body).status_code == 200
    return wait_for(client, all_terminal)[0]


def test_the_api_finds_notes_in_a_finished_songs_stems(
    client: TestClient, songs: list[Path]
) -> None:
    job = done_job(client, songs)
    stems = {s["name"]: s for s in job["stems"]}
    assert stems["bass"]["midi"] is None and stems["bass"]["notes"] is None

    response = client.post("/v1/notes", json={"paths": [stems["bass"]["path"]]})
    assert response.status_code == 200, response.text
    found = {s["name"]: s for s in response.json()["stems"]}
    notes_path = Path(found["bass"]["notes"])
    assert notes_path.name == f"{songs[0].stem} - bass.notes.json" and notes_path.is_file()
    assert from_sidecar(json.loads(notes_path.read_text("utf-8")))[1]["stem"] == "bass"
    assert found["vocals"]["notes"] is None
    # The job and the history both show them now, and the files are served.
    listed = {s["name"]: s for s in client.get("/v1/jobs").json()["jobs"][0]["stems"]}
    assert listed["bass"]["notes"] == found["bass"]["notes"]
    assert listed["bass"]["midi"] == found["bass"]["midi"]
    assert client.get("/v1/files", params={"path": str(notes_path)}).status_code == 200

    assert client.post("/v1/notes", json={"paths": []}).status_code == 400
    assert client.post("/v1/notes", json={"paths": [stems["drums"]["path"]]}).status_code == 400
    other = Path(job["output_dir"]).parent / "elsewhere.wav"
    assert client.post("/v1/notes", json={"paths": [str(other)]}).status_code == 400


def test_the_api_keeps_what_is_changed_while_notes_are_being_found(
    client: TestClient, songs: list[Path], tmp_path: Path, monkeypatch
) -> None:
    body = {"path": str(tune(tmp_path)), "recipe": "full-song", "options": {}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    job = wait_for(client, all_terminal)[0]
    directory = job["output_dir"]
    bass = {s["name"]: s for s in job["stems"]}["bass"]["path"]
    reading, go_on = threading.Event(), threading.Event()
    real = notes_module.transcribe_line

    def slow(*args: Any, **kwargs: Any) -> Transcription:
        reading.set()
        assert go_on.wait(30)
        return real(*args, **kwargs)

    monkeypatch.setattr(notes_module, "transcribe_line", slow)
    answers: list[Any] = []
    asked = threading.Thread(
        target=lambda: answers.append(client.post("/v1/notes", json={"paths": [bass]}))
    )
    asked.start()
    try:
        assert reading.wait(30)
        # While the stem is being read: a tempo typed and a stem hidden. Neither waits.
        tempo = {"directory": directory, "bpm": 97}
        assert client.post("/v1/stemsets/analysis", json=tempo).status_code == 200
        hidden = {"directory": directory, "stems": {"piano": True}}
        assert client.post("/v1/stemsets/hidden", json=hidden).status_code == 200
    finally:
        go_on.set()
        asked.join(30)
    assert answers and answers[0].status_code == 200, answers and answers[0].text
    manifest = read_manifest(Path(directory))
    assert manifest is not None and manifest["analysis"]["bpm"] == 97.0
    stems = by_name(manifest)
    assert stems["piano"]["hidden"] is True and stems["bass"]["notes"]
    midi = (Path(directory) / stems["bass"]["midi"]).read_bytes()
    assert read_midi_notes(midi)[1] == pytest.approx(97.0, abs=0.001)
    # The answer, the queue and the history say the same as the disk.
    for seen in (answers[0].json(), client.get("/v1/stemsets").json()["stem_sets"][0]):
        assert seen["analysis"]["bpm"] == 97.0
        listed = {s["name"]: s for s in seen["stems"]}
        assert listed["piano"]["hidden"] is True and listed["bass"]["notes"]
    listed = {s["name"]: s for s in client.get("/v1/jobs").json()["jobs"][0]["stems"]}
    assert listed["bass"]["notes"] and listed["bass"]["midi"]


def test_the_api_refuses_changes_to_a_folder_that_is_being_written(
    client: TestClient, songs: list[Path], monkeypatch
) -> None:
    # While a song is separated again, whatever is changed in its stem folder is gone when
    # the run replaces the folder. (The check there was could never say yes: it asked the
    # running job for its output folder, which a job has only once it is done.)
    job = done_job(client, songs)
    directory = job["output_dir"]
    bass = {s["name"]: s for s in job["stems"]}["bass"]["path"]
    asks = (
        ("/v1/notes", {"paths": [bass]}),
        ("/v1/stemsets/analysis", {"directory": directory, "bpm": 90}),
        ("/v1/stemsets/hidden", {"directory": directory, "stems": {"piano": True}}),
    )
    held = files_of(Path(directory))
    again = {**job, "state": "running"}
    with monkeypatch.context() as patched:  # the same song and recipe is on the GPU again
        patched.setattr(service_of(client).jobs, "running", lambda: again)
        for route, body in asks:
            answer = client.post(route, json=body)
            assert answer.status_code == 400 and "being separated again" in answer.text, route
    assert files_of(Path(directory)) == held
    # Another song running, or this one with another recipe, is no reason to refuse.
    for other in ({**again, "track_path": str(songs[1])}, {**again, "recipe_id": "vocals"}):
        with monkeypatch.context() as patched:
            patched.setattr(service_of(client).jobs, "running", lambda other=other: other)
            for route, body in asks:
                assert client.post(route, json=body).status_code == 200, route


def test_the_api_refuses_notes_when_the_song_starts_again_while_they_are_read(
    client: TestClient, songs: list[Path], monkeypatch
) -> None:
    job = done_job(client, songs)
    directory = Path(job["output_dir"])
    bass = {s["name"]: s for s in job["stems"]}["bass"]["path"]
    reading: list[bool] = []
    real = notes_module.transcribe_line

    def read(*args: Any, **kwargs: Any) -> Transcription:
        reading.append(True)
        return real(*args, **kwargs)

    again = {**job, "state": "running"}
    held = files_of(directory)
    with monkeypatch.context() as patched:  # free when asked, running by the time it is read
        patched.setattr(notes_module, "transcribe_line", read)
        patched.setattr(service_of(client).jobs, "running", lambda: again if reading else None)
        answer = client.post("/v1/notes", json={"paths": [bass]})
    assert reading and answer.status_code == 400 and "being separated again" in answer.text
    assert files_of(directory) == held


def test_a_rename_holds_the_stem_folders_under_both_their_names(
    client: TestClient, songs: list[Path], monkeypatch
) -> None:
    import openstems.pipeline.rename as rename_module
    from openstems.api.service import _path_key

    job = done_job(client, songs)
    directory = Path(job["output_dir"])
    service = service_of(client)
    real = rename_module.rename_song
    held: dict[str, bool] = {}

    def watched(folder: Path, name: str) -> Any:
        to = folder.parent.parent / name / folder.name
        for label, path in (("as it is", folder), ("as it will be", to)):
            held[label] = service._lock("folder", _path_key(str(path))).locked()
        return real(folder, name)

    monkeypatch.setattr(rename_module, "rename_song", watched)
    body = {"directory": str(directory), "name": "Night Drive"}
    answer = client.post("/v1/stemsets/name", json=body)
    assert answer.status_code == 200, answer.text
    assert held == {"as it is": True, "as it will be": True}
    # And lets them go.
    for path in (directory, directory.parent.parent / "Night Drive" / directory.name):
        assert not service._lock("folder", _path_key(str(path))).locked()


def test_the_api_refuses_a_stem_it_cannot_read(client: TestClient, songs: list[Path]) -> None:
    job = done_job(client, songs)
    bass = Path({s["name"]: s for s in job["stems"]}["bass"]["path"])
    bass.write_bytes(b"not audio at all")
    response = client.post("/v1/notes", json={"paths": [str(bass)]})
    assert response.status_code == 400 and "cannot read the notes of" in response.text
    assert not list(bass.parent.glob("*.notes.json"))


def test_a_job_with_midi_lists_its_notes(client: TestClient, songs: list[Path]) -> None:
    job = done_job(client, songs, midi_stems=["bass", "vocals", "drums"])
    stems = {s["name"]: s for s in job["stems"]}
    assert stems["bass"]["notes"] and Path(stems["bass"]["notes"]).is_file()
    assert stems["drums"]["notes"] is None and stems["drums"]["midi"] is None
