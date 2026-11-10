"""Minimal Mapbox Vector Tile (spec v2.1) encoder with no protobuf dependency.

Only what the pure-Python tiler needs: point + polygon geometries and
string / int / float / bool attributes. tippecanoe replaces all of this for
production-sized builds.
"""

from __future__ import annotations

import struct
from collections.abc import Iterable, Iterator, Sequence

GEOM_POINT = 1
GEOM_POLYGON = 3

Ring = list[tuple[int, int]]


def _varint(n: int, out: bytearray) -> None:
    if n < 0:
        n += 1 << 64
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def _tag(field: int, wire: int, out: bytearray) -> None:
    _varint((field << 3) | wire, out)


def _len_delim(field: int, payload: bytes | bytearray, out: bytearray) -> None:
    _tag(field, 2, out)
    _varint(len(payload), out)
    out += payload


def _packed(values: Iterable[int]) -> bytearray:
    out = bytearray()
    for v in values:
        _varint(v, out)
    return out


def _zz(n: int) -> int:
    return (n << 1) ^ (n >> 31)


def _cmd(cid: int, count: int) -> int:
    return (cid & 0x7) | (count << 3)


def _encode_value(v: object) -> bytes:
    out = bytearray()
    if isinstance(v, bool):
        _tag(7, 0, out)
        _varint(1 if v else 0, out)
    elif isinstance(v, int):
        if v >= 0:
            _tag(5, 0, out)  # uint_value
            _varint(v, out)
        else:
            _tag(6, 0, out)  # sint_value (zigzag)
            _varint((v << 1) ^ (v >> 63), out)
    elif isinstance(v, float):
        _tag(3, 1, out)  # double_value
        out += struct.pack("<d", v)
    else:
        _len_delim(1, str(v).encode("utf-8"), out)  # string_value
    return bytes(out)


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def _ring(coords: Iterable[Sequence[float]], exterior: bool) -> Ring | None:
    pts: Ring = []
    for c in coords:
        p = (int(round(c[0])), int(round(c[1])))
        if not pts or p != pts[-1]:
            pts.append(p)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        return None
    area2 = 0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area2 += x1 * y2 - x2 * y1
    if area2 == 0:
        return None
    # Spec: exterior rings have positive surveyor's-formula area in tile coords (y down),
    # interior rings negative.
    if (exterior and area2 < 0) or (not exterior and area2 > 0):
        pts.reverse()
    return pts


def _iter_polygons(geom) -> Iterator:
    gt = geom.geom_type
    if gt == "Polygon":
        if not geom.is_empty:
            yield geom
    elif gt in ("MultiPolygon", "GeometryCollection"):
        for g in geom.geoms:
            yield from _iter_polygons(g)


def polygon_rings(geom) -> list[list[Ring]]:
    """shapely (Multi)Polygon in tile coordinates -> [[exterior, *holes], ...] integer rings."""
    polys: list[list[Ring]] = []
    for poly in _iter_polygons(geom):
        ext = _ring(poly.exterior.coords, True)
        if ext is None:
            continue
        rings = [ext]
        for hole in poly.interiors:
            r = _ring(hole.coords, False)
            if r:
                rings.append(r)
        polys.append(rings)
    return polys


def encode_points(points: Sequence[tuple[int, int]]) -> list[int]:
    cmds = [_cmd(1, len(points))]
    cx = cy = 0
    for x, y in points:
        cmds += (_zz(x - cx), _zz(y - cy))
        cx, cy = x, y
    return cmds


def encode_polygons(polys: list[list[Ring]]) -> list[int]:
    cmds: list[int] = []
    cx = cy = 0
    for rings in polys:
        for ring in rings:
            x, y = ring[0]
            cmds += (_cmd(1, 1), _zz(x - cx), _zz(y - cy))
            cx, cy = x, y
            cmds.append(_cmd(2, len(ring) - 1))
            for x, y in ring[1:]:
                cmds += (_zz(x - cx), _zz(y - cy))
                cx, cy = x, y
            cmds.append(_cmd(7, 1))
    return cmds


# ---------------------------------------------------------------------------
# Layers / tiles
# ---------------------------------------------------------------------------

# (feature id or None, properties, geometry type, encoded geometry commands)
Feature = tuple[int | None, dict, int, list[int]]


def encode_layer(name: str, features: Sequence[Feature], extent: int = 4096) -> bytes:
    keys: dict[str, int] = {}
    values: dict[tuple[str, object], int] = {}
    value_bytes: list[bytes] = []
    out = bytearray()
    _tag(15, 0, out)
    _varint(2, out)  # version
    _len_delim(1, name.encode("utf-8"), out)
    for fid, props, gtype, geom in features:
        fb = bytearray()
        if fid is not None:
            _tag(1, 0, fb)
            _varint(fid, fb)
        tags: list[int] = []
        for k, v in props.items():
            if v is None:
                continue
            ki = keys.get(k)
            if ki is None:
                ki = keys[k] = len(keys)
            vk = (type(v).__name__, v)
            vi = values.get(vk)
            if vi is None:
                vi = values[vk] = len(value_bytes)
                value_bytes.append(_encode_value(v))
            tags += (ki, vi)
        if tags:
            _len_delim(2, _packed(tags), fb)
        _tag(3, 0, fb)
        _varint(gtype, fb)
        _len_delim(4, _packed(geom), fb)
        _len_delim(2, fb, out)
    for k in keys:
        _len_delim(3, k.encode("utf-8"), out)
    for vb in value_bytes:
        _len_delim(4, vb, out)
    _tag(5, 0, out)
    _varint(extent, out)
    return bytes(out)


def encode_tile(layers: dict[str, Sequence[Feature]], extent: int = 4096) -> bytes:
    out = bytearray()
    for name, feats in layers.items():
        if feats:
            _len_delim(3, encode_layer(name, feats, extent), out)
    return bytes(out)
