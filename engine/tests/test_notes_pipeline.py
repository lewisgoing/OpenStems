"""Stem to MIDI around a run (Phase 7, stage M3): the notes file and the MIDI file a run
writes beside a stem, what a new tempo or name does to them, and reading a stem that is
already written (`pipeline/notes.py`, `POST /v1/notes`)."""

from __future__ import annotations

import contextlib
import json
import os
import threading
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
from openstems.pipeline.levels import set_hidden
from openstems.pipeline.notes import (
    failed_note,
    find_notes,
    midi_from_sidecar,
    read_stems,
    readable,
    song_tuning,
    stale,
    write_notes,
)
from openstems.pipeline.rename import rename_song
from openstems.pipeline.retag import set_analysis
from openstems.pipeline.run import Pipeline, RunOptions, read_manifest, stem_set_from_manifest
from tests.conftest import RATE
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


@contextlib.contextmanager
def ended_at(monkeypatch: pytest.MonkeyPatch, file: str) -> Iterator[None]:
    """Within it, the process "ends" as `write_notes` is about to write ``file``: nothing
    after that is written and nothing is put back, as when a process is killed."""
    swap, whole = notes_module._swap, notes_module._whole
    wrote: list[Path] = []

    def swap_or_end(path: Path, data: bytes, parked: Any) -> None:
        if path.name == file:
            raise SystemExit("the process ends here")
        swap(path, data, parked)

    def once(path: Path, data: bytes) -> None:
        if not wrote:  # the write itself; what would put the old manifest back is not run
            wrote.append(path)
            whole(path, data)

    with monkeypatch.context() as patched:
        patched.setattr(notes_module, "_swap", swap_or_end)
        patched.setattr(notes_module, "_whole", once)
        patched.setattr(notes_module, "_undo", lambda parked: None)
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
    del manifest["stems"][0]["notes"]  # as an earlier version wrote it
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
        with pytest.raises(DomainError, match="open in another program"):
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
    with locked, pytest.raises(DomainError, match="open in another program"):
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


def test_a_new_name_takes_both_files_along(catalog, store, tmp_path) -> None:
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
        with pytest.raises(DomainError, match="open in another program"):
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
        with pytest.raises(DomainError, match=r"open in another program.*Tune - vocals\.mid"):
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
        with pytest.raises(DomainError, match="open in another program"):
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
    # A song 30 cents sharp. A voice follows the song's tuning and does not set it, so read
    # first it is written at A440; the bass, read later, settles the tuning, and the voice's
    # files follow. Read in the other order the answer is the same.
    source = tmp_path / "Sharp.wav"
    mono = sung([note + 0.3 for note in WANTED])
    write_audio(source, np.stack([mono, mono]), RATE)
    pipeline = Pipeline(catalog, store)

    def tunings(folder: Path) -> dict[str, float]:
        files = folder.glob("*.notes.json")
        return {
            f.name.split(" - ")[1].split(".")[0]: json.loads(f.read_text("utf-8"))["tuning_cents"]
            for f in files
        }

    for order in (("vocals", "bass"), ("bass", "vocals")):
        folder = Path(pipeline.run(source, full_song(), tmp_path / order[0]).directory)
        find_notes(folder, [f"Sharp - {order[0]}.wav"])
        first = tunings(folder)[order[0]]
        assert first == (0.0 if order[0] == "vocals" else pytest.approx(30, abs=4))
        find_notes(folder, [f"Sharp - {order[1]}.wav"])
        found = tunings(folder)
        assert found["bass"] == found["vocals"] == pytest.approx(30, abs=4), order
        assert keys_of(folder / "Sharp - vocals.mid") == WANTED
        assert keys_of(folder / "Sharp - bass.mid") == WANTED
        assert not list(folder.glob("*.tmp"))
    # A stem read again sets nothing by what its own old file says.
    stale_file = folder / "Sharp - bass.notes.json"
    old = json.loads(stale_file.read_text("utf-8"))
    stale_file.write_text(json.dumps({**old, "tuning_cents": -40.0}), encoding="utf-8")
    find_notes(folder, ["Sharp - bass.wav"])
    assert tunings(folder)["bass"] == pytest.approx(30, abs=4)


def sharp_song(catalog: Any, store: Any, tmp_path: Path) -> Path:
    """Six stems of a song 30 cents sharp, the vocals read: their files are on A440."""
    source = tmp_path / "Sharp.wav"
    mono = sung([note + 0.3 for note in WANTED])
    write_audio(source, np.stack([mono, mono]), RATE)
    folder = Path(Pipeline(catalog, store).run(source, full_song(), tmp_path / "out").directory)
    find_notes(folder, ["Sharp - vocals.wav"])
    return folder


def tuning_of(folder: Path, stem: str) -> float:
    return json.loads((folder / f"Sharp - {stem}.notes.json").read_text("utf-8"))["tuning_cents"]


def test_a_change_of_tuning_cut_short_is_finished_by_the_next_reading(
    catalog, store, tmp_path, monkeypatch
) -> None:
    # Reading the bass settles the song's tuning, so the vocals' MIDI file is rounded again
    # and then their notes file says so. Ended between the two, the notes file still says
    # A440, and the next reading does both again. In the other order the notes file would
    # say 30 cents with the MIDI file on A440 for good.
    folder = sharp_song(catalog, store, tmp_path)
    assert tuning_of(folder, "vocals") == 0.0
    with ended_at(monkeypatch, "Sharp - vocals.notes.json"), pytest.raises(SystemExit):
        find_notes(folder, ["Sharp - bass.wav"])
    assert tuning_of(folder, "bass") == pytest.approx(30, abs=4)
    assert tuning_of(folder, "vocals") == 0.0
    find_notes(folder, ["Sharp - bass.wav"])
    assert tuning_of(folder, "vocals") == tuning_of(folder, "bass") == pytest.approx(30, abs=4)
    # Read once more, nothing is written that is as it should be already.
    held = files_of(folder)
    find_notes(folder, ["Sharp - bass.wav"])
    assert files_of(folder) == held and not list(folder.glob("*.tmp"))


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
    with locked, pytest.raises(DomainError, match="open in another program"):
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
