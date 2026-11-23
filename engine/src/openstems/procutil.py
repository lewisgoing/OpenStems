"""Small process helpers shared by the API server and the worker."""

from __future__ import annotations

import math
import os


def process_alive(pid: int) -> bool:
    """Whether a process with this id is still running."""
    if os.name == "nt":
        import ctypes

        SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            # WAIT_TIMEOUT (258) means the process is still running.
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == 258
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True  # it exists, but belongs to someone else
    except OSError:
        return False
    return True


def _windows_memory_bytes() -> int | None:
    """Installed memory on Windows, from ``GlobalMemoryStatusEx``."""
    import ctypes

    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatus()
    status.dwLength = ctypes.sizeof(MemoryStatus)
    try:
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
    except (AttributeError, OSError):
        return None
    return int(status.ullTotalPhys) or None


def physical_memory_bytes() -> int | None:
    """The machine's memory, without extra packages. On a Mac this is the unified memory
    the GPU shares. None when the system does not say."""
    sysconf = getattr(os, "sysconf", None)
    if sysconf is None:
        return _windows_memory_bytes() if os.name == "nt" else None
    try:
        total = int(sysconf("SC_PHYS_PAGES")) * int(sysconf("SC_PAGE_SIZE"))
    except (ValueError, OSError, TypeError):
        return None
    return total if total > 0 else None


def memory_override_bytes() -> int | None:
    """``OPENSTEMS_MEMORY_GB=<number>``: pretend the machine (on a PC with a graphics card:
    the card) has this much memory. A test and support switch: it lets a large machine act
    as a small one. It changes what the engine plans for, not what the machine has.
    Anything that is not a plain positive number is ignored."""
    raw = os.environ.get("OPENSTEMS_MEMORY_GB", "").strip()
    try:
        value = float(raw) if raw else 0.0
    except ValueError:
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return int(value * 1024**3) or None


def machine_memory_bytes() -> int | None:
    """The machine's memory as the engine should see it: the override, or the real figure."""
    return memory_override_bytes() or physical_memory_bytes()
