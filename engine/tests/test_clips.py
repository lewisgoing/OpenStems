"""Clips: a stretch of a song as a file of its own, cut on the song's timeline from the
song's own file or from its stems. With them: the beat grid that names a clip, bar 1 found
by detection or set by hand, and a song's own file played and drawn before separation."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from openstems.audio import analysis
from openstems.audio.decode import decode
from openstems.audio.write import read_audio, read_comment, write_audio
from openstems.domain.errors import DomainError
from openstems.domain.grid import Grid, clean_downbeat, clip_label, file_time, js_round, make_grid
from openstems.pipeline import clip as clip_module
from openstems.pipeline import preview as preview_module
from openstems.pipeline.clip import render_clips
from openstems.pipeline.mix import render_mix
from openstems.pipeline.retag import set_analysis
from openstems.pipeline.run import RunOptions, read_manifest
from tests.conftest import RATE, tone
from tests.test_api import all_terminal, client, fake_env, service_of, songs, wait_for
from tests.test_producer_features import acid_tempo, click_track, full_song

__all__ = ["client", "fake_env", "songs"]  # fixtures, used by name

# Shared with the app's tests: its twin of `clip_label` must name every case alike.
LABELS: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "clip_labels.json").read_text("utf-8")
)


def beat_song(bpm: float, first: float, seconds: float, pickup: bool = False) -> np.ndarray:
    """A click on every beat from ``first`` on, and a low thump with every fourth: bar 1
    starts at ``first``, after silence. ``pickup`` adds two clicks just before it."""
    n = int(seconds * RATE)
    audio = np.zeros(n, dtype=np.float32)
    click = (np.random.default_rng(3).standard_normal(400) * np.hanning(400) * 0.3).astype(
        np.float32
    )
    t = np.arange(int(0.15 * RATE)) / RATE
    thump = (np.sin(2 * np.pi * 55.0 * t) * np.exp(-t * 25) * 0.8).astype(np.float32)
    beat = 60.0 / bpm
    starts = [(at, False) for at in (first - beat, first - beat / 2)] if pickup else []
    starts += [(at, i % 4 == 0) for i, at in enumerate(np.arange(first, seconds - 0.2, beat))]
    for at, low in starts:
        s = round(at * RATE)
        audio[s : s + click.size] += click[: max(0, min(click.size, n - s))]
        if low:
            audio[s : s + thump.size] += thump[: max(0, min(thump.size, n - s))]
    return np.stack([audio, audio])


def drum_song(kicks: tuple[int, ...], bpm: float, first: float, seconds: float) -> np.ndarray:
    """A drum loop from ``first`` on, after silence: a kick on the given beats of the bar
    (0 is beat 1), a snare on 2 and 4, and a hi-hat on every eighth note."""
    n = int(seconds * RATE)
    audio = np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(3)
    t = np.arange(int(0.2 * RATE)) / RATE
    kick = (np.sin(2 * np.pi * (50 + 80 * np.exp(-t * 40)) * t) * np.exp(-t * 18) * 0.8).astype(
        np.float32
    )
    snare = (rng.standard_normal(t.size) * np.exp(-t * 30) * 0.35).astype(np.float32)
    hat = (rng.standard_normal(600) * np.hanning(600) * 0.12).astype(np.float32)
    beat = 60.0 / bpm
    for i, at in enumerate(np.arange(first, seconds - 0.3, beat)):
        hits = [(at, hat), (at + beat / 2, hat)]
        if i % 4 in kicks:
            hits.append((at, kick))
        if i % 4 in (1, 3):
            hits.append((at, snare))
        for when, sound in hits:
            s = round(when * RATE)
            part = sound[: max(0, min(sound.size, n - s))]
            audio[s : s + part.size] += part
    return np.stack([audio, audio])


def stem_set(pipeline, tmp_path: Path, audio: np.ndarray | None = None, **options: Any):
    """A song separated by the FakeEngine's six stems: its folder and its manifest."""
    source = tmp_path / "Satellite Rain.wav"
    write_audio(source, tone(3.0) if audio is None else audio, RATE)
    result = pipeline.run(source, full_song(), tmp_path / "out", RunOptions(**options))
    return Path(result.directory), result.manifest


# -- names ------------------------------------------------------------------------------


@pytest.mark.parametrize("case", LABELS, ids=[case["note"] for case in LABELS])
def test_a_selection_is_named_as_the_app_names_it(case: dict[str, Any]) -> None:
    grid = None
    if case["bpm"] is not None:
        grid = Grid(case["bpm"], case["downbeat"], case.get("beats_per_bar", 4))
    assert clip_label(grid, case["start"], case["end"]) == case["label"]


def test_the_shared_names_cover_bars_beats_and_times() -> None:
    labels = [case["label"] for case in LABELS]
    assert len(labels) >= 20
    assert any(label.startswith("bars ") for label in labels)
    assert {"bar 0", "bar -1", "bars -3--2"} <= set(labels)
    assert any(label.count(".") == 3 for label in labels)  # a sixteenth: "9.2.4-11.2"
    assert any(case["bpm"] is None for case in LABELS)
    assert any(case["bpm"] is not None and case["downbeat"] < 0 for case in LABELS)
    assert any("beats_per_bar" in case for case in LABELS)


