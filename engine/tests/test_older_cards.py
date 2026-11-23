"""Older NVIDIA cards: which build has kernels for a card, and when half precision pays."""

from __future__ import annotations

import pytest

from openstems.doctor import unsupported_card_problem
from openstems.engines.runner import fast_half_precision
from openstems.engines.torch_common import arch_supported

# What the two NVIDIA builds of PyTorch 2.14 are compiled for.
CU130 = ["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]
CU126 = ["sm_50", "sm_60", "sm_61", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"]


@pytest.mark.parametrize(
    ("card", "capability", "standard", "older"),
    [
        ("GTX 980", (5, 2), False, True),
        ("GTX 1060", (6, 1), False, True),
        ("Titan V", (7, 0), False, True),
        ("GTX 1660 / RTX 2060", (7, 5), True, True),
        ("RTX 3060", (8, 6), True, True),
        ("RTX 4070", (8, 9), True, True),
        ("RTX 5070 Ti", (12, 0), True, False),
    ],
)
def test_which_build_runs_which_card(
    card: str, capability: tuple[int, int], standard: bool, older: bool
) -> None:
    assert arch_supported(capability, CU130) is standard, card
    assert arch_supported(capability, CU126) is older, card


def test_a_build_that_names_no_architectures_is_taken_at_its_word() -> None:
    assert arch_supported((6, 1), []) is True
    assert arch_supported((6, 1), ["gfx1100", "gfx1201"]) is True


def test_half_precision_is_used_only_where_it_is_fast() -> None:
    assert fast_half_precision((5, 2)) is False
    assert fast_half_precision((6, 1)) is False
    assert fast_half_precision((7, 0)) is True
    assert fast_half_precision((12, 0)) is True


def test_the_doctor_names_the_build_to_switch_to() -> None:
    old = unsupported_card_problem("NVIDIA GeForce GTX 1060 6GB", (6, 1), "13.0")
    assert "GTX 1060" in old and "6.1" in old and "CUDA 13.0" in old
    assert "'NVIDIA (older)'" in old
    new = unsupported_card_problem("NVIDIA GeForce RTX 5070 Ti", (12, 0), "12.6")
    assert "to 'NVIDIA' in Settings" in new
    assert "CPU" in new
