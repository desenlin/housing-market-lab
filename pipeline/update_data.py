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
import io
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
COUNTY_URL = (
    "https://www2.census.gov/geo/tiger/GENZ2025/shp/"
    "cb_2025_us_county_500k.zip"
)
PLACE_GAZETTEER_URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
    "2025_Gazetteer/2025_gaz_place_06.txt"
)
ZCTA_URL = (
    "https://www2.census.gov/geo/tiger/GENZ2020/shp/"
    "cb_2020_us_zcta520_500k.zip"
)

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
                    "census_region": metro.get("census_region") if geography == "metro" else None,
                    "division": metro.get("division") if geography == "metro" else None,
                    "population_rank": metro.get("population_rank") if geography == "metro" else None,
                    "selection_note": metro.get("selection_note") if geography == "metro" else None,
                    "role": metro.get("role") if geography == "metro" else None,
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
                    **({
                        "census_region": region["census_region"],
                        "division": region["division"],
                        "population_rank": region["population_rank"],
                        "selection_note": region["selection_note"],
                        "role": region["role"],
                    } if geography == "metro" else {}),
                    "series": {},
                },
            )
            values = region["values"]
            if geography == "zip":
                start = next(index for index, value in enumerate(values) if value is not None)
                end = len(values) - next(
                    index for index, value in enumerate(reversed(values)) if value is not None
                )
                target["series"][item["metric"]] = {
                    "o": start,
                    "v": values[start:end],
                }
            else:
                target["series"][item["metric"]] = values
    regions = sorted(
        region_map.values(),
        key=lambda item: ((item.get("county") or ""), item["name"]),
    )
    return {"geography": geography, "metrics": metrics, "regions": regions}


def validate_payloads(payloads: dict[str, dict[str, Any]], config: dict[str, Any]) -> None:
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
    expected_metros = {item["label"] for item in config["metros"]}
    actual_metros = {region["name"] for region in payloads["metro"]["regions"]}
    if actual_metros != expected_metros:
        raise RuntimeError(
            f"metro coverage mismatch: missing {sorted(expected_metros - actual_metros)}; "
            f"unexpected {sorted(actual_metros - expected_metros)}"
        )
    population_ranks = sorted(
        region["population_rank"]
        for region in payloads["metro"]["regions"]
        if region.get("population_rank") is not None
    )
    if population_ranks != list(range(1, 21)):
        raise RuntimeError(
            f"top-20 metro population ranks are incomplete or duplicated: {population_ranks}"
        )
    required_metro_metrics = {
        item["metric"] for item in config["sources"] if item["geography"] == "metro"
    }
    incomplete = {
        region["name"]: sorted(required_metro_metrics - set(region["series"]))
        for region in payloads["metro"]["regions"]
        if required_metro_metrics - set(region["series"])
    }
    if incomplete:
        raise RuntimeError(f"metro metric coverage incomplete: {incomplete}")


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


def place_internal_points(url: str = PLACE_GAZETTEER_URL) -> dict[str, tuple[float, float]]:
    with urllib.request.urlopen(request(url), timeout=45) as response:
        content = response.read(2 * 1024 * 1024).decode("utf-8-sig")
    rows = csv.DictReader(io.StringIO(content), delimiter="|")
    return {
        row["GEOID"]: (float(row["INTPTLONG"]), float(row["INTPTLAT"]))
        for row in rows
        if row.get("GEOID") and row.get("INTPTLONG") and row.get("INTPTLAT")
    }


def rounded_coordinates(value: Any) -> Any:
    """Keep browser map payloads compact without changing visible boundaries."""
    if isinstance(value, (list, tuple)):
        if value and isinstance(value[0], (int, float)):
            return [round(float(coordinate), 5) for coordinate in value]
        return [rounded_coordinates(item) for item in value]
    return value


def geojson_regions(items: list[tuple[str, str, str, Any]]) -> list[dict[str, Any]]:
    output = []
    for region_id, name, county, shape in items:
        geometry = shape.__geo_interface__
        output.append(
            {
                "id": region_id,
                "name": name,
                "county": county,
                "geometry": {
                    "type": geometry["type"],
                    "coordinates": rounded_coordinates(geometry["coordinates"]),
                },
            }
        )
    return output


