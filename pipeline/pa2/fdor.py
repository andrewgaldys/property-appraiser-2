"""Readers for FDOR tax-roll CSVs (NAL, SDF) and parcel polygon files, plus the join.

Requires pandas + geopandas + pyogrio (see requirements.txt). Column names are
matched case-insensitively and only the columns below are loaded, which keeps the
Palm Beach NAL (~650k rows) comfortably in memory.
"""

from __future__ import annotations

import io
import logging
import zipfile
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import IO

import pandas as pd

from .util import norm_parcel_id, to_int

log = logging.getLogger("pa2")

NAL_FIELDS = [
    "CO_NO", "PARCEL_ID", "ASMNT_YR", "DOR_UC", "JV", "LND_VAL", "LND_SQFOOT", "TOT_LVG_AREA", "NO_BULDNG",
    "NO_RES_UNTS", "ACT_YR_BLT", "EFF_YR_BLT",
    "QUAL_CD1", "SALE_PRC1", "SALE_YR1", "SALE_MO1", "QUAL_CD2", "SALE_PRC2", "SALE_YR2", "SALE_MO2",
    "OWN_NAME", "OWN_ADDR1", "OWN_ADDR2", "OWN_CITY", "OWN_STATE", "OWN_ZIPCD", "S_LEGAL",
    "PHY_ADDR1", "PHY_ADDR2", "PHY_CITY", "PHY_ZIPCD",
]
NAL_REQUIRED = {"CO_NO", "PARCEL_ID", "DOR_UC", "JV", "LND_VAL", "OWN_NAME"}
SDF_FIELDS = ["CO_NO", "PARCEL_ID", "QUAL_CD", "SALE_YR", "SALE_MO", "SALE_PRC"]
SDF_REQUIRED = {"PARCEL_ID", "SALE_YR", "SALE_PRC"}

GEOM_ID_CANDIDATES = ["PARCEL_ID", "PARCELID", "PARCELNO", "PARCEL_NO", "PARCEL", "PIN", "PCN", "PARID",
                      "PAR_ID", "STRAP", "FOLIO"]
GEOM_COUNTY_CANDIDATES = ["CO_NO", "CNTYCD", "COUNTY_CD", "COUNTY_CODE", "CO_NUM"]

# NAD83 / Florida East (ftUS): covers Martin, St. Lucie and Palm Beach. Used to
# derive lot area when LND_SQFOOT is missing.
FL_EAST_FTUS = "EPSG:2236"


def _canon(col: str) -> str:
    return col.strip().strip('"').strip().upper()


@contextmanager
def _open_table(path: Path) -> Iterator[IO[bytes]]:
    """Binary handle on a CSV, or on the (largest) CSV inside a .zip as FDOR ships them."""
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            members = [
                m for m in zf.namelist()
                if m.lower().endswith((".csv", ".txt")) and not m.startswith("__MACOSX")
            ]
            if not members:
                raise ValueError(f"{path.name}: no CSV file inside the zip")
            member = max(members, key=lambda m: zf.getinfo(m).file_size)
            with zf.open(member) as fh:
                yield fh
    else:
        with open(path, "rb") as fh:
            yield fh


def _header(path: Path) -> list[str]:
    with _open_table(path) as fh:
        first = io.TextIOWrapper(fh, encoding="latin-1", newline="").readline()
    return [_canon(h) for h in first.split(",")]


def _read_csv(path: Path, wanted: Sequence[str]) -> pd.DataFrame:
    wanted_set = set(wanted)
    with _open_table(path) as fh:
        df = pd.read_csv(
            fh,
            dtype=str,
            usecols=lambda c: _canon(c) in wanted_set,
            encoding="latin-1",
            keep_default_na=False,
            low_memory=False,
        )
    df.columns = [_canon(c) for c in df.columns]
    for c in wanted:
        if c not in df.columns:
            df[c] = ""
    return df


def _filter_counties(df: pd.DataFrame, counties: Iterable[int]) -> pd.DataFrame:
    df["CO_NO"] = pd.to_numeric(df["CO_NO"], errors="coerce").astype("Int64")
    return df[df["CO_NO"].isin(list(counties))].copy()


def read_nal(paths: Sequence[Path], counties: Iterable[int]) -> pd.DataFrame:
    frames = []
    for p in paths:
        missing = NAL_REQUIRED - set(_header(p))
        if missing:
            raise ValueError(f"{p.name}: not a NAL file (missing {sorted(missing)})")
        df = _filter_counties(_read_csv(p, NAL_FIELDS), counties)
        log.info("NAL %s: %s rows", p.name, f"{len(df):,}")
        frames.append(df)
    nal = pd.concat(frames, ignore_index=True)
    nal["pid"] = nal["PARCEL_ID"].map(norm_parcel_id)
    nal = nal[nal["pid"] != ""]
    return nal.drop_duplicates(["CO_NO", "pid"], keep="last").reset_index(drop=True)


