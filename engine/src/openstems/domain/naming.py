"""File names that stay valid on Windows and keep non-ASCII characters."""

from __future__ import annotations

import re
import unicodedata

_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
MAX_COMPONENT = 120
DEFAULT_TEMPLATE = "{track} - {stem}"
TEMPLATE_TOKENS = ("track", "stem", "recipe", "bpm", "key", "model")


def safe_component(name: str, fallback: str = "untitled") -> str:
    """Make one path component safe for Windows without dropping non-ASCII text."""
    name = unicodedata.normalize("NFC", name)
    name = _FORBIDDEN.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > MAX_COMPONENT:
        name = name[:MAX_COMPONENT].rstrip(" .")
    if not name:
        name = fallback
    if name.split(".")[0].upper() in _RESERVED:
        name = f"_{name}"
    return name


def clean_name(value: object) -> str | None:
    """A song's name as the user typed it, or None for "the file's own name".

    The name is what people read: it keeps characters a file name cannot hold, and
    `safe_component` replaces those where it names a folder or a file. The app checks what
    is typed by the same rule (``cleanName`` in ``app/src/lib/songname.ts``); the cases are
    in ``tests/fixtures/song_names.json``.
    """
    from openstems.domain.errors import DomainError

    if value is None:
        return None
    if not isinstance(value, str):
        raise DomainError("a song's name must be text")
    name = unicodedata.normalize("NFC", value)
    name = re.sub(r"[\x00-\x1f\x7f]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    if not name:
        return None
    if len(name) > MAX_COMPONENT:
        raise DomainError(f"a song's name can be up to {MAX_COMPONENT} characters")
    if not name.strip(" ."):
        raise DomainError("a song's name needs more than dots")
    return name


def render_name(template: str, **tokens: str) -> str:
    """Fill a naming template. Unknown or empty tokens are dropped along with stray separators."""

    def repl(match: re.Match[str]) -> str:
        return str(tokens.get(match.group(1), "") or "")

    out = re.sub(r"\{(\w+)\}", repl, template or DEFAULT_TEMPLATE)
    # Tidy separators left behind by empty tokens: "Song -  - vocals" -> "Song - vocals".
    out = re.sub(r"(\s*[-_]\s*){2,}", " - ", out)
    out = re.sub(r"^\s*[-_]\s*|\s*[-_]\s*$", "", out)
    return safe_component(out)


def validate_template(template: str) -> None:
    from openstems.domain.errors import DomainError

    names = re.findall(r"\{(\w+)\}", template)
    unknown = [n for n in names if n not in TEMPLATE_TOKENS]
    if unknown:
        raise DomainError(f"unknown template tokens: {unknown}; allowed: {TEMPLATE_TOKENS}")
    if "stem" not in names:
        raise DomainError("the naming template must contain {stem}")
