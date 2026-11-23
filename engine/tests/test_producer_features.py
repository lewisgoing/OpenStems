"""Phase 5: tempo and key, output options, watch folder, stem to MIDI, trim and normalize."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from openstems.api.watcher import FolderWatcher
from openstems.audio import analysis
from openstems.audio.decode import decode, probe
from openstems.audio.midi import midi_bytes, read_midi_notes
from openstems.audio.write import read_audio, write_audio
from openstems.domain import OutputStem, PassSpec, Recipe
from openstems.pipeline.mix import render_mix
from openstems.pipeline.run import Pipeline, RunOptions
from tests.conftest import RATE, tone

SIX = ("bass", "drums", "other", "vocals", "guitar", "piano")


def full_song() -> Recipe:
    return Recipe(
        id="full-song",
        name="Full song",
        version=1,
        passes=(PassSpec("sw", ("six",)),),
        outputs=tuple(OutputStem(s, f"sw.{s}") for s in SIX),
        residual_into="other",
    )


def click_track(bpm: float, seconds: float = 12.0) -> np.ndarray:
    """Short noise bursts on every beat."""
    n = int(seconds * RATE)
    audio = np.zeros(n, dtype=np.float32)
    burst = (np.random.default_rng(3).standard_normal(600) * np.hanning(600)).astype(np.float32)
    for beat in np.arange(0, seconds, 60.0 / bpm):
        start = int(beat * RATE)
        audio[start : start + 600] += burst[: max(0, min(600, n - start))]
    return np.stack([audio, audio]) * 0.5


def chord_progression(roots: list[int], minor: bool, seconds_each: float = 2.0) -> np.ndarray:
    """Triads built from sine tones, enough for a chroma-based key estimate."""
    third = 3 if minor else 4
    parts = []
    for root in roots:
        t = np.arange(int(seconds_each * RATE)) / RATE
        chord = sum(
            np.sin(2 * np.pi * 440.0 * 2 ** ((note - 69) / 12) * t)
            for note in (root, root + third, root + 7)
        )
        parts.append(chord * np.hanning(len(t)))
    mono = (np.concatenate(parts) * 0.2).astype(np.float32)
    return np.stack([mono, mono])


def melody(notes: list[int], seconds_each: float = 0.5) -> np.ndarray:
    parts = []
    for note in notes:
        t = np.arange(int(seconds_each * RATE)) / RATE
        freq = 440.0 * 2 ** ((note - 69) / 12)
        envelope = np.minimum(1.0, np.minimum(t, seconds_each - t) / 0.02)
        parts.append(np.sin(2 * np.pi * freq * t) * envelope)
        parts.append(np.zeros(int(0.08 * RATE)))
    mono = (np.concatenate(parts) * 0.5).astype(np.float32)
    return np.stack([mono, mono])


# -- tempo and key ----------------------------------------------------------------


@pytest.mark.parametrize("bpm", [90.0, 120.0, 140.0])
def test_tempo_of_a_click_track(bpm: float) -> None:
    detected, _ = analysis.detect_tempo_key(click_track(bpm), RATE)
    assert detected is not None and abs(detected - bpm) < 3.0


def test_key_of_a_chord_progression() -> None:
    # C, F, G, C in C major; A minor, D minor, E minor, A minor in A minor.
    _, major = analysis.detect_tempo_key(chord_progression([60, 65, 67, 60], minor=False), RATE)
    _, minor = analysis.detect_tempo_key(chord_progression([57, 62, 64, 57], minor=True), RATE)
    assert major == "C"
    assert minor == "Am"


def test_silence_has_no_tempo_or_key() -> None:
    assert analysis.detect_tempo_key(np.zeros((2, RATE * 3), dtype=np.float32), RATE) == (
        None,
        None,
    )


def test_bpm_and_key_tokens_reach_file_names_and_the_manifest(pipeline, tmp_path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    options = RunOptions(naming_template="{track} {bpm}bpm - {stem}")
    result = pipeline.run(source, full_song(), tmp_path / "out", options)
    names = sorted(s.file for s in result.stems)
    assert names[0].startswith("Click 12") and "bpm - bass.wav" in names[0]
    assert abs(result.manifest["analysis"]["bpm"] - 120.0) < 3.0


def test_analysis_is_skipped_when_off_and_unused(pipeline, song, tmp_path, monkeypatch) -> None:
    def boom(*args: object) -> None:
        raise AssertionError("analysis should not run")

    monkeypatch.setattr(analysis, "detect_tempo_key", boom)
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    assert result.manifest["analysis"] == {"bpm": None, "key": None}


# -- output options ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("fmt", "ext", "subtype"),
    [("wav24", ".wav", "PCM_24"), ("flac", ".flac", "PCM_24"), ("mp3", ".mp3", "MPEG_LAYER_III")],
)
def test_output_formats(pipeline, song, tmp_path, fmt: str, ext: str, subtype: str) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(output_format=fmt))
    for stem in result.stems:
        path = Path(result.directory) / stem.file
        assert path.suffix == ext
        assert sf.info(str(path)).subtype == subtype
        assert probe(path).sample_rate == RATE
    if fmt != "mp3":  # MP3 adds encoder padding; the lossless formats keep the length
        audio, _ = read_audio(Path(result.directory) / result.stems[0].file)
        assert audio.shape == decode(song).shape


def test_match_the_source_sample_rate(pipeline, tmp_path) -> None:
    source = tmp_path / "At 48k.wav"
    samples = 48000 * 2
    t = np.arange(samples) / 48000
    stereo = np.stack([np.sin(2 * np.pi * 220 * t), np.sin(2 * np.pi * 330 * t)]).astype(np.float32)
    sf.write(str(source), stereo.T * 0.4, 48000, subtype="FLOAT")

    plain = pipeline.run(source, full_song(), tmp_path / "plain")
    assert {s.sample_rate for s in plain.stems} == {44100}

    matched = pipeline.run(
        source, full_song(), tmp_path / "matched", RunOptions(match_source_rate=True)
    )
    for stem in matched.stems:
        info = sf.info(str(Path(matched.directory) / stem.file))
        assert info.samplerate == 48000 and stem.sample_rate == 48000
        assert abs(info.frames - samples) <= 2  # the source's own length


def test_default_output_contract_is_unchanged(pipeline, song, tmp_path) -> None:
    """With every option at its default: float WAV at 44.1 kHz, source length, no gain."""
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions())
    mix = decode(song)
    out = Path(result.directory)
    assert out == tmp_path / "out" / "Test Song" / "full-song"
    for stem in result.stems:
        info = sf.info(str(out / stem.file))
        assert (info.subtype, info.samplerate, info.channels) == ("FLOAT", RATE, 2)
        assert stem.file == f"Test Song - {stem.name}.wav"
        assert info.frames == mix.shape[1] and stem.offset == 0 and stem.midi is None
    from openstems.engines.fake import fake_gains

    vocals, _ = read_audio(out / "Test Song - vocals.wav")
    np.testing.assert_allclose(vocals, mix * np.float32(fake_gains(6)[3]), rtol=1e-6)  # no gain


# -- trim and normalize -----------------------------------------------------------


def test_normalize_raises_each_stem_to_minus_one_db(pipeline, song, tmp_path) -> None:
    result = pipeline.run(song, full_song(), tmp_path / "out", RunOptions(normalize=True))
    for stem in result.stems:
        audio, _ = read_audio(Path(result.directory) / stem.file)
        assert abs(20 * np.log10(np.abs(audio).max()) - (-1.0)) < 0.01


def test_trim_silence_cuts_both_ends_and_records_the_offset(pipeline, tmp_path) -> None:
    source = tmp_path / "Padded.wav"
    body = tone(1.0)
    lead, tail = np.zeros((2, 4410), np.float32), np.zeros((2, 8820), np.float32)
    write_audio(source, np.concatenate([lead, body, tail], axis=1), RATE)
    result = pipeline.run(source, full_song(), tmp_path / "out", RunOptions(trim_silence=True))
    for stem in result.stems:
        audio, _ = read_audio(Path(result.directory) / stem.file)
        assert stem.offset == 4410
        assert audio.shape[1] == body.shape[1] == stem.samples
    manifest = json.loads((Path(result.directory) / "manifest.json").read_text("utf-8"))
    assert manifest["stems"][0]["offset"] == 4410
    assert analysis.silence_bounds(np.zeros((2, 100), np.float32)) == (0, 0)


# -- stem to MIDI -----------------------------------------------------------------


def test_midi_round_trip() -> None:
    notes = [(0.0, 0.5, 60, 100), (0.5, 1.0, 64, 90), (1.25, 2.0, 67, 80)]
    data = midi_bytes(notes, bpm=120.0, name="Song bass")
    assert data[:4] == b"MThd" and b"MTrk" in data
    back, bpm = read_midi_notes(data)
    assert bpm == pytest.approx(120.0)
    assert [(n, v) for _, _, n, v in back] == [(60, 100), (64, 90), (67, 80)]
    for (a, b, _, _), (c, d, _, _) in zip(back, notes, strict=True):
        assert a == pytest.approx(c, abs=0.005) and b == pytest.approx(d, abs=0.005)


def test_a_sine_melody_becomes_the_right_notes() -> None:
    wanted = [60, 64, 67, 72, 67]
    notes = analysis.track_notes(melody(wanted), RATE)
    assert [n for _, _, n, _ in notes] == wanted
    assert all(0.3 < end - start < 0.6 for start, end, _, _ in notes)


def test_bass_range_notes() -> None:
    wanted = [40, 43, 45]  # E2, G2, A2
    notes = analysis.track_notes(melody(wanted, 0.6), RATE, fmin=30.0, fmax=400.0)
    assert [n for _, _, n, _ in notes] == wanted


def test_pipeline_writes_a_midi_file_next_to_the_stem(catalog, store, tmp_path) -> None:
    source = tmp_path / "Tune.wav"
    write_audio(source, melody([57, 60, 64, 69]), RATE)
    pipeline = Pipeline(catalog, store)
    recipe = Recipe(
        id="vox",
        name="Vocals",
        version=1,
        passes=(PassSpec("v", ("vox",)),),
        outputs=(OutputStem("vocals", "v.vocals"),),
    )
    result = pipeline.run(
        source, recipe, tmp_path / "out", RunOptions(midi_stems=["vocals", "bass"])
    )
    stem = result.stems[0]
    assert stem.midi == "Tune - vocals.mid"
    notes, _ = read_midi_notes((Path(result.directory) / stem.midi).read_bytes())
    assert [n for _, _, n, _ in notes] == [57, 60, 64, 69]
    # Running again replaces the result cleanly, MIDI file included.
    pipeline.run(source, recipe, tmp_path / "out", RunOptions(force=True))
    assert not (Path(result.directory) / "Tune - vocals.mid").exists()


# -- watch folder -----------------------------------------------------------------


def test_watcher_queues_new_files_once_they_stop_changing(tmp_path: Path) -> None:
    folder = tmp_path / "watch"
    outputs = folder / "stems"
    outputs.mkdir(parents=True)
    old = folder / "already here.wav"
    write_audio(old, tone(0.1), RATE)
    queued: list[Path] = []
    watcher = FolderWatcher(queued.append)
    watcher.configure(str(folder), True, exclude=outputs)

    assert watcher.scan() == []  # files present when watching began are ignored

    new = folder / "sub" / "new song.mp3"
    new.parent.mkdir()
    new.write_bytes(b"x" * 100)
    (folder / "notes.txt").write_text("not audio", "utf-8")
    write_audio(outputs / "new song - vocals.wav", tone(0.1), RATE)  # our own output
    assert watcher.scan() == []  # first sighting: wait for the size to settle

    new.write_bytes(b"x" * 500)  # still being copied
    assert watcher.scan() == []
    assert watcher.scan() == [new]
    assert watcher.scan() == []  # queued once
    assert queued == [new]

    watcher.configure(str(folder), False)
    late = folder / "late.wav"
    write_audio(late, tone(0.1), RATE)
    assert watcher.scan() == [] and watcher.scan() == []


def test_watch_folder_through_the_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    from fastapi.testclient import TestClient

    from openstems.api.app import create_app
    from openstems.api.service import Service

    monkeypatch.setenv("OPENSTEMS_ENGINE", "fake")
    watch = tmp_path / "inbox"
    watch.mkdir()
    service = Service()
    service.watcher.interval = 0.1
    with TestClient(create_app("t", service), headers={"Authorization": "Bearer t"}) as client:
        assert service.jobs.supervisor.ready.wait(30)
        missing = client.patch("/v1/settings", json={"watch_folder": "", "watch_enabled": True})
        assert missing.status_code == 400
        ok = client.patch("/v1/settings", json={"watch_folder": str(watch), "watch_enabled": True})
        assert ok.status_code == 200 and ok.json()["watch_enabled"] is True

        write_audio(watch / "Dropped In.wav", tone(0.3), RATE)
        deadline = time.monotonic() + 30
        jobs: list[dict] = []
        while time.monotonic() < deadline:
            jobs = client.get("/v1/jobs").json()["jobs"]
            if jobs and jobs[0]["state"] == "done":
                break
            time.sleep(0.05)
        assert [j["track_name"] for j in jobs] == ["Dropped In"]
        assert jobs[0]["state"] == "done" and jobs[0]["recipe_id"] == "full-song"


# -- tempo sync for FL Studio -----------------------------------------------------


def acid_tempo(path: Path) -> float | None:
    """The tempo in a WAV's ``acid`` chunk, walking the chunks the way a reader does."""
    data = path.read_bytes()
    assert int.from_bytes(data[4:8], "little") == len(data) - 8  # the RIFF size is right
    at = 12
    while at + 8 <= len(data):
        size = int.from_bytes(data[at + 4 : at + 8], "little")
        if data[at : at + 4] == b"acid":
            assert size == 24
            assert int.from_bytes(data[at + 8 : at + 12], "little") == 0x04  # "stretch"
            return float(np.frombuffer(data[at + 28 : at + 32], dtype="<f4")[0])
        at += 8 + size + (size & 1)
    return None


