"""Stem to MIDI around a run (Phase 7, stage M3): the notes file and the MIDI file a run
writes beside a stem, what a new tempo or name does to them, and reading a stem that is
already written (`pipeline/notes.py`, `POST /v1/notes`)."""

from __future__ import annotations

import json
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
from openstems.pipeline.notes import (
    find_notes,
    midi_from_sidecar,
    readable,
    song_tuning,
    stale,
)
from openstems.pipeline.rename import rename_song
from openstems.pipeline.retag import set_analysis
from openstems.pipeline.run import Pipeline, RunOptions, read_manifest
from tests.conftest import RATE
from tests.test_api import all_terminal, client, fake_env, songs, wait_for
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
    source = tmp_path / "Tune.wav"
    mono = np.concatenate([np.zeros(int(lead * RATE), dtype=np.float32), sung(WANTED)])
    write_audio(source, np.stack([mono, mono]), RATE)
    return source


def keys_of(path: Path) -> list[int]:
    return [note for _, _, note, _ in read_midi_notes(path.read_bytes())[0]]


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
    # From the cache the same: the stems are returned, whatever became of the notes.
    again = pipeline.run(tune(tmp_path), vocals_only(), tmp_path / "out", options)
    assert again.cached and again.stems[0].notes is None


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


def test_a_job_with_midi_lists_its_notes(client: TestClient, songs: list[Path]) -> None:
    job = done_job(client, songs, midi_stems=["bass", "vocals", "drums"])
    stems = {s["name"]: s for s in job["stems"]}
    assert stems["bass"]["notes"] and Path(stems["bass"]["notes"]).is_file()
    assert stems["drums"]["notes"] is None and stems["drums"]["midi"] is None
