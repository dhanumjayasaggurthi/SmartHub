"""Strict recognition of simple pgvector halfvec-cast ANN index expressions.

An index can qualify only when PostgreSQL's canonical expression is a
single direct cast of one column to halfvec(N). Arbitrary expressions, filters,
functions and implicit casts are deliberately excluded.
"""
from __future__ import annotations

import re

_IDENTIFIER = r'(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)'
_CAST = re.compile(
    rf"^(?P<column>{_IDENTIFIER})\s*::\s*"
    rf"(?:(?P<schema>{_IDENTIFIER})\s*\.\s*)?"
    rf"halfvec\s*\(\s*(?P<dimensions>[0-9]+)\s*\)$",
    re.IGNORECASE,
)


def _unwrap(expression: str) -> str:
    """Remove only genuinely balanced *outer* parentheses, respecting quotes."""
    value = expression.strip()
    while value.startswith("(") and value.endswith(")"):
        level = 0
        quoted = False
        wraps = True
        pos = 0
        while pos < len(value):
            char = value[pos]
            if char == '"':
                if quoted and pos + 1 < len(value) and value[pos + 1] == '"':
                    pos += 2
                    continue
                quoted = not quoted
            elif not quoted:
                if char == "(":
                    level += 1
                elif char == ")":
                    level -= 1
                    if level == 0 and pos != len(value) - 1:
                        wraps = False
                        break
                    if level < 0:
                        return value
            pos += 1
        if quoted or level != 0 or not wraps:
            return value
        value = value[1:-1].strip()
    return value


def halfvec_cast_index(expression: str) -> tuple[str, int] | None:
    """Return (source column, halfvec dimensions), or None.

    Input is PostgreSQL's pg_get_indexdef(index_oid, 1, true), never user SQL.
    Reject anything more complex than a cast of a single column.
    """
    if not isinstance(expression, str) or len(expression) > 512:
        return None
    expr = _unwrap(expression)
    # pg_get_indexdef writes the source as (col)::halfvec(N).
    match = re.fullmatch(
        rf"(?P<source>.+?)\s*::\s*(?:(?:{_IDENTIFIER})\s*\.\s*)?"
        r"halfvec\s*\(\s*(?P<dimensions>[0-9]+)\s*\)",
        expr, re.IGNORECASE,
    )
    if not match:
        return None
    source = _unwrap(match.group("source"))
    if not re.fullmatch(_IDENTIFIER, source):
        return None
    dimension = int(match.group("dimensions"))
    if not 1 <= dimension <= 4000:
        return None
    if source.startswith('"'):
        source = source[1:-1].replace('""', '"')
    else:
        source = source.lower()  # PostgreSQL folds bare identifiers.
    return source, dimension