def read_sdf(paths: Sequence[Path], counties: Iterable[int]) -> pd.DataFrame | None:
    frames = []
    for p in paths:
        missing = SDF_REQUIRED - set(_header(p))
        if missing:
            raise ValueError(f"{p.name}: not an SDF file (missing {sorted(missing)})")
        df = _filter_counties(_read_csv(p, SDF_FIELDS), counties)
        log.info("SDF %s: %s sales", p.name, f"{len(df):,}")
        frames.append(df)
    if not frames:
        return None
    sdf = pd.concat(frames, ignore_index=True)
    sdf["pid"] = sdf["PARCEL_ID"].map(norm_parcel_id)
    return sdf


def latest_sales(nal: pd.DataFrame, sdf: pd.DataFrame | None, min_price: int) -> pd.DataFrame:
    """Most recent sale (price >= min_price) per parcel across NAL SALE_*1/2 and SDF."""
    cols = ["CO_NO", "pid", "qual", "year", "month", "price"]
    parts = []
    for n in ("1", "2"):
        part = nal[["CO_NO", "pid", f"QUAL_CD{n}", f"SALE_YR{n}", f"SALE_MO{n}", f"SALE_PRC{n}"]].copy()
        part.columns = cols
        parts.append(part)
    if sdf is not None and len(sdf):
        part = sdf[["CO_NO", "pid", "QUAL_CD", "SALE_YR", "SALE_MO", "SALE_PRC"]].copy()
        part.columns = cols
        parts.append(part)
    s = pd.concat(parts, ignore_index=True)
    s["year"] = pd.to_numeric(s["year"], errors="coerce")
    s["month"] = pd.to_numeric(s["month"], errors="coerce").fillna(0)
    s["price"] = pd.to_numeric(s["price"].astype(str).str.replace(r"[$,]", "", regex=True), errors="coerce")
    s = s[(s["year"] >= 1900) & (s["price"] >= min_price)]
    s = s.sort_values(["CO_NO", "pid", "year", "month", "price"]).drop_duplicates(["CO_NO", "pid"], keep="last")
    return s.rename(columns={"qual": "last_sale_qual_cd", "year": "last_sale_year", "month": "last_sale_month",
                             "price": "last_sale_price"})


def _pick_layer(path: Path, layer: str | None) -> str | None:
    import pyogrio

    if layer:
        return layer
    layers = pyogrio.list_layers(path)
    if len(layers) <= 1:
        return None
    polys = [name for name, gtype in layers if gtype and "POLYGON" in str(gtype).upper()]
    parcelish = [name for name in polys if "PARCEL" in name.upper()]
    chosen = (parcelish or polys or [layers[0][0]])[0]
    log.info("%s: using layer %r (of %d)", path.name, chosen, len(layers))
    return chosen


def _polygonal(geom):
    if geom is None or geom.is_empty:
        return None
    gt = geom.geom_type
    if gt in ("Polygon", "MultiPolygon"):
        return geom
    if gt == "GeometryCollection":
        import shapely

        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        return shapely.union_all(polys) if polys else None
    return None