def test_a_half_rounds_up_as_in_javascript() -> None:
    assert (js_round(12.5), round(12.5)) == (13, 12)
    assert [js_round(x) for x in (-0.5, -1.5, -2.5, 2.4999, 0.49999999999999994)] == [
        0,
        -1,
        -2,
        2,
        0,
    ]
    assert file_time(0.125) == "0m00.13s"
    assert file_time(-3.0) == "0m00.00s"


def test_bar_one_is_a_time_in_seconds() -> None:
    assert clean_downbeat(None) is None
    assert clean_downbeat("") is None and clean_downbeat("  ") is None
    assert clean_downbeat(1.23456) == 1.2346
    assert clean_downbeat("-0.25") == -0.25
    assert clean_downbeat(-60) == -60.0 and clean_downbeat(86400) == 86400.0
    # A half rounds up, as the app's twin rounds: Math.round(x * 10000) / 10000.
    assert clean_downbeat(2.00005) == 2.0001 and round(2.00005, 4) == 2.0
    for bad in ("soon", float("nan"), float("inf"), -60.001, 86400.5, [1]):
        with pytest.raises(DomainError, match="bar 1 must be a time in seconds"):
            clean_downbeat(bad)


def test_a_grid_from_a_request_is_checked_and_kept_as_it_is() -> None:
    assert make_grid(128.123456, -0.123456789) == Grid(128.123456, -0.123456789, 4)
    assert make_grid(90, 0, 3) == Grid(90.0, 0.0, 3)
    for bpm, downbeat, per_bar in (
        (10, 0, 4),
        (1000, 0, 4),
        (120, float("nan"), 4),
        (120, -61, 4),
        (120, 0, 0),
        (120, 0, 17),
        (120, 0, 2.5),
    ):
        with pytest.raises(DomainError):
            make_grid(bpm, downbeat, per_bar)


# -- clips of stems ---------------------------------------------------------------------


