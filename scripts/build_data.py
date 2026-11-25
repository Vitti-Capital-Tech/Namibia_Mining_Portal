"""Build the portal's licence and deposit datasets.

Licence sources (pick one):
  * default: Landfolio cadastre extracts published as public domain on the Benguela Current
    Commission GeoNode -- Exclusive Prospecting Licences + Mining Licences (Sept 2020).
  * --licences FILE [FILE ...]: newer licence shapefiles/GeoJSON you downloaded yourself, e.g. the
    monthly "mineral licence shapefiles" from the Ministry's Earth Data Namibia page
    (.zip, .shp, .geojson or .json; any projection with a .prj is reprojected to WGS84).

Also downloads USGS Mineral Resources Data System (MRDS) records for Namibia.

Writes:
  public/data/licences.geojson     simplified licence polygons + cleaned attributes
  public/data/occurrences.geojson  USGS MRDS deposits/occurrences in Namibia

Usage:
  python scripts/build_data.py [--refresh]
  python scripts/build_data.py --licences data-raw/licences_2026_11.zip --snapshot 2026-11-01

Shapefiles need: pip install -r scripts/requirements.txt
"""
from __future__ import annotations

import argparse
import json
import math
import re
import tempfile
import urllib.request
import zipfile
from collections import Counter
from datetime import date as _date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
OUT = ROOT / "public" / "data"

BCC_WFS = (
    "https://geodata.benguelacc.org/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=geonode:{layer}&outputFormat=application/json&srsName=EPSG:4326"
)
BCC_PAGE = "https://geodata.benguelacc.org/layers/geonode:{layer}"
BCC_LAYERS = {  # cache file -> GeoNode layer
    "nam_epl_bcc.geojson": "NAM_CSR_GREE_Explo_Pros_Lice",
    "nam_ml_bcc.geojson": "NAM_CSR_GREE_mining_licence_Sept2020",
}
MRDS_URL = (
    "https://mrdata.usgs.gov/services/wfs/mrds?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=mrds&BBOX=11.5,-29.0,25.3,-16.9"
)

# Landfolio commodity group codes -> readable names
GROUPS = {
    "BRM": "Base & Rare Metals",
    "PM": "Precious Metals",
    "PS": "Precious Stones",
    "SPS": "Semi-Precious Stones",
    "IM": "Industrial Minerals",
    "DS": "Dimension Stone",
    "Nf": "Nuclear Fuel",
    "Nnf": "Non-Nuclear Fuel",
}

# USGS MRDS commodity codes -> portal mineral names
MRDS_CODES = {
    "AU": "Gold", "AG": "Silver", "CU": "Copper", "ZN": "Zinc", "PB": "Lead",
    "U": "Uranium", "LI": "Lithium", "SN": "Tin", "TA": "Tantalum", "REE": "Rare Earths",
    "MN": "Manganese", "GRF": "Graphite", "GEM_D": "Diamonds", "V": "Vanadium",
    "W": "Tungsten", "F": "Fluorspar", "FE": "Iron", "NI": "Nickel", "CO": "Cobalt",
    "PGE": "PGM", "PGE_PT": "PGM", "PGE_PD": "PGM", "GE": "Germanium", "BE": "Beryllium",
}

TOLERANCE = 0.002  # degrees (~200 m) for polygon simplification
DECIMALS = 4       # ~11 m


def fetch(url: str, dest: Path, refresh: bool) -> Path:
    if dest.exists() and not refresh:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {dest.name} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "namibia-mining-portal-build/0.1"})
    with urllib.request.urlopen(req, timeout=180) as r:
        dest.write_bytes(r.read())
    return dest