def geographic_bounds(items: list[tuple[str, str, str, Any]]) -> list[list[float]]:
    points = [point for _, _, _, shape in items for point in shape.points]
    if not points:
        return [[32.5, -125.0], [42.0, -114.0]]
    return [
        [round(min(point[1] for point in points), 5), round(min(point[0] for point in points), 5)],
        [round(max(point[1] for point in points), 5), round(max(point[0] for point in points), 5)],
    ]


def point_in_ring(longitude: float, latitude: float, points: list[Any]) -> bool:
    inside = False
    previous = points[-1]
    for current in points:
        x1, y1 = previous
        x2, y2 = current
        crosses = (y1 > latitude) != (y2 > latitude)
        if crosses:
            intersection = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < intersection:
                inside = not inside
        previous = current
    return inside


def point_in_shape(longitude: float, latitude: float, shape: Any) -> bool:
    """Test an official Census internal point against polygon or multipolygon rings."""
    part_starts = [*shape.parts, len(shape.points)]
    inside = False
    for index in range(len(part_starts) - 1):
        ring = shape.points[part_starts[index] : part_starts[index + 1]]
        if len(ring) >= 3 and point_in_ring(longitude, latitude, ring):
            inside = not inside
    return inside


def place_county(
    internal_point: tuple[float, float],
    place_shape: Any,
    county_shapes: dict[str, Any],
) -> str | None:
    """Assign a place using its internal point, with a coastline-safe fallback."""
    direct = [
        county
        for county, county_shape in county_shapes.items()
        if point_in_shape(*internal_point, county_shape)
    ]
    if len(direct) == 1:
        return direct[0]

    step = max(1, len(place_shape.points) // 50)
    sample = place_shape.points[::step]
    scores = {
        county: sum(point_in_shape(longitude, latitude, county_shape) for longitude, latitude in sample)
        for county, county_shape in county_shapes.items()
    }
    county, score = max(scores.items(), key=lambda item: item[1])
    minimum = max(2, len(sample) // 5)
    return county if score >= minimum else None


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
    _, county_records = shape_records(COUNTY_URL, temp_dir)
    internal_points = place_internal_points()
    zcta_fields, zcta_records = shape_records(ZCTA_URL, temp_dir)
    zcta_field = next(field for field in zcta_fields if field.startswith("ZCTA5CE"))
    county_shapes = {
        attrs["NAMELSAD"]: shape
        for attrs, shape in county_records
        if attrs.get("STATEFP") == "06" and attrs.get("NAMELSAD") in config["counties"]
    }
    if set(county_shapes) != set(config["counties"]):
        raise RuntimeError("Census county boundaries were incomplete")

    places_by_county: dict[str, list[tuple[dict[str, Any], Any]]] = defaultdict(list)
    for attrs, shape in place_records:
        try:
            longitude, latitude = internal_points[attrs["GEOID"]]
        except KeyError:
            continue
        county = place_county((longitude, latitude), shape, county_shapes)
        if county:
            places_by_county[county].append((attrs, shape))

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
            selected: list[tuple[str, str, str, Any]] = []
            matched = 0
            if geography == "city":
                for attrs, shape in places_by_county[county]:
                    census_name = attrs.get("NAME", "")
                    target = targets.get(normalized_geography_name(census_name))
                    selected.append(
                        (
                            f"place:{attrs['GEOID']}",
                            target[1] if target else census_name,
                            county,
                            shape,
                        )
                    )
                    matched += int(target is not None)
            else:
                for attrs, shape in zcta_records:
                    name = attrs.get(zcta_field, "")
                    target = targets.get(normalized_geography_name(name))
                    if target:
                        selected.append((f"zcta:{name}", target[1], county, shape))
                matched = len(selected)
            county_maps[county] = {
                "bounds": geographic_bounds(selected),
                "regions": geojson_regions(selected),
                "mapped": matched,
                "available": len(targets),
                "boundaries": len(selected),
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
        validate_payloads(payloads, config)
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

        release_date = fetched_at.date().isoformat()
        existing_ids = {
            path.name for path in (PUBLIC_DATA / "releases").glob(f"{release_date}*")
        }
        if release_date not in existing_ids:
            release_id = release_date
        else:
            suffixes = [
                int(match.group(1))
                for item in existing_ids
                if (match := re.fullmatch(rf"{re.escape(release_date)}-r(\d+)", item))
            ]
            release_id = f"{release_date}-r{max(suffixes, default=1) + 1}"
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
                        "boundaries": details["boundaries"],
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