def test_a_clip_of_one_stem_is_that_stretch_of_the_stem(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    stem = manifest["stems"][3]
    (clip,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, Grid(120.0, 0.5))
    path = Path(clip["path"])
    assert path == folder / "Clips" / f"Satellite Rain - {stem['name']} - bar 1.wav"
    assert (clip["name"], clip["label"], clip["stems"]) == (path.name, stem["name"], [stem["name"]])
    assert (clip["start"], clip["end"]) == (0.5, 2.5)
    audio, rate = read_audio(path)
    whole, _ = read_audio(folder / stem["file"])
    first = round(0.5 * RATE)
    assert rate == clip["sample_rate"] == RATE
    assert audio.shape[1] == clip["samples"] == round(2.0 * RATE)
    assert np.array_equal(audio, whole[:, first : first + audio.shape[1]])
    assert sf.info(str(path)).subtype == "FLOAT"


def test_clips_of_each_stem_add_up_to_the_clip_of_them_together(pipeline, tmp_path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    names = [s["name"] for s in manifest["stems"]]
    files = [s["file"] for s in manifest["stems"][:3]]
    start, end = 0.731, 2.204
    apart = render_clips(folder, files, start, end, False, None)
    (together,) = render_clips(folder, files, start, end, True, None)
    assert [c["stems"] for c in apart] == [[name] for name in names[:3]]
    assert {c["samples"] for c in apart} == {together["samples"]} == {round((end - start) * RATE)}
    assert together["label"] == " + ".join(names[:3]) and together["stems"] == names[:3]
    assert together["name"] == f"Satellite Rain - {together['label']} - 0m00.73s-0m02.20s.wav"
    joined, _ = read_audio(Path(together["path"]))
    total = sum(read_audio(Path(c["path"]))[0] for c in apart)
    assert np.allclose(total, joined, atol=1e-6)
    # And the same stretch of the mix of the same stems.
    mix, _ = read_audio(Path(render_mix(folder, files)["path"]))
    first = round(start * RATE)
    assert np.allclose(joined, mix[:, first : first + joined.shape[1]], atol=1e-6)


def test_a_whole_group_goes_by_the_group_name(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    data = json.loads((folder / "manifest.json").read_text("utf-8"))
    for stem in data["stems"]:
        if stem["name"] in ("guitar", "piano", "other"):
            stem["group"] = "melody"
    (folder / "manifest.json").write_text(json.dumps(data), "utf-8")
    files = [s["file"] for s in manifest["stems"] if s["name"] in ("guitar", "piano", "other")]
    (clip,) = render_clips(folder, files, 0.5, 2.5, True, Grid(120.0, 0.5))
    assert clip["label"] == "melody"
    assert clip["name"] == "Satellite Rain - melody - bar 1.wav"


def test_trimmed_stems_keep_their_place_in_a_clip(pipeline, tmp_path: Path) -> None:
    # A fade in after silence: the quieter a stem, the later its first audible sample.
    n = int(2.4 * RATE)
    fade = np.clip((np.arange(n) / RATE - 0.4) / 1.0, 0.0, 1.0).astype(np.float32)
    folder, manifest = stem_set(pipeline, tmp_path, tone(2.4) * fade, trim_silence=True)
    stems = manifest["stems"]
    offsets = [stem["offset"] for stem in stems]
    assert len(set(offsets)) > 1 and min(offsets) > 0
    start, end = 0.3, 2.0
    clips = render_clips(folder, [s["file"] for s in stems], start, end, False, None)
    (together,) = render_clips(folder, [s["file"] for s in stems], start, end, True, None)
    assert {c["samples"] for c in [*clips, together]} == {round((end - start) * RATE)}
    late = max(stems, key=lambda stem: stem["offset"])
    clip = next(c for c in clips if c["stems"] == [late["name"]])
    audio, _ = read_audio(Path(clip["path"]))
    stem_audio, _ = read_audio(folder / late["file"])
    lead = late["offset"] - round(start * RATE)
    assert lead > 0 and not audio[:, :lead].any()
    assert audio[:, lead].any()
    assert np.array_equal(audio[:, lead:], stem_audio[:, : audio.shape[1] - lead])


def test_a_clip_can_start_with_the_song_and_end_with_it(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)  # 3 s
    stem = manifest["stems"][0]
    whole, _ = read_audio(folder / stem["file"])
    (first,) = render_clips(folder, [stem["file"]], -1.0, 0.25, True, None)
    assert first["start"] == 0.0 and first["samples"] == round(0.25 * RATE)
    assert first["name"] == f"Satellite Rain - {stem['name']} - 0m00.00s-0m00.25s.wav"
    audio, _ = read_audio(Path(first["path"]))
    assert np.array_equal(audio, whole[:, : audio.shape[1]])
    (last,) = render_clips(folder, [stem["file"]], 2.75, 9.0, True, None)
    assert last["end"] == 3.0 and last["samples"] == round(0.25 * RATE)
    audio, _ = read_audio(Path(last["path"]))
    assert np.array_equal(audio, whole[:, -audio.shape[1] :])


def test_the_same_clip_is_found_again_and_newer_stems_write_it_anew(pipeline, tmp_path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    stem = manifest["stems"][1]
    grid = Grid(120.0, 0.5)
    (clip,) = render_clips(folder, [stem["file"]], 0.5, 1.5, True, grid)
    path = Path(clip["path"])
    stamp = path.stat().st_mtime_ns
    assert read_comment(path).startswith("OpenStems clip ")
    (again,) = render_clips(folder, [stem["file"]], 0.5, 1.5, True, grid)
    assert again == clip and path.stat().st_mtime_ns == stamp
    assert [p.name for p in path.parent.iterdir()] == [path.name]  # nothing temporary left
    # The song was separated again: its stems are newer than the clip.
    later = time.time() + 5
    os.utime(folder / stem["file"], (later, later))
    (anew,) = render_clips(folder, [stem["file"]], 0.5, 1.5, True, grid)
    assert anew["path"] == clip["path"] and path.stat().st_mtime_ns != stamp


def test_the_same_bars_on_a_corrected_grid_are_another_clip(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    stem = manifest["stems"][1]
    whole, _ = read_audio(folder / stem["file"])
    (one,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, Grid(120.0, 0.5))
    kept = Path(one["path"])
    before = kept.read_bytes()
    # The same bars on a corrected grid are another stretch of the song. The first clip may
    # be in a DAW's project, so it keeps its audio, and the new one takes another name.
    (moved,) = render_clips(folder, [stem["file"]], 0.6, 2.6, True, Grid(120.0, 0.6))
    assert one["name"] == f"Satellite Rain - {stem['name']} - bar 1.wav"
    assert moved["name"] == f"Satellite Rain - {stem['name']} - bar 1 (2).wav"
    assert kept.read_bytes() == before
    audio, _ = read_audio(Path(moved["path"]))
    first = round(0.6 * RATE)
    assert np.array_equal(audio, whole[:, first : first + audio.shape[1]])
    # Each is found again where it is.
    again = render_clips(folder, [stem["file"]], 0.5, 2.5, True, Grid(120.0, 0.5))
    assert again[0]["path"] == one["path"] and kept.read_bytes() == before
    again = render_clips(folder, [stem["file"]], 0.6, 2.6, True, Grid(120.0, 0.6))
    assert again[0]["path"] == moved["path"]


def test_a_clip_the_user_edited_is_left_alone(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    stem = manifest["stems"][1]
    grid = Grid(120.0, 0.5)
    (clip,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, grid)
    path = Path(clip["path"])
    # Faded out in an audio editor and saved over: newer than the stems, without our tags.
    data, rate = sf.read(str(path), dtype="float32")
    data *= np.linspace(1.0, 0.0, data.shape[0], dtype=np.float32)[:, None]
    sf.write(str(path), data, rate, subtype="FLOAT")
    edited = path.read_bytes()
    (again,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, grid)
    assert again["name"] == f"Satellite Rain - {stem['name']} - bar 1 (2).wav"
    assert path.read_bytes() == edited


def test_a_clip_that_is_open_elsewhere_is_left_alone(pipeline, tmp_path, monkeypatch) -> None:
    folder, manifest = stem_set(pipeline, tmp_path)
    stem = manifest["stems"][1]
    grid = Grid(120.0, 0.5)
    (clip,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, grid)
    held = Path(clip["path"])
    # The song was separated again since: the clip is older than its stems, so it is
    # written anew, but a DAW holds it open.
    old = (folder / stem["file"]).stat().st_mtime - 5
    os.utime(held, (old, old))
    before = held.read_bytes()
    real = os.replace

    def busy(src: Any, dst: Any) -> None:
        if Path(dst) == held:  # a DAW holds it, on Windows
            raise PermissionError(13, "The process cannot access the file", str(dst))
        real(src, dst)

    monkeypatch.setattr(clip_module.os, "replace", busy)
    second = held.with_name(f"Satellite Rain - {stem['name']} - bar 1 (2).wav")
    (anew,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, grid)
    assert Path(anew["path"]) == second and held.read_bytes() == before
    audio, _ = read_audio(second)
    whole, _ = read_audio(folder / stem["file"])
    first = round(0.5 * RATE)
    assert np.array_equal(audio, whole[:, first : first + audio.shape[1]])
    # Asked for again while the old one is still held: the new one is found again.
    stamp = second.stat().st_mtime_ns
    (again,) = render_clips(folder, [stem["file"]], 0.5, 2.5, True, grid)
    assert Path(again["path"]) == second and second.stat().st_mtime_ns == stamp
    assert held.read_bytes() == before
    assert sorted(p.name for p in held.parent.iterdir()) == sorted([held.name, second.name])


def test_a_tempo_synced_song_marks_its_clips(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path, tempo_sync=True, output_format="wav24")
    files = [s["file"] for s in manifest["stems"][:2]]
    (clip,) = render_clips(folder, files, 0.5, 2.5, True, Grid(97.5, 0.5))
    assert acid_tempo(Path(clip["path"])) == 97.5
    assert sf.info(clip["path"]).subtype == "PCM_24"  # the stems' own WAV format
    # Without a grid, the song's tempo.
    set_analysis(folder, {"bpm": 133})
    (plain,) = render_clips(folder, files, 0.5, 2.5, True, None)
    assert acid_tempo(Path(plain["path"])) == 133.0


def test_clips_of_mp3_or_flac_stems_are_float_wavs(pipeline, tmp_path: Path) -> None:
    folder, manifest = stem_set(pipeline, tmp_path, output_format="flac")
    (clip,) = render_clips(folder, [manifest["stems"][0]["file"]], 0.5, 2.5, True, None)
    assert clip["name"].endswith(".wav") and sf.info(clip["path"]).subtype == "FLOAT"
    audio, _ = read_audio(Path(clip["path"]))
    whole, _ = read_audio(folder / manifest["stems"][0]["file"])
    first = round(0.5 * RATE)
    assert np.array_equal(audio, whole[:, first : first + audio.shape[1]])


def test_the_selection_stays_whole_in_a_clips_name() -> None:
    tokens = {"track": "Satellite Rain", "recipe": "full-song", "bpm": "120.0", "key": "Am"}
    name = clip_module._clip_name
    # Tidying a filled template takes "--" for empty tokens; the selection keeps its own.
    assert name("{track} - {stem}", "bass", "bars -3--2", tokens) == (
        "Satellite Rain - bass - bars -3--2"
    )
    assert name("{track} {bpm} {key} - {stem}", "drums", "-1.3-0.2", tokens) == (
        "Satellite Rain 120.0 Am - drums - -1.3-0.2"
    )
    assert name("{stem} - {track}", "", "bar 9", tokens) == "bar 9 - Satellite Rain"
    # A name too long for a file is cut in the track's name, never in the selection.
    long = name(
        "{track} - {stem}", "no vocals, other", "bars 120-128", {**tokens, "track": "A" * 130}
    )
    assert len(long) <= 120 and long.endswith(" - no vocals, other - bars 120-128")
    assert long.startswith("AAAA")


# -- through the API --------------------------------------------------------------------


def separated(client: TestClient, paths: list[Path], **options: Any) -> list[dict[str, Any]]:
    for path in paths:
        body = {"path": str(path), "recipe": "full-song", "options": options}
        assert client.post("/v1/jobs", json=body).status_code == 200
    jobs = wait_for(client, lambda jobs: len(jobs) == len(paths) and all_terminal(jobs))
    assert all(job["state"] == "done" for job in jobs)
    return jobs


def test_clips_of_stems_through_the_api(client: TestClient, songs: list[Path]) -> None:
    (job,) = separated(client, songs[:1])
    stems = job["stems"]
    body = {
        "paths": [s["path"] for s in stems[:2]],
        "start": 0.1,
        "end": 0.3,
        "grid": {"bpm": 600, "downbeat": 0.1, "beats_per_bar": 2},
    }
    answer = client.post("/v1/clips", json=body)
    assert answer.status_code == 200, answer.text
    (clip,) = answer.json()["clips"]
    assert Path(clip["path"]).parent == Path(job["output_dir"]) / "Clips"
    assert clip["name"] == f"Song 0 - {stems[0]['name']} + {stems[1]['name']} - bar 1.wav"
    assert client.get("/v1/files", params={"path": clip["path"]}).status_code == 200
    each = client.post("/v1/clips", json={**body, "together": False}).json()["clips"]
    assert [c["stems"] for c in each] == [[stems[0]["name"]], [stems[1]["name"]]]


def test_a_clip_of_a_songs_own_file(client: TestClient, tmp_path: Path) -> None:
    song = tmp_path / "in" / "Satellite Rain.wav"
    song.parent.mkdir()
    t = np.arange(48000) / 48000
    data = np.stack([0.4 * np.sin(2 * np.pi * 220 * t), 0.3 * np.sin(2 * np.pi * 330 * t)])
    sf.write(str(song), data.T.astype(np.float32), 48000, subtype="FLOAT")
    body = {"path": str(song), "recipe": "full-song", "start": False}
    assert client.post("/v1/jobs", json=body).status_code == 200  # waits in the queue

    grid = {"bpm": 600, "downbeat": 0.1, "beats_per_bar": 2}
    request = {"paths": [str(song)], "start": 0.1, "end": 0.3, "grid": grid}
    answer = client.post("/v1/clips", json=request)
    assert answer.status_code == 200, answer.text
    (clip,) = answer.json()["clips"]
    output = service_of(client).runtime.settings.output_path
    assert Path(clip["path"]) == output / "Satellite Rain" / "Clips" / "Satellite Rain - bar 1.wav"
    assert (clip["label"], clip["stems"]) == ("", [])
    # At the file's own sample rate, cut from the file as it decodes.
    assert clip["sample_rate"] == 48000 and clip["samples"] == round(0.2 * 48000)
    audio, rate = read_audio(Path(clip["path"]))
    decoded = decode(song, 48000)
    first = round(0.1 * 48000)
    assert rate == 48000 and np.array_equal(audio, decoded[:, first : first + audio.shape[1]])
    assert client.get("/v1/files", params={"path": clip["path"]}).status_code == 200
    # Named as asked, also without the hint, and tempo-synced from the settings.
    settings = {"tempo_sync": True, "output_format": "wav24"}
    assert client.patch("/v1/settings", json=settings).status_code == 200
    marked = client.post("/v1/clips", json={**request, "source": True, "start": 0.3, "end": 0.5})
    assert marked.status_code == 200, marked.text
    (clip,) = marked.json()["clips"]
    assert clip["name"] == "Satellite Rain - bar 2.wav"
    assert acid_tempo(Path(clip["path"])) == 600.0
    assert sf.info(clip["path"]).subtype == "PCM_24"


def test_a_clip_of_a_songs_own_file_is_named_as_the_queue_has_it(
    client: TestClient, tmp_path: Path
) -> None:
    song = tmp_path / "in" / "Satellite Rain.wav"
    song.parent.mkdir()
    write_audio(song, tone(1.0), RATE)
    body = {"path": str(song), "recipe": "full-song", "start": False}
    assert client.post("/v1/jobs", json=body).status_code == 200
    other = str(song.parent / "SATELLITE RAIN.WAV")
    answer = client.post("/v1/clips", json={"paths": [other], "start": 0.1, "end": 0.3})
    if os.path.normcase("A") == "a":  # Windows: the same file, whatever the case
        assert answer.status_code == 200, answer.text
        (clip,) = answer.json()["clips"]
        output = service_of(client).runtime.settings.output_path
        name = "Satellite Rain - 0m00.10s-0m00.30s.wav"
        # As strings: Windows paths compare without case.
        assert clip["path"] == str(output / "Satellite Rain" / "Clips" / name)
    else:  # elsewhere another spelling is another file
        assert answer.status_code == 400
        assert answer.json()["detail"] == "that is not a song in the queue or the history"


def test_bad_clip_requests_answer_with_a_sentence(
    client: TestClient, songs: list[Path], tmp_path: Path
) -> None:
    one, two = separated(client, songs[:2])

    def refused(**body: Any) -> str:
        body = {"start": 0.1, "end": 0.3, **body}
        answer = client.post("/v1/clips", json=body)
        assert answer.status_code == 400, answer.text
        return answer.json()["detail"]

    stem = one["stems"][0]["path"]
    assert refused(paths=[]) == "a clip needs the song or at least one of its stems"
    assert refused(paths=[stem, two["stems"][0]["path"]]) == "a clip is made of stems of one song"
    assert refused(paths=[stem], start=0.3, end=0.1) == "the selection must end after it starts"
    assert refused(paths=[stem], start=0.1, end=0.11) == "the selection is too short"
    assert refused(paths=[stem], start=5.0, end=6.0) == "the selection is too short"
    stray = Path(one["output_dir"]) / "stray.wav"
    stray.write_bytes(Path(stem).read_bytes())
    assert refused(paths=[str(stray)]) == "not a stem of this song: stray.wav"
    unknown = "that is not a song in the queue or the history"
    assert refused(paths=[str(tmp_path / "elsewhere.wav")]) == unknown
    assert refused(paths=[stem], source=True) == unknown
    tempo = refused(paths=[stem], grid={"bpm": 5, "downbeat": 0})
    assert tempo == "the tempo must be between 20 and 999 BPM"
    assert refused(paths=[str(songs[0]), stem], source=True).startswith("a clip of a song's own")


# -- a song's own file before separation ------------------------------------------------


def test_a_songs_own_file_can_be_played_before_it_is_separated(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    song = tmp_path / "in" / "Beat.wav"
    song.parent.mkdir()
    write_audio(song, beat_song(120.0, 1.3, 10.0), RATE)
    body = {"path": str(song), "recipe": "full-song", "start": False}
    assert client.post("/v1/jobs", json=body).status_code == 200

    answer = client.post("/v1/sources/preview", json={"path": str(song)})
    assert answer.status_code == 200, answer.text
    preview = answer.json()
    folder = service_of(client).runtime.settings.cache_path / "previews"
    audio = Path(preview["audio"])
    assert audio.parent == folder and audio.suffix == ".flac"
    assert preview["sample_rate"] == 44100 and preview["duration"] == pytest.approx(10.0)
    info = sf.info(str(audio))
    assert (info.subtype, info.samplerate, info.frames) == ("PCM_16", 44100, round(10.0 * RATE))
    found = preview["analysis"]
    assert abs(found["bpm"] - 120.0) < 0.5 and abs(found["downbeat"] - 1.3) < 0.03
    assert "key" in found
    served = client.get("/v1/files", params={"path": str(audio)})
    assert served.status_code == 200 and served.content == audio.read_bytes()
    peaks = client.get("/v1/peaks", params={"path": preview["peaks"]})
    assert peaks.status_code == 200 and peaks.json()["samples"] == round(10.0 * RATE)
    # Asked for again: the same files, not decoded again.
    stamp = audio.stat().st_mtime_ns

    def boom(*args: object, **kwargs: object) -> None:
        raise AssertionError("the song should not be decoded again")

    monkeypatch.setattr(preview_module, "decode", boom)
    assert client.post("/v1/sources/preview", json={"path": str(song)}).json() == preview
    assert audio.stat().st_mtime_ns >= stamp and len(list(folder.iterdir())) == 3
    # Other files in the cache are not served, and other files are not previewed.
    stray = service_of(client).runtime.settings.cache_path / "stray.txt"
    stray.write_text("not a preview", "utf-8")
    assert client.get("/v1/files", params={"path": str(stray)}).status_code == 404
    refused = client.post("/v1/sources/preview", json={"path": str(tmp_path / "other.wav")})
    assert refused.status_code == 400
    assert refused.json()["detail"] == "that is not a song in the queue or the history"


def test_a_song_in_the_history_can_be_previewed(client: TestClient, songs: list[Path]) -> None:
    (job,) = separated(client, songs[:1])
    assert client.delete(f"/v1/jobs/{job['id']}").status_code == 200  # out of the queue
    answer = client.post("/v1/sources/preview", json={"path": str(songs[0])})
    assert answer.status_code == 200, answer.text
    assert answer.json()["analysis"] == {"bpm": None, "key": None, "downbeat": None}  # 0.4 s
    # And clipped: the song's own file, found through the history.
    clip = client.post("/v1/clips", json={"paths": [str(songs[0])], "start": 0.1, "end": 0.3})
    assert clip.status_code == 200, clip.text
    assert clip.json()["clips"][0]["name"] == "Song 0 - 0m00.10s-0m00.30s.wav"


def test_only_the_newest_previews_are_kept(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "many"
    folder.mkdir()
    previews = []
    for i in range(10):
        path = folder / f"Song {i}.wav"
        write_audio(path, tone(0.3, 200 + 10 * i), RATE)
        body = {"path": str(path), "recipe": "full-song", "start": False}
        assert client.post("/v1/jobs", json=body).status_code == 200
        answer = client.post("/v1/sources/preview", json={"path": str(path)})
        assert answer.status_code == 200, answer.text
        previews.append(answer.json())
    kept = service_of(client).runtime.settings.cache_path / "previews"
    assert len(list(kept.glob("*.flac"))) == 8 and len(list(kept.iterdir())) == 8 * 3
    assert not any(Path(p["audio"]).exists() or Path(p["peaks"]).exists() for p in previews[:2])
    assert all(Path(p["audio"]).exists() for p in previews[2:])


# -- bar 1 ------------------------------------------------------------------------------


@pytest.mark.parametrize(("bpm", "first"), [(120.0, 1.3), (100.0, 0.75), (140.0, 2.1)])
def test_bar_one_is_found_at_the_first_thump(bpm: float, first: float) -> None:
    found, _, downbeat = analysis.detect_grid(beat_song(bpm, first, 20.0), RATE)
    assert found is not None and abs(found - bpm) < 0.5
    assert downbeat is not None and abs(downbeat - first) < 0.03


def test_a_pickup_before_bar_one_is_bar_zero() -> None:
    found, _, downbeat = analysis.detect_grid(beat_song(128.0, 2.2, 30.0, pickup=True), RATE)
    assert found is not None and abs(found - 128.0) < 0.5
    assert downbeat is not None and abs(downbeat - 2.2) < 0.03


def test_bar_one_of_a_long_song_is_found_from_its_middle() -> None:
    # Detection listens to the middle two minutes; bar 1 is still counted from the start.
    found, _, downbeat = analysis.detect_grid(beat_song(120.0, 1.3, 150.0), RATE)
    assert found is not None and abs(found - 120.0) < 0.5
    assert downbeat is not None and abs(downbeat - 1.3) < 0.03


@pytest.mark.parametrize("bpm", [79.0, 82.0, 92.0, 95.0, 111.0])
def test_bar_one_of_a_short_song_is_placed_at_its_tempo(bpm: float) -> None:
    # Over 20 s the tracked beats bend the fitted line by a few tenths of a BPM, and the
    # snapped tempo is the true one: bar 1 is placed with it, not 15 to 39 ms late.
    found, _, downbeat = analysis.detect_grid(beat_song(bpm, 1.3, 20.0), RATE)
    assert found == bpm
    assert downbeat is not None and abs(downbeat - 1.3) < 0.01


@pytest.mark.parametrize(("bpm", "first"), [(120.2, 1.3), (127.8, 2.0)])
def test_bar_one_of_a_long_song_off_a_whole_tempo(bpm: float, first: float) -> None:
    # The tempo is reported snapped to the whole number. Bar 1 is still placed with the
    # tempo the beats have, so it is right at the start of the song, and a tempo the user
    # corrects needs no other bar 1. Stepping back 90 s by the snapped tempo, it was 150 ms
    # off.
    found, _, downbeat = analysis.detect_grid(beat_song(bpm, first, 300.0), RATE)
    assert found == round(bpm)
    assert downbeat is not None and abs(downbeat - first) < 0.01


@pytest.mark.parametrize(
    ("kicks", "bpm", "first", "seconds"),
    [
        ((0, 1, 2, 3), 120.0, 2.0, 30.0),
        ((0, 1, 2, 3), 128.0, 1.0, 30.0),
        ((0, 1, 2, 3), 126.0, 1.0, 200.0),
        ((0, 2), 90.0, 0.5, 30.0),
        ((0, 2), 128.0, 0.5, 30.0),
    ],
)
def test_beats_that_kick_alike_put_bar_one_where_the_music_starts(
    kicks: tuple[int, ...], bpm: float, first: float, seconds: float
) -> None:
    # A kick on every beat (four on the floor) or on 1 and 3: no beat stands out, and the
    # song starts on bar 1.
    found, _, downbeat = analysis.detect_grid(drum_song(kicks, bpm, first, seconds), RATE)
    assert found == bpm
    assert downbeat is not None and abs(downbeat - first) < 0.03


def test_finding_bar_one_changes_nothing_else_and_never_fails() -> None:
    song = beat_song(100.0, 0.75, 12.0)
    bpm, key, _ = analysis.detect_grid(song, RATE)
    assert (bpm, key) == analysis.detect_tempo_key(song, RATE)
    silence = np.zeros((2, RATE * 3), dtype=np.float32)
    assert analysis.detect_grid(silence, RATE) == (None, None, None)
    assert analysis.detect_grid(np.zeros((2, 10), dtype=np.float32), RATE)[2] is None


def test_a_job_given_bar_one_keeps_it_beside_the_detected_one(
    client: TestClient, tmp_path: Path
) -> None:
    song = tmp_path / "in" / "Beat.wav"
    song.parent.mkdir()
    write_audio(song, beat_song(120.0, 1.3, 10.0), RATE)
    body = {"path": str(song), "recipe": "full-song", "options": {"downbeat": 0.8}}
    assert client.post("/v1/jobs", json=body).status_code == 200
    (job,) = wait_for(client, all_terminal)
    assert job["state"] == "done"
    assert job["analysis"]["downbeat"] == 0.8
    assert abs(job["analysis"]["detected"]["downbeat"] - 1.3) < 0.03
    written = read_manifest(Path(job["output_dir"]))
    assert written is not None and written["analysis"]["downbeat"] == 0.8

    # A job that waits for Start is given bar 1 by hand and keeps it for its run, which
    # finds the stems already made: the cached result takes it.
    body = {"path": str(song), "recipe": "full-song", "start": False}
    waiting = client.post("/v1/jobs", json=body).json()
    answer = client.post(f"/v1/jobs/{waiting['id']}/analysis", json={"downbeat": 1.23456})
    assert answer.status_code == 200, answer.text
    assert answer.json()["options"]["downbeat"] == 1.2346
    bad = client.post(f"/v1/jobs/{waiting['id']}/analysis", json={"downbeat": 99999})
    assert bad.status_code == 400 and bad.json()["detail"] == "bar 1 must be a time in seconds"
    client.post("/v1/jobs/start")
    jobs = wait_for(client, lambda jobs: len(jobs) == 2 and all_terminal(jobs))
    done = next(j for j in jobs if j["id"] == waiting["id"])
    assert done["state"] == "done" and done["cached"]
    assert done["analysis"]["downbeat"] == 1.2346

    # Moved again on the finished stems, from the history.
    moved = client.post(
        "/v1/stemsets/analysis", json={"directory": job["output_dir"], "downbeat": 1.3}
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["analysis"]["downbeat"] == 1.3
    assert client.get(f"/v1/jobs/{job['id']}").json()["analysis"]["downbeat"] == 1.3


def test_moving_bar_one_changes_the_manifest_and_nothing_else(pipeline, tmp_path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    options = RunOptions(naming_template="{track} {bpm} - {stem}", tempo_sync=True)
    result = pipeline.run(source, full_song(), tmp_path / "out", options)
    folder = Path(result.directory)
    render_mix(folder, [s.file for s in result.stems[:2]])
    render_clips(folder, [result.stems[0].file], 0.5, 2.5, True, None)

    def files() -> dict[str, bytes]:
        found = (p for p in folder.rglob("*") if p.is_file() and p.name != "manifest.json")
        return {p.relative_to(folder).as_posix(): p.read_bytes() for p in found}

    before, detected = files(), dict(result.manifest["analysis"])
    assert detected["downbeat"] is not None
    manifest = set_analysis(folder, {"downbeat": 0.25})
    analysis_now = manifest["analysis"]
    assert analysis_now["downbeat"] == 0.25 and analysis_now["bpm"] == detected["bpm"]
    assert analysis_now["detected"] == {k: detected[k] for k in ("bpm", "key", "downbeat")}
    assert read_manifest(folder) == manifest
    assert files() == before  # every stem, tempo mark, mix and clip, under the same names
    # The same figure again changes nothing, not even the manifest.
    stamp = (folder / "manifest.json").read_bytes()
    set_analysis(folder, {"downbeat": 0.25})
    assert (folder / "manifest.json").read_bytes() == stamp
    # None means bar 1 is not known.
    assert set_analysis(folder, {"downbeat": None})["analysis"]["downbeat"] is None


def test_a_cached_result_takes_the_bar_one_it_is_given(pipeline, tmp_path: Path) -> None:
    source = tmp_path / "Click.wav"
    write_audio(source, click_track(120.0, 10.0), RATE)
    first = pipeline.run(source, full_song(), tmp_path / "out", RunOptions(tempo_sync=True))
    detected = first.manifest["analysis"]["downbeat"]
    assert detected is not None
    options = RunOptions(tempo_sync=True, downbeat=0.42)
    again = pipeline.run(source, full_song(), tmp_path / "out", options)
    assert again.cached  # bar 1 is not a reason to separate the song again
    assert again.manifest["analysis"]["downbeat"] == 0.42
    assert again.manifest["analysis"]["detected"]["downbeat"] == detected


def test_a_trimmed_stem_says_where_it_starts_in_the_song(
    client: TestClient, tmp_path: Path
) -> None:
    song = tmp_path / "in" / "Padded.wav"
    song.parent.mkdir()
    write_audio(song, np.concatenate([np.zeros((2, 4410), np.float32), tone(1.0)], axis=1), RATE)
    (job,) = separated(client, [song], trim_silence=True)
    written = read_manifest(Path(job["output_dir"]))
    assert written is not None
    offsets = {stem["name"]: stem["offset"] for stem in written["stems"]}
    assert min(offsets.values()) >= 4410

    def starts(stems: list[dict[str, Any]]) -> dict[str, float]:
        return {stem["name"]: stem["start"] for stem in stems}

    wanted = {name: offset / 44100 for name, offset in offsets.items()}
    assert starts(job["stems"]) == wanted
    assert starts(client.get("/v1/stemsets").json()["stem_sets"][0]["stems"]) == wanted
    moved = client.post(
        "/v1/stemsets/analysis", json={"directory": job["output_dir"], "downbeat": 0.1}
    )
    assert starts(moved.json()["stems"]) == wanted
    assert starts(client.get(f"/v1/jobs/{job['id']}").json()["stems"]) == wanted


def test_a_job_saved_before_stems_had_a_start_gets_one(tmp_path: Path) -> None:
    from openstems.api.db import Index
    from openstems.api.events import EventBus
    from openstems.api.jobs import JobManager
    from openstems.api.schemas import JobInfo

    # A finished job as the version before saved it: its stems carry the offset the worker
    # sent, counted at the engine's rate, and no start.
    index = Index(tmp_path / "index.sqlite")
    stem: dict[str, Any] = {"name": "vocals", "file": "Song - vocals.wav", "offset": 22050}
    stem.update(path=str(tmp_path / stem["file"]), peaks=None, midi=None)
    stem.update(samples=1000, sample_rate=44100, group=None)
    job: dict[str, Any] = {"id": "old", "track_path": str(tmp_path / "Song.wav")}
    job.update(recipe_id="full-song", state="done", output_dir=str(tmp_path), stems=[stem])
    index.save_job("old", 0, job)
    (restored,) = JobManager(index, EventBus()).list()
    assert restored["stems"][0]["start"] == 0.5
    assert JobInfo.model_validate(restored).stems[0].start == 0.5
    index.close()