@pytest.mark.parametrize("fmt", ["wav32f", "wav24"])
def test_a_tempo_marks_a_wav_and_leaves_the_audio_alone(tmp_path: Path, fmt: str) -> None:
    plain, marked = tmp_path / "plain.wav", tmp_path / "marked.wav"
    audio = tone(0.5)[:, :-1]  # an odd number of frames, so 24-bit data needs its pad byte
    write_audio(plain, audio, RATE, fmt)
    write_audio(marked, audio, RATE, fmt, bpm=128.5)
    assert acid_tempo(plain) is None
    assert acid_tempo(marked) == 128.5
    assert np.array_equal(read_audio(marked)[0], read_audio(plain)[0])
    assert sf.info(str(marked)).frames == audio.shape[1]


def test_flac_and_mp3_take_no_tempo_mark(tmp_path: Path) -> None:
    for fmt, ext in (("flac", ".flac"), ("mp3", ".mp3")):
        plain, marked = tmp_path / f"plain{ext}", tmp_path / f"marked{ext}"
        write_audio(plain, tone(0.5), RATE, fmt)
        write_audio(marked, tone(0.5), RATE, fmt, bpm=120.0)
        assert marked.read_bytes() == plain.read_bytes()


def test_tempo_sync_writes_the_detected_tempo_into_every_stem(pipeline, tmp_path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    result = pipeline.run(source, full_song(), tmp_path / "out", RunOptions(tempo_sync=True))
    bpm = result.manifest["analysis"]["bpm"]
    assert bpm and result.manifest["options"]["tempo_sync"] is True
    for stem in result.stems:
        assert acid_tempo(Path(result.directory) / stem.file) == bpm
    # A mix of those stems is in time with them, so it carries the same tempo.
    mix = render_mix(Path(result.directory), [s.file for s in result.stems[:2]])
    assert acid_tempo(Path(mix["path"])) == bpm


def test_stems_are_unmarked_without_tempo_sync_or_a_tempo(pipeline, song, tmp_path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    off = pipeline.run(source, full_song(), tmp_path / "off", RunOptions(detect_tempo_key=True))
    assert "tempo_sync" not in off.manifest["options"]  # earlier runs keep their cache key
    silent = tmp_path / "Silence.wav"
    write_audio(silent, np.zeros((2, RATE * 3), dtype=np.float32), RATE)
    none = pipeline.run(silent, full_song(), tmp_path / "none", RunOptions(tempo_sync=True))
    assert none.manifest["analysis"]["bpm"] is None
    for result in (off, none):
        for stem in result.stems:
            assert acid_tempo(Path(result.directory) / stem.file) is None
