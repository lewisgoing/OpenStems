"""SwiftF0, the pitch tracker stem to MIDI uses for single-line stems (Phase 7), is installed
with its model and runs on the CPU. The same test runs on Windows and on a Mac in CI."""

from __future__ import annotations

from importlib import resources

import numpy as np


def test_swiftf0_ships_its_model_and_hears_a_tone() -> None:
    from swift_f0 import SwiftF0

    # The model is inside the wheel: nothing is fetched at run time.
    assert resources.files("swift_f0").joinpath("model.onnx").is_file()

    rate = 16000
    t = np.arange(rate * 2) / rate
    tone = (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)  # A3
    result = SwiftF0(threads=2).detect(tone, rate)
    voiced = result.confidence >= 0.5
    assert voiced.mean() > 0.9
    cents = 1200 * np.log2(np.median(result.pitch_hz[voiced]) / 220.0)
    assert abs(cents) < 10


def test_swiftf0_runs_on_the_cpu_everywhere() -> None:
    import onnxruntime

    # The engine asks for no GPU provider for this model: the CPU one is in every wheel.
    assert "CPUExecutionProvider" in onnxruntime.get_available_providers()
