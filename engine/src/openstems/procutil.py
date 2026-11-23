"""Small process helpers shared by the API server and the worker."""

from __future__ import annotations

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


def physical_memory_bytes() -> int | None:
    """The machine's memory, where the system says it without extra packages (macOS and
    Linux). On a Mac this is the unified memory the GPU shares. None on Windows."""
    sysconf = getattr(os, "sysconf", None)
    if sysconf is None:
        return None
    try:
        total = int(sysconf("SC_PHYS_PAGES")) * int(sysconf("SC_PAGE_SIZE"))
    except (ValueError, OSError, TypeError):
        return None
    return total if total > 0 else None
