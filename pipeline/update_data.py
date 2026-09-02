#!/usr/bin/env python3
"""Build an atomic, chart-ready housing-data release.

Raw provider files live only in a temporary directory. A release is promoted by
updating public/data/latest.json only after every required source and validation
check passes. If the command fails, the previously deployed release is intact.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import tempfile
import unicodedata
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import shapefile


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "sources.json"
PUBLIC_DATA = ROOT / "public" / "data"
MAX_SOURCE_BYTES = 300 * 1024 * 1024
MAX_PUBLISHED_BYTES = 50 * 1024 * 1024
USER_AGENT = "HousingMarketLab/1.0 (academic visualization; desenlin.com)"

PLACE_URL = (
    "https://www2.census.gov/geo/tiger/GENZ2025/shp/"
    "cb_2025_06_place_500k.zip"
)
ZCTA_URL = (
    "https://www2.census.gov/geo/tiger/GENZ2020/shp/"
    "cb_2020_us_zcta520_500k.zip"
)

# Census place files are statewide and do not carry a single county field.
# These broad extents disambiguate same-named places before exact Zillow-name
# matching; they include each county's offshore islands and border communities.
COUNTY_EXTENTS = {
    "Orange County": (-118.25, 33.15, -117.30, 34.10),
    "Los Angeles County": (-119.10, 32.65, -117.50, 34.95),
}

METRIC_META = {
    "zhvi": {
        "label": "Typical home value",
        "short_label": "Home value",
        "unit": "usd",
        "decimals": 0,
        "definition": "Zillow Home Value Index for the typical mid-tier home.",
    },
    "zori": {
        "label": "Typical observed rent",
        "short_label": "Rent",
        "unit": "usd_month",
        "decimals": 0,
        "definition": "Zillow Observed Rent Index for all homes and multifamily rentals.",
    },
    "inventory": {
        "label": "For-sale inventory",
        "short_label": "Inventory",
        "unit": "homes",
        "decimals": 0,
        "definition": "Unique listings active at any time during the month.",
    },
    "days_pending": {
        "label": "Median days to pending",
        "short_label": "Days to pending",
        "unit": "days",
        "decimals": 1,
        "definition": "Median days from first listing to pending status.",
    },
    "price_cut_share": {
        "label": "Listings with a price cut",
        "short_label": "Price cuts",
        "unit": "share",
        "decimals": 5,
        "definition": "Share of active listings with a price reduction during the month.",
    },
    "sale_to_list": {
        "label": "Mean sale-to-list ratio",
        "short_label": "Sale-to-list",
        "unit": "ratio",
        "decimals": 5,
        "definition": "Mean sale price divided by the final list price.",
    },
}


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def request(url: str) -> urllib.request.Request:
    return urllib.request.Request(url, headers={"User-Agent": USER_AGENT})


def discover_links(data_page: str) -> list[str]:
    with urllib.request.urlopen(request(data_page), timeout=45) as response:
        html = response.read(8 * 1024 * 1024).decode("utf-8", errors="replace")
    return sorted(
        set(
            re.findall(
                r"https://files\.zillowstatic\.com/[^\"'<> ]+?\.csv",
                html,
            )
        )
    )


def stream_download(url: str, destination: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(request(url), timeout=90) as response:
        status = getattr(response, "status", 200)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        with destination.open("wb") as handle:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_SOURCE_BYTES:
                    raise RuntimeError("source exceeded the 300 MB safety limit")
                digest.update(chunk)
                handle.write(chunk)
    if total < 1_000:
        raise RuntimeError("download was unexpectedly small")
    with destination.open("rb") as handle:
        if not handle.readline(512).startswith(b"RegionID,"):
            raise RuntimeError("response was not a Zillow CSV")
    return total, digest.hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def download_source(
    source: dict[str, Any], temp_dir: Path, discovered: list[str]
) -> tuple[Path, dict[str, Any]]:
    pattern = re.compile(source["filename_regex"], re.IGNORECASE)
    matching = [url for url in discovered if pattern.search(url.rsplit("/", 1)[-1])]
    candidates = [source["last_url"], *matching]
    unique_candidates = list(dict.fromkeys(candidates))
    errors: list[str] = []
    destination = temp_dir / f"{source['id']}.csv"
    for url in unique_candidates:
        try:
            size, sha = stream_download(url, destination)
            return destination, {"url": url, "bytes": size, "sha256": sha}
        except (OSError, RuntimeError, urllib.error.URLError) as exc:
            errors.append(f"{url}: {exc}")
            destination.unlink(missing_ok=True)
    raise RuntimeError(
        f"Unable to acquire required source {source['id']}: " + " | ".join(errors)
    )


def parse_value(raw: str, decimals: int) -> float | int | None:
    if raw in ("", "NA", "null"):
        return None
    value = round(float(raw), decimals)
    return int(value) if decimals == 0 else value


def extract_source(
    path: Path, source: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    metric = source["metric"]
    geography = source["geography"]
    decimals = METRIC_META[metric]["decimals"]
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise RuntimeError(f"{source['id']} had no header")
        dates = [name for name in reader.fieldnames if re.fullmatch(r"\d{4}-\d{2}-\d{2}", name)]
        if len(dates) < 12 or dates != sorted(dates):
            raise RuntimeError(f"{source['id']} had invalid date columns")
        regions = []
        for row in reader:
            if geography in ("city", "zip"):
                if row.get("State") != "CA" or row.get("CountyName") not in config["counties"]:
                    continue
                label = row["RegionName"]
                county = row["CountyName"]
                secondary = row.get("City") if geography == "zip" else None
            else:
                region_name = row.get("RegionName", "")
                metro = next(
                    (item for item in config["metros"] if item["match"] in region_name),
                    None,
                )
                if metro is None:
                    continue
                label = metro["label"]
                county = None
                secondary = region_name
            values = [parse_value(row.get(date, ""), decimals) for date in dates]
            if not any(value is not None for value in values):
                continue
            regions.append(
                {
                    "id": str(row["RegionID"]),
                    "name": label,
                    "county": county,
                    "context": secondary,
                    "values": values,
                }
            )
    if not regions:
        raise RuntimeError(f"{source['id']} produced no target regions")
    return {
        "metric": metric,
        "geography": geography,
        "dates": dates,
        "regions": regions,
        "latest_date": max(
            dates[index]
            for region in regions
            for index, value in enumerate(region["values"])
            if value is not None
        ),
    }


def combine_geography(
    geography: str, extracted: list[dict[str, Any]]
) -> dict[str, Any]:
    selected = [item for item in extracted if item["geography"] == geography]
    metrics = {
        item["metric"]: {"dates": item["dates"], **METRIC_META[item["metric"]]}
        for item in selected
    }
    region_map: dict[str, dict[str, Any]] = {}
    for item in selected:
        for region in item["regions"]:
            target = region_map.setdefault(
                region["id"],
                {
                    "id": region["id"],
                    "name": region["name"],
                    "county": region["county"],
                    "context": region["context"],
                    "series": {},
                },
            )
            target["series"][item["metric"]] = region["values"]
    regions = sorted(
        region_map.values(),
        key=lambda item: ((item.get("county") or ""), item["name"]),
    )
    return {"geography": geography, "metrics": metrics, "regions": regions}


def validate_payloads(payloads: dict[str, dict[str, Any]]) -> None:
    thresholds = {"city": 140, "zip": 340, "metro": 5}
    for geography, minimum in thresholds.items():
        count = len(payloads[geography]["regions"])
        if count < minimum:
            raise RuntimeError(
                f"{geography} coverage collapsed: {count} regions; expected at least {minimum}"
            )
    rent_counts = {
        geography: sum("zori" in region["series"] for region in payloads[geography]["regions"])
        for geography in ("city", "zip")
    }
    if rent_counts["city"] < 110 or rent_counts["zip"] < 300:
        raise RuntimeError(f"rent coverage collapsed: {rent_counts}")


def download_zip(url: str, destination: Path) -> None:
    with urllib.request.urlopen(request(url), timeout=90) as response:
        total = 0
        with destination.open("wb") as handle:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_SOURCE_BYTES:
                    raise RuntimeError("boundary file exceeded safety limit")
                handle.write(chunk)


def shape_records(zip_url: str, temp_dir: Path) -> tuple[list[str], list[tuple[dict[str, Any], Any]]]:
    archive = temp_dir / Path(zip_url).name
    folder = temp_dir / archive.stem
    download_zip(zip_url, archive)
    with zipfile.ZipFile(archive) as zipped:
        zipped.extractall(folder)
    shp_path = next(folder.glob("*.shp"))
    reader = shapefile.Reader(str(shp_path))
    fields = [field[0] for field in reader.fields[1:]]
    return fields, [
        (dict(zip(fields, record.record)), record.shape)
        for record in reader.iterShapeRecords()
    ]


def rounded_coordinates(value: Any) -> Any:
    """Keep browser map payloads compact without changing visible boundaries."""
    if isinstance(value, (list, tuple)):
        if value and isinstance(value[0], (int, float)):
            return [round(float(coordinate), 5) for coordinate in value]
        return [rounded_coordinates(item) for item in value]
    return value


def geojson_regions(items: list[tuple[str, str, Any]]) -> list[dict[str, Any]]:
    output = []
    for region_id, name, shape in items:
        geometry = shape.__geo_interface__
        output.append(
            {
                "id": region_id,
                "name": name,
                "geometry": {
                    "type": geometry["type"],
                    "coordinates": rounded_coordinates(geometry["coordinates"]),
                },
            }
        )
    return output


def geographic_bounds(items: list[tuple[str, str, Any]]) -> list[list[float]]:
    points = [point for _, _, shape in items for point in shape.points]
    if not points:
        return [[32.5, -125.0], [42.0, -114.0]]
    return [
        [round(min(point[1] for point in points), 5), round(min(point[0] for point in points), 5)],
        [round(max(point[1] for point in points), 5), round(max(point[0] for point in points), 5)],
    ]


def shape_center_is_in_county(shape: Any, county: str) -> bool:
    min_lon, min_lat, max_lon, max_lat = COUNTY_EXTENTS[county]
    shape_min_lon, shape_min_lat, shape_max_lon, shape_max_lat = shape.bbox
    center_lon = (shape_min_lon + shape_max_lon) / 2
    center_lat = (shape_min_lat + shape_max_lat) / 2
    return min_lon <= center_lon <= max_lon and min_lat <= center_lat <= max_lat


def normalized_geography_name(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(character)
    ).casefold()


def build_maps(
    payloads: dict[str, dict[str, Any]], config: dict[str, Any], temp_dir: Path
) -> dict[str, dict[str, Any]]:
    _, place_records = shape_records(PLACE_URL, temp_dir)
    zcta_fields, zcta_records = shape_records(ZCTA_URL, temp_dir)
    zcta_field = next(field for field in zcta_fields if field.startswith("ZCTA5CE"))

    results: dict[str, dict[str, Any]] = {}
    for geography in ("city", "zip"):
        region_by_county = defaultdict(dict)
        for region in payloads[geography]["regions"]:
            region_by_county[region["county"]][
                normalized_geography_name(region["name"])
            ] = (region["id"], region["name"])
        county_maps: dict[str, Any] = {}
        for county in config["counties"]:
            targets = region_by_county[county]
            selected: list[tuple[str, str, Any]] = []
            records = place_records if geography == "city" else zcta_records
            for attrs, shape in records:
                name = attrs.get("NAME") if geography == "city" else attrs.get(zcta_field)
                target = targets.get(normalized_geography_name(name))
                if target and (
                    geography == "zip" or shape_center_is_in_county(shape, county)
                ):
                    selected.append((target[0], target[1], shape))
            county_maps[county] = {
                "bounds": geographic_bounds(selected),
                "regions": geojson_regions(selected),
                "mapped": len(selected),
                "available": len(targets),
            }
        results[geography] = {"geography": geography, "counties": county_maps}
    return results


def compact_json(data: Any) -> bytes:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def existing_bundle_sha() -> str | None:
    latest_path = PUBLIC_DATA / "latest.json"
    if not latest_path.exists():
        return None
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    manifest_path = PUBLIC_DATA / "releases" / latest["release"] / "manifest.json"
    if not manifest_path.exists():
        return None
    return json.loads(manifest_path.read_text(encoding="utf-8")).get("bundle_sha256")


def published_size() -> int:
    return sum(path.stat().st_size for path in PUBLIC_DATA.rglob("*") if path.is_file())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-maps", action="store_true")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        help="Optional local download cache for development; CI always fetches fresh files.",
    )
    args = parser.parse_args()
    config = load_config()
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0)

    with tempfile.TemporaryDirectory(prefix="housing-market-lab-") as temp_name:
        temp_dir = Path(temp_name)
        discovered = discover_links(config["data_page"])
        extracted = []
        source_manifest = {}
        for source in config["sources"]:
            cached_path = args.cache_dir / f"{source['id']}.csv" if args.cache_dir else None
            if cached_path and cached_path.exists():
                path = cached_path
                source_info = {
                    "url": source["last_url"],
                    "bytes": path.stat().st_size,
                    "sha256": file_sha256(path),
                }
            else:
                path, source_info = download_source(source, temp_dir, discovered)
                if cached_path:
                    cached_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, cached_path)
            result = extract_source(path, source, config)
            extracted.append(result)
            source_manifest[source["id"]] = {
                **source_info,
                "metric": source["metric"],
                "geography": source["geography"],
                "latest_observation": result["latest_date"],
                "regions": len(result["regions"]),
            }

        payloads = {
            geography: combine_geography(geography, extracted)
            for geography in ("city", "zip", "metro")
        }
        validate_payloads(payloads)
        maps = {} if args.skip_maps else build_maps(payloads, config, temp_dir)

        bundle_files: dict[str, bytes] = {
            "city.json": compact_json(payloads["city"]),
            "zip.json": compact_json(payloads["zip"]),
            "metro.json": compact_json(payloads["metro"]),
        }
        if maps:
            bundle_files["map-city.json"] = compact_json(maps["city"])
            bundle_files["map-zip.json"] = compact_json(maps["zip"])
        bundle_sha = hashlib.sha256(
            b"".join(bundle_files[name] for name in sorted(bundle_files))
        ).hexdigest()
        if existing_bundle_sha() == bundle_sha:
            print("No provider revisions or new observations; current release retained.")
            return

        release_id = fetched_at.date().isoformat()
        release_dir = PUBLIC_DATA / "releases" / release_id
        if release_dir.exists():
            suffix = 2
            while (PUBLIC_DATA / "releases" / f"{release_id}-r{suffix}").exists():
                suffix += 1
            release_id = f"{release_id}-r{suffix}"
            release_dir = PUBLIC_DATA / "releases" / release_id

        latest_by_metric = {
            item["id"]: source_manifest[item["id"]]["latest_observation"]
            for item in config["sources"]
        }
        manifest = {
            "release": release_id,
            "created_at": fetched_at.isoformat().replace("+00:00", "Z"),
            "data_page": config["data_page"],
            "provider": "Zillow Research",
            "attribution": "Data provided by Zillow Group",
            "bundle_sha256": bundle_sha,
            "latest_observations": latest_by_metric,
            "counts": {
                geography: len(payloads[geography]["regions"])
                for geography in payloads
            },
            "map_coverage": {
                geography: {
                    county: {
                        "mapped": details["mapped"],
                        "available": details["available"],
                    }
                    for county, details in maps.get(geography, {}).get("counties", {}).items()
                }
                for geography in maps
            },
            "sources": source_manifest,
        }
        for filename, content in bundle_files.items():
            write_bytes(release_dir / filename, content)
        write_bytes(release_dir / "manifest.json", compact_json(manifest))
        write_bytes(
            PUBLIC_DATA / "latest.json",
            compact_json(
                {
                    "release": release_id,
                    "manifest": f"releases/{release_id}/manifest.json",
                }
            ),
        )
        if published_size() > MAX_PUBLISHED_BYTES:
            shutil.rmtree(release_dir, ignore_errors=True)
            raise RuntimeError("published data exceeded the 50 MB cost guardrail")
        print(
            f"Published release {release_id}: "
            f"{len(payloads['city']['regions'])} city/community regions, "
            f"{len(payloads['zip']['regions'])} ZIP regions."
        )


if __name__ == "__main__":
    main()