# ---------- geometry helpers ----------
def _perp(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return ((x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2) ** 0.5


def simplify(points, tol):
    """Ramer-Douglas-Peucker (iterative)."""
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        s, e = stack.pop()
        dmax, idx = 0.0, None
        for i in range(s + 1, e):
            d = _perp(points[i], points[s], points[e])
            if d > dmax:
                dmax, idx = d, i
        if idx is not None and dmax > tol:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(points, keep) if k]


def clean_ring(ring):
    pts = [[round(p[0], DECIMALS), round(p[1], DECIMALS)] for p in ring]  # drops any Z value
    if not pts:
        return None
    dedup = [pts[0]] + [p for i, p in enumerate(pts[1:], 1) if p != pts[i - 1]]
    if dedup[0] != dedup[-1]:
        dedup.append(dedup[0])
    out = simplify(dedup, TOLERANCE)
    if len(out) < 4:  # small licence collapsed by simplification: keep full detail
        out = dedup
    return out if len(out) >= 4 else None


def ring_area_centroid(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    a /= 2
    if a == 0:
        xs, ys = zip(*ring)
        return 0.0, [sum(xs) / len(xs), sum(ys) / len(ys)]
    return abs(a), [cx / (6 * a), cy / (6 * a)]


def area_km2(polys):
    """Planar area of a MultiPolygon in km² using a local equirectangular scale."""
    total = 0.0
    for rings in polys:
        for k, ring in enumerate(rings):
            lat0 = math.radians(sum(y for _, y in ring) / len(ring))
            kx, ky = 111.32 * math.cos(lat0), 110.57
            a = abs(sum((x1 * y2 - x2 * y1) for (x1, y1), (x2, y2) in zip(ring, ring[1:]))) / 2 * kx * ky
            total += a if k == 0 else -a
    return round(total, 1)


def date(v):
    if not v:
        return None
    if isinstance(v, (datetime, _date)):
        return v.isoformat()[:10]
    v = str(v).strip()
    m = re.match(r"(\d{4})-?(\d{2})-?(\d{2})", v)          # 2020-09-03..., 20200903
    if m:
        return f"{m[1]}-{m[2]}-{m[3]}"
    m = re.match(r"(\d{1,2})[/.](\d{1,2})[/.](\d{4})", v)   # 03/09/2020 (day first)
    return f"{m[3]}-{int(m[2]):02d}-{int(m[1]):02d}" if m else None


# ---------- reading licence sources ----------
def read_geojson(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    return [(f.get("properties") or {}, f.get("geometry")) for f in data.get("features", [])]


def read_shapefile(shp: Path):
    import shapefile  # pyshp
    from pyproj import CRS, Transformer

    transform = None
    prj = shp.with_suffix(".prj")
    if prj.exists():
        crs = CRS.from_wkt(prj.read_text(encoding="utf-8", errors="ignore"))
        if not crs.equals(CRS.from_epsg(4326), ignore_axis_order=True):
            print(f"  reprojecting from {crs.name}")
            transform = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    else:
        print(f"  warning: {shp.name} has no .prj; assuming WGS84 lon/lat")

    out = []
    with shapefile.Reader(str(shp), encoding="utf-8", encodingErrors="replace") as r:
        for sr in r.iterShapeRecords():
            geom = sr.shape.__geo_interface__ if sr.shape.shapeType != shapefile.NULL else None
            if geom and transform:
                geom = reproject(geom, transform)
            out.append((sr.record.as_dict(), geom))
    return out


def reproject(geom, transform):
    def ring(r):
        xs, ys = transform([p[0] for p in r], [p[1] for p in r])
        return [[x, y] for x, y in zip(xs, ys)]
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [ring(r) for r in geom["coordinates"]]}
    if geom["type"] == "MultiPolygon":
        return {"type": "MultiPolygon", "coordinates": [[ring(r) for r in poly] for poly in geom["coordinates"]]}
    return geom


def read_source(path: Path):
    """Return [(properties, geometry)] from a .zip / .shp / .geojson / .json licence file."""
    suffix = path.suffix.lower()
    if suffix in (".geojson", ".json"):
        return read_geojson(path)
    if suffix == ".shp":
        return read_shapefile(path)
    if suffix == ".zip":
        rows = []
        with tempfile.TemporaryDirectory() as tmp:
            with zipfile.ZipFile(path) as z:
                z.extractall(tmp)
            for inner in sorted(Path(tmp).rglob("*")):
                if inner.suffix.lower() in (".shp", ".geojson", ".json"):
                    print(f"  reading {inner.name}")
                    rows += read_source(inner)
        return rows
    raise SystemExit(f"Unsupported licence file: {path}")


# ---------- attribute normalisation ----------
# Landfolio exports differ slightly between portals/years (and shapefiles truncate names to 10 chars),
# so each field lists the names we accept, case-insensitively.
FIELDS = {
    "name":        ["name", "licence", "license", "licenceno", "licenseno", "licno", "lic_no"],
    "code":        ["code", "number", "licnumber"],
    "typeCode":    ["typecode", "type_code", "lictype", "typecd"],
    "type":        ["type", "licencetyp", "licensetyp", "licencetype", "licensetype"],
    "status":      ["status", "licstatus"],
    "statusGroup": ["statusgrp", "statusgroup", "status_grp", "statusgrou"],
    "holder":      ["parties_ne", "parties", "partiesnam", "holder", "holders", "owner", "company", "applicant"],
    "applied":     ["dteapplied", "applied", "dateapplied", "date_appl"],
    "granted":     ["dtegranted", "granted", "dategranted", "date_grant"],
    "expires":     ["dteexpires", "expires", "dateexpire", "expirydate", "expiry", "date_expir"],
    "groupCodes":  ["commodit_1", "commodityc", "commoditycodes", "commodcode", "commcodes"],
    "groupNames":  ["commoditie", "commodities", "commodity"],
    "mapRef":      ["mapref", "map_ref", "location"],
}
GROUP_BY_NAME = {
    "base and rare metals": "BRM", "precious metals": "PM", "precious stones": "PS",
    "semi-precious stones": "SPS", "industrial minerals": "IM", "dimension stone": "DS",
    "nuclear fuel minerals": "Nf", "nuclear fuel": "Nf", "non-nuclear fuel minerals": "Nnf",
    "non-nuclear fuel": "Nnf",
}
TYPE_BY_CODE = {
    "EPL": "Exclusive Prospecting Licence", "ML": "Mining Licence", "MC": "Mining Claim",
    "ERL": "Exclusive Reconnaissance Licence", "MDRL": "Mineral Deposit Retention Licence",
    "NEPL": "Non-Exclusive Prospecting Licence",
}
ACTIVE_WORDS = ("active", "pending renewal", "renewal", "transfer pending", "commodity change",
                "size increase", "intention to refuse")
INACTIVE_WORDS = ("expired", "rejected", "refused", "withdrawn", "relinquish", "abandon", "cancel",
                  "lapsed", "revoked", "terminated")


def pick(props, key):
    lower = {k.lower(): v for k, v in props.items()}
    for name in FIELDS[key]:
        v = lower.get(name)
        if v not in (None, ""):
            return v
    return None


def status_group(status, given):
    if given in ("Active", "Application", "Inactive"):
        return given
    s = (status or "").lower()
    if any(w in s for w in INACTIVE_WORDS):
        return "Inactive"
    if "application" in s:
        return "Application"
    if any(w in s for w in ACTIVE_WORDS):
        return "Active"
    return "Inactive"


def normalise(props):
    type_code = str(pick(props, "typeCode") or "").strip().upper()
    name = str(pick(props, "name") or "").strip()
    number = str(pick(props, "code") or "").strip()
    if not re.match(r"^[A-Za-z]+-\s*\d", name):  # expect "EPL-1234"
        m = re.match(r"^([A-Za-z]+)\s*[-/ ]?\s*(\d.*)$", name or number)
        if m:
            name = f"{m[1].upper()}-{m[2]}"
        elif number and type_code:
            name = f"{type_code}-{number}"
    if not type_code and "-" in name:
        type_code = name.split("-")[0].upper()
    group_codes = [c.strip() for c in str(pick(props, "groupCodes") or "").split(",") if c.strip()]
    if not group_codes:
        # e.g. "Base and Rare Metals (applied for), Precious Metals"
        names = [re.sub(r"\(.*?\)", "", n).strip().lower()
                 for n in re.split(r"[,;]", str(pick(props, "groupNames") or "")) if n.strip()]
        group_codes = [GROUP_BY_NAME[n] for n in names if n in GROUP_BY_NAME]
    status = str(pick(props, "status") or "").strip() or None
    return {
        "code": name or None,
        "typeCode": type_code or None,
        "type": pick(props, "type") or TYPE_BY_CODE.get(type_code, type_code or None),
        "status": status,
        "statusGroup": status_group(status, pick(props, "statusGroup")),
        "holder": str(pick(props, "holder") or "").strip() or None,
        "applied": date(pick(props, "applied")),
        "granted": date(pick(props, "granted")),
        "expires": date(pick(props, "expires")),
        "groups": group_codes,
        "mapRef": [t.strip() for t in re.split(r"[;,]", str(pick(props, "mapRef") or ""))
                   if t.strip() and t.strip() != "Namibia"],
    }


# ---------- builders ----------
def build_licences(rows, sources, snapshot=None):
    features, dropped, seen = [], 0, {}
    for props, g in rows:
        if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
            dropped += 1
            continue
        attrs = normalise(props)
        if not attrs["code"]:
            dropped += 1
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        new_polys, best = [], (0.0, None)
        for poly in polys:
            rings = [r for r in (clean_ring(r) for r in poly) if r]
            if not rings:
                continue
            new_polys.append(rings)
            area, c = ring_area_centroid(rings[0])
            if area > best[0] or best[1] is None:
                best = (area, c)
        if not new_polys:
            dropped += 1
            continue
        # Stable id = licence code (keeps shortlists valid across refreshes); suffix duplicates.
        n = seen.get(attrs["code"], 0) + 1
        seen[attrs["code"]] = n
        features.append({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": new_polys},
            "properties": {
                "id": attrs["code"] if n == 1 else f"{attrs['code']}~{n}",
                **attrs,
                "areaKm2": area_km2(new_polys),
                "c": [round(best[1][0], DECIMALS), round(best[1][1], DECIMALS)],
            },
        })
    if not snapshot:
        # The newest application date is the best proxy for when an extract was taken
        # (granted dates can be future-dated renewals).
        snapshot = max((f["properties"]["applied"] or "" for f in features), default="") or None
    return {
        "type": "FeatureCollection",
        "metadata": {
            "sources": sources,
            "source": "; ".join(s["name"] for s in sources),
            "sourceUrl": sources[0].get("url"),
            "snapshot": snapshot,
            "groups": GROUPS,
            "note": "Status as at the snapshot date; verify current status in the Ministry's mining cadastre.",
        },
        "features": features,
    }, dropped


def build_occurrences(raw_path: Path):
    text = raw_path.read_text(encoding="utf-8")
    feats = []
    for rec in re.findall(r"<ms:mrds .*?</ms:mrds>", text, re.S):
        get = lambda k: ((m := re.search(rf"<ms:{k}>(.*?)</ms:{k}>", rec, re.S)) and m.group(1).strip()) or ""
        if get("fips_code") != "fWA":  # Namibia only
            continue
        coords = re.search(r"<gml:Point.*?<gml:coordinates>([-\d.]+),([-\d.]+)</gml:coordinates>", rec, re.S)
        if not coords:
            continue
        codes = get("code_list").split()
        minerals = sorted({MRDS_CODES[c] for c in codes if c in MRDS_CODES})
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(float(coords.group(1)), 4), round(float(coords.group(2)), 4)]},
            "properties": {
                "id": "mrds-" + get("dep_id"),
                "name": get("site_name"),
                "devStatus": get("dev_stat"),
                "commodities": minerals,
                "codes": codes,
                "url": get("url"),
            },
        })
    return {
        "type": "FeatureCollection",
        "metadata": {
            "source": "USGS Mineral Resources Data System (MRDS), public domain",
            "sourceUrl": "https://mrdata.usgs.gov/mrds/",
            "note": "MRDS is no longer actively updated; development status may be outdated.",
        },
        "features": feats,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download cached public datasets")
    ap.add_argument("--licences", nargs="+", type=Path, metavar="FILE",
                    help="licence shapefile(s)/GeoJSON to use instead of the 2020 BCC extracts")
    ap.add_argument("--out", type=Path, default=OUT, help="output directory (default public/data)")
    ap.add_argument("--snapshot", help="data date (YYYY-MM-DD) of the licence files; "
                                       "default = latest applied/granted date in the data")
    args = ap.parse_args()

    rows, sources = [], []
    if args.licences:
        for path in args.licences:
            print(f"Reading {path} ...")
            rows += read_source(path)
            sources.append({"name": f"Licence file {path.name}", "url": None})
    else:
        for cache, layer in BCC_LAYERS.items():
            path = fetch(BCC_WFS.format(layer=layer), RAW / cache, args.refresh)
            rows += read_geojson(path)
            sources.append({
                "name": f"MME Landfolio extract via Benguela Current Commission GeoNode ({layer}, public domain)",
                "url": BCC_PAGE.format(layer=layer),
            })
    mrds_raw = fetch(MRDS_URL, RAW / "mrds_namibia_bbox.gml", args.refresh)

    licences, dropped = build_licences(rows, sources, args.snapshot)
    occ = build_occurrences(mrds_raw)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, data in [("licences.geojson", licences), ("occurrences.geojson", occ)]:
        path = args.out / name
        path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"{name}: {len(data['features'])} features, {path.stat().st_size / 1e6:.2f} MB")
    props = [f["properties"] for f in licences["features"]]
    print("  by type:  ", dict(Counter(p["typeCode"] for p in props)))
    print("  by status:", dict(Counter(p["statusGroup"] for p in props)))
    print(f"  dropped (no/invalid geometry or number): {dropped}; snapshot: {licences['metadata']['snapshot']}")


if __name__ == "__main__":
    main()
