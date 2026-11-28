"""The notes of a stem that plays chords (Phase 7, stage M4): a piano, a strummed guitar.

Basic Pitch (Spotify, Apache-2.0; Bittner et al., ICASSP 2022) hears several notes at once.
Its model is a file of 230 KB that runs on the CPU through onnxruntime, as SwiftF0 does. It
takes two seconds of mono audio at 22050 Hz and gives, 86 times a second and for each of a
piano's 88 keys, how likely the key sounds (``note``) and how likely it starts (``onset``).

How it works, in the order the code runs:

1. **Posteriors.** The stem goes through the model in windows of two seconds that share 30
   frames; 15 are dropped at each side of a window, where the model has seen the least.
2. **Notes.** A note starts at a peak of ``onset`` and lasts while ``note`` stays over
   ``FRAME_AT``, with ``GRACE`` frames of patience. What sounds on with no onset found makes
   notes too, from its loudest frame outwards. This is Basic Pitch's own way of making notes,
   written anew; only the onset threshold is the project's (0.6 for its 0.5: on GuitarSet's
   chords 0.737 for 0.725, on its solos 0.853 for 0.828, on Slakh's pianos 0.796 for 0.757;
   ``docs/research/stem-to-midi.md``, section 15).

The model saw GuitarSet, MAESTRO, Slakh, iKala and MedleyDB in training.

No torch: numpy, soxr and onnxruntime.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

from openstems.audio.transcribe import mono16
from openstems.domain.notes import Note

RATE = 22050
HOP = 256
WINDOW = 43844  # the samples the model takes: two seconds less one hop
WINDOW_FRAMES = 172  # the frames it gives for them
SHARED = 30  # frames two windows share
KEYS = 88
LOWEST_KEY = 21  # A0, the model's first key
ONSET_AT = 0.6
FRAME_AT = 0.3
LEAST = 11  # frames a note must last: 128 ms
GRACE = 11  # frames a note may stay under FRAME_AT before it has ended
THREADS = 2

_sessions: dict[str, Any] = {}
_lock = threading.Lock()


def _session(model: Path) -> Any:
    """One session per model file for the process."""
    with _lock:
        key = str(model)
        if key not in _sessions:
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = THREADS
            options.inter_op_num_threads = 1
            _sessions[key] = ort.InferenceSession(key, options, providers=["CPUExecutionProvider"])
        return _sessions[key]


def posteriors(audio22: np.ndarray, model: Path) -> tuple[np.ndarray, np.ndarray]:
    """``(note, onset)`` for mono audio at 22050 Hz: frames by 88 keys, each 0 to 1."""
    session = _session(model)
    name = session.get_inputs()[0].name
    # The file names its outputs by number, and lists them 2, 1, 0: onsets, notes, contours.
    by_shape = [o.name for o in session.get_outputs() if o.shape[-1] == KEYS]
    onset_name, note_name = sorted(by_shape, reverse=True)
    shared = SHARED * HOP
    padded = np.concatenate([np.zeros(shared // 2, np.float32), audio22.astype(np.float32)])
    half = SHARED // 2
    notes, onsets = [], []
    for at in range(0, len(padded), WINDOW - shared):
        window = padded[at : at + WINDOW]
        if len(window) < WINDOW:
            window = np.pad(window, (0, WINDOW - len(window)))
        note, onset = session.run([note_name, onset_name], {name: window[None, :, None]})
        notes.append(note[0, half:-half])
        onsets.append(onset[0, half:-half])
    frames = len(audio22) * (RATE // HOP) // RATE
    return np.concatenate(notes)[:frames], np.concatenate(onsets)[:frames]


def frame_times(frames: int) -> np.ndarray:
    """When each frame is, in seconds. A window is a little short of 172 hops, so the
    model's frames run slightly fast: Basic Pitch's own correction, per window."""
    index = np.arange(frames)
    per_window = HOP / RATE * (WINDOW_FRAMES - WINDOW / HOP) + 0.0018
    return index * HOP / RATE - per_window * np.floor(index / WINDOW_FRAMES)


def _risen(onset: np.ndarray, note: np.ndarray, back: int = 2) -> np.ndarray:
    """The onsets with the rises of ``note`` added: a key that begins to sound has started,
    whatever ``onset`` says."""
    rises = []
    for n in range(1, back + 1):
        padded = np.concatenate([np.zeros((n, note.shape[1]), note.dtype), note])
        rises.append(padded[n:] - padded[:-n])
    rise = np.clip(np.min(rises, axis=0), 0.0, None)
    rise[:back] = 0.0
    top = float(rise.max())
    if top > 0:
        rise = rise * (float(onset.max()) / top)
    return np.maximum(onset, rise)


def _clear(left: np.ndarray, rows: slice | int, key: int) -> None:
    left[rows, max(key - 1, 0) : key + 2] = 0.0


def spans(note: np.ndarray, onset: np.ndarray) -> list[tuple[int, int, int, float]]:
    """``(first frame, frame after the last, key index, mean posterior)`` per note."""
    frames = note.shape[0]
    if frames < 3:
        return []
    onset = _risen(onset, note)
    left = note.astype(np.float32, copy=True)
    inner = onset[1:-1]
    peak = (inner > onset[:-2]) & (inner > onset[2:]) & (inner >= ONSET_AT)
    at, keys = np.nonzero(peak)
    starts = zip((at + 1).tolist(), keys.tolist(), strict=True)
    found: list[tuple[int, int, int, float]] = []
    for t, key in sorted(starts, reverse=True):
        if t >= frames - 1:
            continue
        i, under = t + 1, 0
        while i < frames - 1 and under < GRACE:
            under = under + 1 if left[i, key] < FRAME_AT else 0
            i += 1
        i -= under
        if i - t <= LEAST:
            continue
        _clear(left, slice(t, i), key)
        found.append((t, i, key, float(note[t:i, key].mean())))
    # What still sounds had no onset: from its loudest frame outwards, both ways.
    while float(left.max()) > FRAME_AT:
        mid, key = (int(v) for v in np.unravel_index(int(np.argmax(left)), left.shape))
        left[mid, key] = 0.0
        i, under = mid + 1, 0
        while i < frames - 1 and under < GRACE:
            under = under + 1 if left[i, key] < FRAME_AT else 0
            _clear(left, i, key)
            i += 1
        end = i - 1 - under
        i, under = mid - 1, 0
        while i > 0 and under < GRACE:
            under = under + 1 if left[i, key] < FRAME_AT else 0
            _clear(left, i, key)
            i -= 1
        start = i + 1 + under
        if end - start <= LEAST:
            continue
        found.append((start, end, key, float(note[start:end, key].mean())))
    return sorted(found)


def notes_from(note: np.ndarray, onset: np.ndarray) -> tuple[Note, ...]:
    """The notes the posteriors hold, in time order. A note's confidence is how likely its
    key sounded over the note, and its velocity follows it, as Basic Pitch has it."""
    times = frame_times(note.shape[0] + 1)
    out = []
    for first, after, key, sure in spans(note, onset):
        start, end = max(float(times[first]), 0.0), float(times[after])
        if end <= start:
            continue
        sure = min(max(sure, 0.0), 1.0)
        out.append(
            Note(
                start=start,
                end=end,
                pitch=float(key + LOWEST_KEY),
                velocity=min(max(round(127 * sure), 1), 127),
                confidence=sure,
            )
        )
    return tuple(sorted(out, key=lambda n: (n.start, n.pitch)))


def transcribe_chords(audio: np.ndarray, sample_rate: int, model: Path) -> tuple[Note, ...]:
    """Every note of a stem, several at once where it plays them. ``model`` is Basic Pitch's
    ONNX file."""
    audio22 = mono16(audio, sample_rate, rate=RATE)
    if audio22.size < HOP:
        return ()
    return notes_from(*posteriors(audio22, model))
