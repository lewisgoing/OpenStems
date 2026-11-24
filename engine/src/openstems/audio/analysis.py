"""Tempo, key and bar 1 detection, pitch tracking for stem-to-MIDI, and silence detection."""

from __future__ import annotations

import math
from typing import NamedTuple

import numpy as np

ANALYSIS_RATE = 22050
MAX_ANALYSIS_SECONDS = 120.0
_HOP = 256
# The kick usually lands on beat 1, and it lives below this.
LOW_HZ = 200.0
# Where the music starts: the first sample above this level.
MUSIC_START_DB = -50.0
# The beat line is put on the onsets with an envelope in 1.5 ms steps, over this much of
# the excerpt (the envelope is large: 40 MB for 30 s).
_FINE_HOP = 32
_FINE_SECONDS = 30.0
# That envelope peaks a few milliseconds after an attack begins. Bar 1 is put this much
# earlier, so a clip starts just before the attack instead of cutting into it.
ATTACK_LEAD = 0.005
# Beats of the bar whose low onsets score within this fraction of the best are alike: a
# kick on every beat, or on 1 and 3. Of those, bar 1 is the one nearest the music start.
PHASE_TIE = 0.05

_PITCHES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Krumhansl-Schmuckler key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _excerpt(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, float]:
    """Mono, resampled to the analysis rate and limited to the middle two minutes, and
    where that excerpt starts in the song, in seconds."""
    import librosa

    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    limit = int(MAX_ANALYSIS_SECONDS * sample_rate)
    start = 0
    if mono.shape[0] > limit:
        start = (mono.shape[0] - limit) // 2
        mono = mono[start : start + limit]
    excerpt = librosa.resample(
        mono.astype(np.float32), orig_sr=sample_rate, target_sr=ANALYSIS_RATE
    )
    return excerpt, start / sample_rate


