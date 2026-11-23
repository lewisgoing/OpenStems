from typer.testing import CliRunner

from openstems.cli import app
from openstems.doctor import DoctorReport, check_ffmpeg_decode, run_doctor


def test_ffmpeg_round_trip_decodes() -> None:
    version, ok, problem = check_ffmpeg_decode()
    assert version is not None
    assert ok, problem


def test_report_fields_are_filled() -> None:
    report = run_doctor()
    assert report.python
    assert report.torch
    assert report.ffmpeg_decode_ok
    assert len(report.lines()) == 8


def test_ok_requires_a_gpu() -> None:
    report = DoctorReport(
        python="3.12",
        torch="2.14.1",
        cuda_available=False,
        cuda_version=None,
        gpu_name=None,
        vram_gb=None,
        ffmpeg="PyAV",
        ffmpeg_decode_ok=True,
    )
    assert not report.ok


def test_cli_exit_code_follows_the_gpu() -> None:
    result = CliRunner().invoke(app, ["doctor"])
    expected = 0 if run_doctor().ok else 1
    assert result.exit_code == expected
    assert "PyTorch" in result.output
