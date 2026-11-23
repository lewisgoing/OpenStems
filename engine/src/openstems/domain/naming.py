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
