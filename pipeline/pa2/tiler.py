"""Vector tiling to PMTiles.

* tippecanoe (recommended, required in practice for the full ~850k-parcel build):
  `brew install tippecanoe` / build from https://github.com/felt/tippecanoe (>= 2.17
  writes .pmtiles directly).
* Pure-Python fallback (shapely + pmtiles + pa2.mvt): no native tooling, fine for the
  sample and workable (slow, no feature dropping) for a single county.
"""

from __future__ import annotations

import gzip
import json
import shutil
import subprocess
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

from .mvt import GEOM_POINT, GEOM_POLYGON, encode_points, encode_polygons, encode_tile, polygon_rings

EXTENT = 4096
BUFFER = 64  # tile units of overlap for clipped polygons (tippecanoe default ~80)

# (fid, tile properties, shapely geometry in EPSG:4326)
TileFeature = tuple[int, dict, object]


def tippecanoe_path() -> str | None:
    return shutil.which("tippecanoe")


def python_tiler_available() -> bool:
    try:
        import pmtiles  # noqa: F401
        import shapely  # noqa: F401
    except ImportError:
        return False
    return True


def _round_coords(obj, nd: int = 6):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(c, nd) for c in obj[:2]]
        return [_round_coords(o, nd) for o in obj]
    return obj


def geojson_geometry(geom, nd: int = 6) -> dict:
    from shapely.geometry import mapping

    m = mapping(geom)
    return {"type": m["type"], "coordinates": _round_coords(m["coordinates"], nd)}


def write_ndjson(path: Path, features: Iterable[TileFeature]) -> int:
    """Newline-delimited GeoJSON for tippecanoe (`id` = numeric feature id)."""
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for fid, props, geom in features:
            f.write(
                json.dumps(
                    {"type": "Feature", "id": fid, "properties": props, "geometry": geojson_geometry(geom)},
                    separators=(",", ":"),
                )
            )
            f.write("\n")
            n += 1
    return n


def run_tippecanoe(
    ndjson: Path,
    out: Path,
    *,
    layer: str,
    kind: str,
    minzoom: int,
    maxzoom: int,
    name: str,
    attribution: str,
    description: str,
) -> None:
    exe = tippecanoe_path()
    if not exe:
        raise RuntimeError("tippecanoe not found on PATH")
    args = [
        exe,
        "-o", str(out),
        "--force",
        "--layer", layer,
        "--name", name,
        "--attribution", attribution,
        "--description", description,
        "--minimum-zoom", str(minzoom),
        "--maximum-zoom", str(maxzoom),
        "--read-parallel",
        "--quiet",
    ]
    if kind == "polygon":
        # Keep every parcel at z13+; thin the smallest ones only where z12 tiles overflow.
        args += ["--detect-shared-borders", "--simplification=2", "--drop-smallest-as-needed",
                 "--no-tiny-polygon-reduction"]
    else:
        args += ["-r1", "--drop-densest-as-needed"]
    args.append(str(ndjson))
    subprocess.run(args, check=True)


def build_pmtiles_python(
    features: list[TileFeature],
    out: Path,
    *,
    layer: str,
    kind: str,
    minzoom: int,
    maxzoom: int,
    name: str,
    attribution: str,
    description: str,
) -> dict:
    """Clip, encode (MVT), gzip and pack tiles into a PMTiles v3 archive."""
    import numpy as np
    import shapely
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer

    world = float(2**maxzoom * EXTENT)

    def project(c: np.ndarray) -> np.ndarray:
        lon = c[:, 0]
        lat = np.clip(c[:, 1], -85.05112878, 85.05112878)
        s = np.sin(np.radians(lat))
        x = (lon + 180.0) / 360.0 * world
        y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * world
        return np.column_stack([x, y])

    projected = [(fid, props, shapely.transform(geom, project)) for fid, props, geom in features]

    tiles: dict[int, bytes] = {}
    for z in range(minzoom, maxzoom + 1):
        scale = 2.0 ** (z - maxzoom)
        n_tiles = 2**z
        buckets: dict[tuple[int, int], list] = defaultdict(list)
        for fid, props, g in projected:
            gz = g if z == maxzoom else shapely.transform(g, lambda c, s=scale: c * s)
            if kind == "point":
                x, y = gz.x, gz.y
                tx, ty = int(x // EXTENT), int(y // EXTENT)
                local = (int(round(x - tx * EXTENT)), int(round(y - ty * EXTENT)))
                buckets[(tx, ty)].append((fid, props, GEOM_POINT, encode_points([local])))
                continue
            minx, miny, maxx, maxy = gz.bounds
            tx0, tx1 = max(int((minx - BUFFER) // EXTENT), 0), min(int((maxx + BUFFER) // EXTENT), n_tiles - 1)
            ty0, ty1 = max(int((miny - BUFFER) // EXTENT), 0), min(int((maxy + BUFFER) // EXTENT), n_tiles - 1)
            for tx in range(tx0, tx1 + 1):
                for ty in range(ty0, ty1 + 1):
                    x0, y0 = tx * EXTENT, ty * EXTENT
                    clipped = shapely.clip_by_rect(gz, x0 - BUFFER, y0 - BUFFER, x0 + EXTENT + BUFFER, y0 + EXTENT + BUFFER)
                    if clipped.is_empty:
                        continue
                    local = shapely.transform(clipped, lambda c, ox=x0, oy=y0: c - np.array([ox, oy]))
                    rings = polygon_rings(local)
                    if rings:
                        buckets[(tx, ty)].append((fid, props, GEOM_POLYGON, encode_polygons(rings)))
        for (tx, ty), feats in buckets.items():
            tiles[zxy_to_tileid(z, tx, ty)] = gzip.compress(encode_tile({layer: feats}, EXTENT), mtime=0)

    if not tiles:
        raise RuntimeError(f"no tiles produced for layer {layer!r}")

    bounds = shapely.total_bounds([g for _, _, g in features])
    fields: dict[str, str] = {}
    for _, props, _ in features:
        for k, v in props.items():
            if k not in fields and v is not None:
                fields[k] = "String" if isinstance(v, str) else ("Boolean" if isinstance(v, bool) else "Number")

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        writer = Writer(f)
        for tid in sorted(tiles):
            writer.write_tile(tid, tiles[tid])
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_lon_e7": int(bounds[0] * 1e7),
                "min_lat_e7": int(bounds[1] * 1e7),
                "max_lon_e7": int(bounds[2] * 1e7),
                "max_lat_e7": int(bounds[3] * 1e7),
                "center_zoom": minzoom,
                "center_lon_e7": int((bounds[0] + bounds[2]) / 2 * 1e7),
                "center_lat_e7": int((bounds[1] + bounds[3]) / 2 * 1e7),
            },
            {
                "name": name,
                "description": description,
                "attribution": attribution,
                "type": "overlay",
                "format": "pbf",
                "generator": "pa2 pure-python tiler",
                "vector_layers": [
                    {"id": layer, "description": description, "minzoom": minzoom, "maxzoom": maxzoom, "fields": fields}
                ],
            },
        )
    return {"tiles": len(tiles), "bytes": out.stat().st_size}
