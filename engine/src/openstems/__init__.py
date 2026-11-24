"""OpenStems: local GPU stem separation."""

import os as _os
import sys as _sys

# On a Mac, let PyTorch run an operation the Apple GPU lacks on the CPU instead of failing.
# PyTorch reads this when it is first imported, and every entry point (the command line, the
# API, the worker process) imports this package before it imports PyTorch.
if _sys.platform == "darwin":
    _os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

__version__ = "0.3.3"
