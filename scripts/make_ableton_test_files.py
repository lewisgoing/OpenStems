"""Test files for Ableton Live (ADR 0016): one synthetic song at 97 BPM, bar 1 at 1.237 s.

Run from engine/: uv run python ../scripts/make_ableton_test_files.py FOLDER
"""
import sys
from pathlib import Path
import numpy as np
import soundfile as sf
from openstems.audio.write import _append_chunk, tempo_chunk
import struct

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
SR, BPM, BARS, PICKUP_BEATS = 44100, 97.0, 100, 2
beat = 60 / BPM
bar1 = PICKUP_BEATS * beat
length = bar1 + BARS * 4 * beat + 2.0
n = int(length * SR)
rng = np.random.default_rng(7)

def at(t): return int(round(t * SR))
def add(buf, t, sig):
    i = at(t); j = min(n, i + len(sig)); buf[i:j] += sig[: j - i]

def kick():
    t = np.arange(int(0.25 * SR)) / SR
    return np.sin(2 * np.pi * (50 + 90 * np.exp(-t * 30)) * t) * np.exp(-t * 12) * 0.9
def snare():
    t = np.arange(int(0.18 * SR)) / SR
    return (rng.standard_normal(len(t)) * 0.5 + np.sin(2 * np.pi * 190 * t) * 0.3) * np.exp(-t * 22)
def hat(level=0.18):
    t = np.arange(int(0.05 * SR)) / SR
    x = np.diff(rng.standard_normal(len(t) + 1)); return x * np.exp(-t * 80) * level
def crash():
    t = np.arange(int(1.5 * SR)) / SR
    x = np.diff(rng.standard_normal(len(t) + 1)); return x * np.exp(-t * 2.5) * 0.25

drums, bass, melody = np.zeros(n), np.zeros(n), np.zeros(n)
# The pickup: hats only, so bar 1 is the first kick.
for k in range(PICKUP_BEATS * 2):
    add(drums, k * beat / 2, hat(0.1))
roots = [55.0, 55.0, 43.65, 49.0]  # A, A, F, G
scale = [440.0, 523.25, 587.33, 659.25, 783.99, 659.25, 587.33, 523.25]
for b in range(BARS):
    t0 = bar1 + b * 4 * beat
    if b % 4 == 0: add(drums, t0, crash())
    for q in range(4):
        tq = t0 + q * beat
        if q in (0, 2): add(drums, tq, kick())
        if q in (1, 3): add(drums, tq, snare())
        add(drums, tq, hat()); add(drums, tq + beat / 2, hat(0.12))
    # Bass: a note on beats 1 and 3.
    f = roots[(b // 2) % 4]
    for q in (0, 2):
        t = np.arange(int(beat * 1.8 * SR)) / SR
        add(bass, t0 + q * beat, np.sin(2 * np.pi * f * t) * np.minimum(1, t * 200) * np.exp(-t * 1.5) * 0.6)
    # Melody: soft attacks (40 ms fade in), a note every half bar, like a vocal or a pad.
    for h in range(2):
        t = np.arange(int(2 * beat * SR)) / SR
        f = scale[(b * 2 + h) % len(scale)]
        env = np.minimum(1, t / 0.04) * np.exp(-t * 0.8)
        add(melody, t0 + h * 2 * beat, (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * env * 0.25)

def write(name, mono, chunk=None):
    p = out / name
    sf.write(p, np.stack([mono, mono], 1).astype(np.float32) * 0.8, SR, subtype="FLOAT")
    if chunk: _append_chunk(p, chunk)
    return p

total_beats = (length * BPM) / 60
def acid_with_beats(bpm, beats):
    return b"acid" + struct.pack("<IIHHfIHHf", 24, 0x04, 60, 0x80, 0.0, int(beats), 4, 4, bpm)

write("A plain.wav", drums)
write("B acid tempo.wav", drums, tempo_chunk(BPM))
write("C acid tempo and beats.wav", drums, acid_with_beats(BPM, total_beats))
write("D 97bpm.wav", drums)
write("E plain no pickup.wav", drums[at(bar1):])
for stem, sig in (("drums", drums), ("bass", bass), ("melody", melody)):
    write(f"F song - {stem}.wav", sig, tempo_chunk(BPM))
short = drums[at(bar1): at(bar1 + 8 * 4 * beat)]
write("G loop 8 bars plain.wav", short)
write("H loop 8 bars acid.wav", short, tempo_chunk(BPM))
print(f"bar 1 at {bar1:.4f} s, {length:.1f} s long, {total_beats:.2f} beats")
