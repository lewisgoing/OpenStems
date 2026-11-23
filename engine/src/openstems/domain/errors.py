"""Domain errors."""

from __future__ import annotations


class DomainError(ValueError):
    """A domain rule was broken (bad recipe, bad catalog entry, illegal transition)."""


class Cancelled(Exception):
    """The running operation was cancelled through its cancel token."""