def _mono_excerpt(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Mono, resampled to the analysis rate, and limited to the middle two minutes."""
    return _excerpt(audio, sample_rate)[0]


class _BeatLine(NamedTuple):
    """The tracked beats of an excerpt, as a line through their times."""

    bpm: float  # the tempo as `detect_tempo` reports it: folded, snapped when close
    period: float  # seconds per beat at the folded tempo, not snapped
    first: float  # where the line puts the first tracked beat, in seconds of the excerpt
    tracked: float  # seconds between tracked beats, which folding may have doubled or halved


def _beat_line(mono: np.ndarray) -> _BeatLine | None:
    import librosa

    if mono.shape[0] < ANALYSIS_RATE * 2 or float(np.abs(mono).max()) < 1e-4:
        return None
    onset = librosa.onset.onset_strength(y=mono, sr=ANALYSIS_RATE, hop_length=_HOP)
    if float(onset.max()) <= 0:
        return None
    rough, beats = librosa.beat.beat_track(
        onset_envelope=onset, sr=ANALYSIS_RATE, hop_length=_HOP, units="time"
    )
    tempo = float(np.atleast_1d(rough)[0])
    beats = np.asarray(beats, dtype=np.float64)
    first = float(beats[0]) if beats.size else 0.0
    if beats.size >= 8:
        period, intercept = (float(v) for v in np.polyfit(np.arange(beats.size), beats, 1))
        if period > 0:
            tempo = 60.0 / period
            first = intercept
    if not np.isfinite(tempo) or tempo <= 0:
        return None
    tracked = 60.0 / tempo
    while tempo < 70:
        tempo *= 2
    while tempo > 180:
        tempo /= 2
    # Most music sits on a whole number: snap when the estimate is that close.
    bpm = float(round(tempo)) if abs(tempo - round(tempo)) < 0.25 else round(tempo, 1)
    return _BeatLine(bpm, 60.0 / tempo, first, tracked)


def detect_tempo(mono: np.ndarray) -> float | None:
    """Tempo in BPM, folded into the 70 to 180 range.

    A tempogram only resolves tempo in coarse steps (117.5, 129.2, ...), so the beats are
    tracked and a line is fitted through their times: the slope is the beat period.
    """
    line = _beat_line(mono)
    return line.bpm if line is not None else None


def _on_the_onsets(mono: np.ndarray, line: _BeatLine) -> _BeatLine:
    """The beat line moved onto the onsets it was tracked from, at the period that fits
    them best.

    The tracker smooths the onset envelope before it picks beats, and that envelope peaks
    a frame after each attack, so the line runs 20 to 50 ms late: enough to cut the attack
    off the start of a clip. Averaged over every beat, a finer envelope peaks where the
    beats really are, and the line is moved there.

    Two periods are tried: the fitted line's and the reported tempo's. Over a short song
    the tracker bends the fit by a few tenths of a BPM and the snapped tempo is the true
    one; over a long song whose tempo is near a whole number but not on it, the fit is.
    A wrong period smears the average, so the one whose average peaks higher is kept, and
    the phase and the step back to bar 1 use it too.
    """
    import librosa

    candidates = [line, line._replace(period=60.0 / line.bpm)]
    longest = max(candidate.period for candidate in candidates)
    end = min(mono.shape[0] / ANALYSIS_RATE, longest + _FINE_SECONDS)
    env = librosa.onset.onset_strength(
        y=mono[: int(end * ANALYSIS_RATE)],
        sr=ANALYSIS_RATE,
        hop_length=_FINE_HOP,
        n_fft=512,
        n_mels=32,
    )
    best: tuple[float, _BeatLine] | None = None
    for candidate in candidates:
        period = candidate.period
        start = candidate.first - math.floor(candidate.first / period) * period
        reach = int(min(0.07, period / 3) * ANALYSIS_RATE / _FINE_HOP)
        frames = np.round(np.arange(start, end, period) * ANALYSIS_RATE / _FINE_HOP).astype(int)
        frames = frames[(frames >= reach) & (frames + reach < env.size)]
        if frames.size < 4:
            continue
        steps = np.arange(-reach, reach + 1)
        profile = env[frames[:, None] + steps[None, :]].mean(axis=0)
        peak = int(np.argmax(profile))
        if best is None or float(profile[peak]) > best[0]:
            shift = float(steps[peak]) * _FINE_HOP / ANALYSIS_RATE
            best = (float(profile[peak]), candidate._replace(first=candidate.first + shift))
    return line if best is None else best[1]


def _downbeat(
    mono: np.ndarray,
    offset: float,
    line: _BeatLine,
    audio: np.ndarray,
    sample_rate: int,
    beats_per_bar: int = 4,
) -> float:
    """Where bar 1 starts, in seconds into the song.

    Which beat of the bar is "1": the one whose beats carry the strongest low onsets on
    average, since the kick usually lands on it. Only bar lines where the music plays
    count: one in the silence before or after it would score as a beat without a kick.
    When the tracked beats came twice as fast as the tempo, half of them are off the beat,
    so half beats are candidates too. Each candidate steps back by whole bars to its first
    bar line at or after where the music starts, less half a beat: a pickup before bar 1
    is bar 0. A kick on every beat (four on the floor), or on 1 and 3, makes beats score
    alike: of those within `PHASE_TIE` of the best, the one nearest where the music starts
    is "1", since most songs start on bar 1.
    """
    import librosa

    line = _on_the_onsets(mono, line)
    low = librosa.onset.onset_strength(
        y=mono, sr=ANALYSIS_RATE, hop_length=_HOP, n_fft=2048, n_mels=16, fmax=LOW_HZ
    )
    split = 2 if line.tracked < 0.75 * line.period else 1
    beat = line.period
    bar = beat * beats_per_bar
    length = mono.shape[0] / ANALYSIS_RATE
    loud, quiet = silence_bounds(audio, MUSIC_START_DB)
    start = loud / sample_rate  # where the music starts, in seconds of the song
    # Where the music plays, in seconds of the excerpt.
    plays = (start - offset - beat / 2, quiet / sample_rate - offset) if quiet else None
    scored: list[tuple[float, float]] = []
    for k in range(beats_per_bar * split):
        phase = line.first + k * beat / split
        earliest = phase - math.floor(phase / bar) * bar  # this phase's first bar line
        times = np.arange(earliest, length, bar)
        if plays is not None:
            times = times[(times >= plays[0]) & (times <= plays[1])]
        frames = librosa.time_to_frames(times, sr=ANALYSIS_RATE, hop_length=_HOP)
        frames = frames[frames < low.size]
        score = 0.0
        if frames.size:
            # The onsets within three frames either side, summed: where an attack falls
            # in a frame changes how it is split between frames, not what they add up to.
            near = np.stack([low[np.clip(frames + d, 0, low.size - 1)] for d in range(-3, 4)])
            score = float(near.sum(axis=0).mean())
        bar_one = earliest + offset
        bar_one += math.ceil((start - beat / 2 - bar_one) / bar) * bar
        scored.append((score, bar_one))
    top = max(score for score, _ in scored)
    alike = [bar_one for score, bar_one in scored if score >= (1 - PHASE_TIE) * top]
    return round(min(alike, key=lambda bar_one: abs(bar_one - start)) - ATTACK_LEAD, 4)


def detect_key(mono: np.ndarray) -> str | None:
    """Key as a short name such as ``C`` or ``Am`` (Krumhansl-Schmuckler on chroma)."""
    import librosa

    if mono.shape[0] < ANALYSIS_RATE or float(np.abs(mono).max()) < 1e-4:
        return None
    chroma = librosa.feature.chroma_cqt(y=mono, sr=ANALYSIS_RATE).mean(axis=1)
    if float(chroma.std()) < 1e-6:
        return None
    best: tuple[float, str] | None = None
    for shift in range(12):
        rotated = np.roll(chroma, -shift)
        for profile, suffix in ((_MAJOR, ""), (_MINOR, "m")):
            score = float(np.corrcoef(rotated, profile)[0, 1])
            if best is None or score > best[0]:
                best = (score, _PITCHES[shift] + suffix)
    return best[1] if best else None


def detect_tempo_key(audio: np.ndarray, sample_rate: int) -> tuple[float | None, str | None]:
    """Both at once. Never raises: analysis is a nicety, not a reason to fail a job."""
    try:
        mono = _mono_excerpt(audio, sample_rate)
        return detect_tempo(mono), detect_key(mono)
    except Exception:
        return None, None


def detect_grid(
    audio: np.ndarray, sample_rate: int
) -> tuple[float | None, str | None, float | None]:
    """The tempo and key as `detect_tempo_key` finds them, and where bar 1 starts, in
    seconds into the song (None without a tempo). Never raises."""
    try:
        mono, offset = _excerpt(audio, sample_rate)
        line = _beat_line(mono)
        key = detect_key(mono)
    except Exception:
        return None, None, None
    if line is None:
        return None, key, None
    try:
        downbeat = _downbeat(mono, offset, line, audio, sample_rate)
    except Exception:
        downbeat = None
    return line.bpm, key, downbeat


def silence_bounds(audio: np.ndarray, threshold_db: float = -60.0) -> tuple[int, int]:
    """First and one-past-last sample above the threshold. ``(0, 0)`` for pure silence."""
    level = np.abs(audio).max(axis=0) if audio.ndim == 2 else np.abs(audio)
    loud = np.flatnonzero(level > 10 ** (threshold_db / 20))
    if loud.size == 0:
        return 0, 0
    return int(loud[0]), int(loud[-1]) + 1


def track_notes(
    audio: np.ndarray,
    sample_rate: int,
    fmin: float = 55.0,
    fmax: float = 1200.0,
    min_note_seconds: float = 0.08,
) -> list[tuple[float, float, int, int]]:
    """A monophonic transcription: ``(start, end, midi_note, velocity)`` per note.

    YIN gives a pitch per frame; frames that are too quiet are unvoiced; the pitch is
    median-smoothed and runs of the same semitone become notes.
    """
    import librosa

    rate = 16000
    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    mono = librosa.resample(mono.astype(np.float32), orig_sr=sample_rate, target_sr=rate)
    if mono.shape[0] < rate // 4:
        return []
    frame, hop = 2048, 256
    f0 = librosa.yin(mono, fmin=fmin, fmax=fmax, sr=rate, frame_length=frame, hop_length=hop)
    rms = librosa.feature.rms(y=mono, frame_length=frame, hop_length=hop)[0]
    count = min(len(f0), len(rms))
    f0, rms = f0[:count], rms[:count]
    peak = float(rms.max())
    if peak < 1e-4:
        return []
    voiced = (rms > max(peak * 0.06, 1e-4)) & (f0 > fmin * 1.02) & (f0 < fmax * 0.98)
    midi = np.where(voiced, np.round(librosa.hz_to_midi(np.maximum(f0, 1e-6))), -1).astype(int)

    # Median over five frames removes single-frame octave slips.
    padded = np.pad(midi, 2, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, 5)
    midi = np.median(windows, axis=1).astype(int)

    seconds = hop / rate
    min_frames = max(1, round(min_note_seconds / seconds))
    notes: list[tuple[float, float, int, int]] = []
    start = 0
    for i in range(1, count + 1):
        if i == count or midi[i] != midi[start]:
            note = int(midi[start])
            if note >= 0 and i - start >= min_frames:
                loudness = float(rms[start:i].mean()) / peak
                velocity = int(np.clip(round(40 + 87 * np.sqrt(loudness)), 1, 127))
                notes.append((start * seconds, i * seconds, note, velocity))
            start = i
    # Join a note to the next one of the same pitch when the gap is a frame or two.
    merged: list[tuple[float, float, int, int]] = []
    for note in notes:
        if merged and merged[-1][2] == note[2] and note[0] - merged[-1][1] <= 2 * seconds:
            prev = merged.pop()
            merged.append((prev[0], note[1], prev[2], max(prev[3], note[3])))
        else:
            merged.append(note)
    return merged