def read_parcel_polygons(
    paths: Sequence[Path],
    counties: Iterable[int],
    *,
    id_field: str | None = None,
    layer: str | None = None,
    assume_crs: str | None = None,
):
    """Read parcel polygons from shapefile / GeoPackage / FileGDB / GeoJSON (zip ok)."""
    import geopandas as gpd
    import pyogrio
    import shapely

    counties = list(counties)
    frames = []
    for p in paths:
        lyr = _pick_layer(p, layer)
        info = pyogrio.read_info(p, layer=lyr)
        fields = [str(f) for f in info["fields"]]
        dtypes = dict(zip(fields, [str(d) for d in info["dtypes"]]))
        upper = {f.upper(): f for f in fields}
        idf = upper.get(id_field.upper()) if id_field else next((upper[c] for c in GEOM_ID_CANDIDATES if c in upper), None)
        if not idf:
            raise ValueError(f"{p.name}: no parcel-id field found in {fields}; pass --geom-id-field")
        cof = next((upper[c] for c in GEOM_COUNTY_CANDIDATES if c in upper), None)
        where = None
        if cof:
            numeric = dtypes.get(cof, "").startswith(("int", "float"))
            vals = ",".join(str(c) if numeric else f"'{c}'" for c in counties)
            where = f"{cof} IN ({vals})"
        g = gpd.read_file(p, layer=lyr, columns=[idf] + ([cof] if cof else []), where=where, engine="pyogrio")
        if g.crs is None:
            if not assume_crs:
                raise ValueError(f"{p.name}: no CRS; pass --assume-crs (e.g. EPSG:2236)")
            g = g.set_crs(assume_crs)
        g = g.to_crs(4326)
        out = gpd.GeoDataFrame(
            {
                "pid": g[idf].map(norm_parcel_id),
                "CO_NO": pd.to_numeric(g[cof], errors="coerce").astype("Int64") if cof else pd.array([pd.NA] * len(g), dtype="Int64"),
            },
            geometry=g.geometry.values,
            crs=4326,
        )
        log.info("GIS %s: %s polygons (id=%s%s)", p.name, f"{len(out):,}", idf, f", county={cof}" if cof else "")
        frames.append(out)

    g = pd.concat(frames, ignore_index=True)
    g = g[(g["pid"] != "") & g.geometry.notna() & ~g.geometry.is_empty]
    kinds = set(g.geom_type.unique())
    if kinds and not kinds & {"Polygon", "MultiPolygon", "GeometryCollection"}:
        raise ValueError(
            f"parcel file(s) contain {sorted(kinds)} geometries, not polygons. Use the parcel polygon "
            "download (FDOR Map Data -> <year>F PAR), not a point / PIN layer."
        )
    invalid = ~g.geometry.is_valid
    if invalid.any():
        g.loc[invalid, "geometry"] = shapely.make_valid(g.loc[invalid, "geometry"].values)
        log.info("repaired %s invalid geometries", f"{int(invalid.sum()):,}")
    g["geometry"] = [_polygonal(x) for x in g.geometry.values]
    g = g[g.geometry.notna()]
    # Multi-part parcels arrive as several rows: dissolve those only.
    g["co_key"] = g["CO_NO"].fillna(-1)
    dup = g.duplicated(["co_key", "pid"], keep=False)
    if dup.any():
        merged = g[dup].dissolve(by=["co_key", "pid"], as_index=False, aggfunc="first")
        g = pd.concat([g[~dup], merged], ignore_index=True)
        log.info("dissolved %s multi-part parcel rows", f"{int(dup.sum()):,}")
    return g.drop(columns="co_key").reset_index(drop=True)


def join(nal: pd.DataFrame, geoms, sales: pd.DataFrame):
    """NAL (+ latest sale) inner-joined to polygons on (county, normalized parcel id)."""
    nal = nal.merge(sales, on=["CO_NO", "pid"], how="left")
    if geoms["CO_NO"].notna().all():
        merged = geoms.merge(nal, on=["CO_NO", "pid"], how="inner")
    else:
        merged = geoms.drop(columns="CO_NO").merge(nal, on="pid", how="inner")
    for co, grp in nal.groupby("CO_NO"):
        hit = int((merged["CO_NO"] == co).sum())
        log.info("county %s: %s NAL rows, %s with polygons (%.1f%%)", co, f"{len(grp):,}", f"{hit:,}",
                 100 * hit / max(len(grp), 1))
    return merged


def to_records(merged) -> list[dict]:
    """Joined GeoDataFrame -> standardized base-field dicts for pa2.publish."""
    # Lot area fallback from the polygon when LND_SQFOOT is blank/zero.
    area_sqft = merged.geometry.to_crs(FL_EAST_FTUS).area.round().astype("int64").to_numpy()
    records = []
    for i, row in enumerate(merged.itertuples(index=False)):
        lot = to_int(row.LND_SQFOOT)
        month = to_int(row.last_sale_month)
        records.append({
            "parcel_id": row.pid,
            "county_code": int(row.CO_NO),
            "site_address": row.PHY_ADDR1 or row.PHY_ADDR2,
            "site_city": row.PHY_CITY,
            "site_zip": row.PHY_ZIPCD,
            "use_code": row.DOR_UC,
            "just_value": to_int(row.JV),
            "land_value": to_int(row.LND_VAL),
            "tot_lvg_area": to_int(row.TOT_LVG_AREA),
            "lnd_sqfoot": lot if lot else int(area_sqft[i]),
            "no_res_unts": to_int(row.NO_RES_UNTS),
            "no_buldng": to_int(row.NO_BULDNG),
            "act_yr_blt": to_int(row.ACT_YR_BLT),
            "eff_yr_blt": to_int(row.EFF_YR_BLT),
            "owner_name": row.OWN_NAME,
            "owner_addr1": row.OWN_ADDR1,
            "owner_addr2": row.OWN_ADDR2,
            "owner_city": row.OWN_CITY,
            "owner_state": row.OWN_STATE,
            "owner_zip": row.OWN_ZIPCD,
            "last_sale_price": to_int(row.last_sale_price),
            "last_sale_year": to_int(row.last_sale_year),
            "last_sale_month": month if month else None,
            "last_sale_qual_cd": row.last_sale_qual_cd if isinstance(row.last_sale_qual_cd, str) else None,
            "legal_desc": row.S_LEGAL,
            "tax_roll_year": to_int(row.ASMNT_YR),
            "geometry": row.geometry,
        })
    return records
