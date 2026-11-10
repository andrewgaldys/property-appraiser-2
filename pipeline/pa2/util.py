"""Small, dependency-free helpers shared by every pipeline stage."""

from __future__ import annotations

import math
import re

_WS = re.compile(r"\s+")
_NON_ID = re.compile(r"[^0-9A-Z]")
_NON_DIGIT = re.compile(r"\D")


def is_blank(v: object) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    s = str(v).strip()
    return s == "" or s.lower() in ("nan", "none", "null", "<na>")


def clean_str(v: object) -> str:
    """Trim + collapse internal whitespace; '' for blanks/NaN."""
    if is_blank(v):
        return ""
    return _WS.sub(" ", str(v)).strip()


def to_int(v: object) -> int | None:
    if is_blank(v):
        return None
    try:
        return int(round(float(str(v).replace(",", "").replace("$", "").strip())))
    except ValueError:
        return None


def to_float(v: object) -> float | None:
    if is_blank(v):
        return None
    try:
        f = float(str(v).replace(",", "").replace("$", "").strip())
    except ValueError:
        return None
    return None if math.isnan(f) else f


def zip5(v: object) -> str:
    """'33401-1234' / '334011234' / 33401.0 -> '33401'."""
    if is_blank(v):
        return ""
    s = str(v).strip()
    if s.endswith(".0"):
        s = s[:-2]
    digits = _NON_DIGIT.sub("", s)
    if len(digits) < 5:
        return digits.zfill(5) if len(digits) >= 3 else ""
    return digits[:5]


def norm_parcel_id(v: object) -> str:
    """Canonical join key: uppercase alphanumerics only ('53-38-41-000' -> '533841000')."""
    if is_blank(v):
        return ""
    s = str(v).strip().upper()
    if s.endswith(".0"):
        s = s[:-2]
    return _NON_ID.sub("", s)


def fnv1a32(s: str) -> str:
    """32-bit FNV-1a as 8 lowercase hex chars. Mirrored exactly in web/src/data.ts."""
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def pid_shard(parcel_id: str, hex_len: int) -> str:
    return fnv1a32(parcel_id)[:hex_len]


def key_shard(key: int, hex_len: int) -> str:
    return format(key % (16**hex_len), f"0{hex_len}x")


def round_or_none(v: float | None, nd: int) -> float | None:
    return None if v is None else round(v, nd)
