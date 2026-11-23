"""Tempo and key detection, pitch tracking for stem-to-MIDI, and silence detection."""

from __future__ import annotations

import numpy as np

ANALYSIS_RATE = 22050
MAX_ANALYSIS_SECONDS = 120.0

_PITCHES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Krumhansl-Schmuckler key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _mono_excerpt(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Mono, resampled to the analysis rate, and limited to the middle two minutes."""
    import librosa

    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    limit = int(MAX_ANALYSIS_SECONDS * sample_rate)
    if mono.shape[0] > limit:
        start = (mono.shape[0] - limit) // 2
        mono = mono[start : start + limit]
    return librosa.resample(mono.astype(np.float32), orig_sr=sample_rate, target_sr=ANALYSIS_RATE)


def detect_tempo(mono: np.ndarray) -> float | None:
    """Tempo in BPM, folded into the 70 to 180 range.

    A tempogram only resolves tempo in coarse steps (117.5, 129.2, ...), so the beats are
    tracked and a line is fitted through their times: the slope is the beat period.
    """
    import librosa

    if mono.shape[0] < ANALYSIS_RATE * 2 or float(np.abs(mono).max()) < 1e-4:
        return None
    hop = 256
    onset = librosa.onset.onset_strength(y=mono, sr=ANALYSIS_RATE, hop_length=hop)
    if float(onset.max()) <= 0:
        return None
    rough, beats = librosa.beat.beat_track(
        onset_envelope=onset, sr=ANALYSIS_RATE, hop_length=hop, units="time"
    )
    tempo = float(np.atleast_1d(rough)[0])
    beats = np.asarray(beats, dtype=np.float64)
    if beats.size >= 8:
        period = float(np.polyfit(np.arange(beats.size), beats, 1)[0])
        if period > 0:
            tempo = 60.0 / period
    if not np.isfinite(tempo) or tempo <= 0:
        return None
    while tempo < 70:
        tempo *= 2
    while tempo > 180:
        tempo /= 2
    # Most music sits on a whole number: snap when the estimate is that close.
    if abs(tempo - round(tempo)) < 0.25:
        return float(round(tempo))
    return round(tempo, 1)


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
