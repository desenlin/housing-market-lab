#!/usr/bin/env python3
"""Build an atomic, chart-ready housing-data release from local source files.

Zillow source files must be obtained by the maintainer and supplied through
``--source-dir``. This command does not retrieve Zillow files. A release is
promoted by updating public/data/latest.json only after every required source
and validation check passes. If the command fails, the previously deployed
release is intact.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import tempfile
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import shapefile

try:
    from pipeline.storage import (
        atomic_write, bundle_sha, compact_json, dataset_shards, load_dataset_release,
        map_shards, merge_dataset_history, prune_releases,
    )
except ModuleNotFoundError:  # direct script execution
    from storage import (  # type: ignore[no-redef]
        atomic_write, bundle_sha, compact_json, dataset_shards, load_dataset_release,
        map_shards, merge_dataset_history, prune_releases,
    )


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "sources.json"
PUBLIC_DATA = ROOT / "public" / "data"
MAX_SOURCE_BYTES = 300 * 1024 * 1024
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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def manual_source_path(source_dir: Path, source: dict[str, Any]) -> Path:
    """Resolve a manually supplied Zillow CSV without making a network request."""
    provider_filename = source["last_url"].rsplit("/", 1)[-1]
    candidates = (source_dir / f"{source['id']}.csv", source_dir / provider_filename)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    expected = " or ".join(path.name for path in candidates)
    raise RuntimeError(f"Missing Zillow source {source['id']}: expected {expected}")


def validate_manual_source(path: Path, source_id: str) -> None:
    size = path.stat().st_size
    if size < 1_000:
        raise RuntimeError(f"Zillow source {source_id} was unexpectedly small")
    if size > MAX_SOURCE_BYTES:
        raise RuntimeError(f"Zillow source {source_id} exceeded the 300 MB safety limit")
    with path.open("rb") as handle:
        if not handle.readline(512).startswith(b"RegionID,"):
            raise RuntimeError(f"Zillow source {source_id} did not have a Zillow CSV header")


def manual_source_files(
    source_dir: Path, sources: list[dict[str, Any]]
) -> dict[str, Path]:
    if not source_dir.is_dir():
        raise RuntimeError(f"Zillow source directory was not found: {source_dir}")
    missing: list[str] = []
    resolved: dict[str, Path] = {}
    for source in sources:
        try:
            path = manual_source_path(source_dir, source)
            validate_manual_source(path, source["id"])
            resolved[source["id"]] = path
        except RuntimeError as exc:
            missing.append(str(exc))
    if missing:
        raise RuntimeError("Incomplete Zillow source directory:\n- " + "\n- ".join(missing))
    return resolved


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


def release_id(root: Path, fetched_at: datetime) -> str:
    stem = fetched_at.strftime("%Y-%m-%d-r%H%M%S")
    candidate = stem
    suffix = 2
    while (root / "releases" / candidate).exists():
        candidate = f"{stem}-{suffix}"
        suffix += 1
    return candidate


def publish_maps(
    maps: dict[str, dict[str, Any]], fetched_at: datetime, keep: int
) -> str:
    root = PUBLIC_DATA / "maps"
    files, file_index = map_shards(maps)
    digest = bundle_sha(files)
    pointer = root / "latest.json"
    if pointer.exists():
        current_release = json.loads(pointer.read_text(encoding="utf-8"))["release"]
        current_manifest = root / "releases" / current_release / "manifest.json"
        if current_manifest.exists():
            current = json.loads(current_manifest.read_text(encoding="utf-8"))
            if current.get("bundle_sha256") == digest:
                return current_release
    release = release_id(root, fetched_at)
    release_dir = root / "releases" / release
    for name, content in files.items():
        write_bytes(release_dir / name, content)
    write_bytes(
        release_dir / "manifest.json",
        compact_json({
            "storage_schema_version": 2,
            "release": release,
            "created_at": fetched_at.isoformat().replace("+00:00", "Z"),
            "provider": "U.S. Census Bureau",
            "bundle_sha256": digest,
            "files": file_index,
        }),
    )
    atomic_write(root / "latest.json", compact_json({"release": release, "bundle_sha256": digest}))
    prune_releases(root, keep)
    return release


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-maps", action="store_true")
    parser.add_argument(
        "--source-dir",
        type=Path,
        required=True,
        help=(
            "Directory containing maintainer-provided Zillow CSVs. Files may use "
            "their provider filenames or the configured source IDs."
        ),
    )
    args = parser.parse_args()
    config = load_config()
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0)
    source_paths = manual_source_files(args.source_dir, config["sources"])

    with tempfile.TemporaryDirectory(prefix="housing-market-lab-") as temp_name:
        temp_dir = Path(temp_name)
        extracted = []
        source_manifest = {}
        for source in config["sources"]:
            path = source_paths[source["id"]]
            source_info = {
                "url": source["last_url"],
                "filename": path.name,
                "acquisition": "maintainer-provided",
                "bytes": path.stat().st_size,
                "sha256": file_sha256(path),
            }
            result = extract_source(path, source, config)
            extracted.append(result)
            source_manifest[source["id"]] = {
                **source_info,
                "metric": source["metric"],
                "geography": source["geography"],
                "latest_observation": result["latest_date"],
                "regions": len(result["regions"]),
            }

        incoming_payloads = {
            geography: combine_geography(geography, extracted)
            for geography in ("city", "zip", "metro")
        }
        payloads = {}
        history_reports = {}
        prior_release = None
        allowed_metros = {item["label"] for item in config["metros"]}
        for geography, incoming in incoming_payloads.items():
            previous, previous_manifest = load_dataset_release(PUBLIC_DATA, geography)
            if previous_manifest:
                prior_release = previous_manifest.get("release")
            payloads[geography], history_reports[geography] = merge_dataset_history(
                previous,
                incoming,
                allowed_region_names=allowed_metros if geography == "metro" else None,
            )
        validate_payloads(payloads, config)
        maps = {} if args.skip_maps else build_maps(payloads, config, temp_dir)

        map_release = publish_maps(
            maps, fetched_at, int(config["keep_map_releases"])
        ) if maps else None
        bundle_files: dict[str, bytes] = {}
        file_index: dict[str, list[str]] = {}
        for geography, payload in payloads.items():
            files, names = dataset_shards(payload)
            bundle_files.update(files)
            file_index[geography] = names
        digest = bundle_sha(bundle_files)
        if existing_bundle_sha() == digest:
            print("No provider revisions or new observations; current release retained.")
            return

        published_release = release_id(PUBLIC_DATA, fetched_at)
        release_dir = PUBLIC_DATA / "releases" / published_release

        latest_by_metric = {
            item["id"]: source_manifest[item["id"]]["latest_observation"]
            for item in config["sources"]
        }
        manifest = {
            "storage_schema_version": 2,
            "release": published_release,
            "created_at": fetched_at.isoformat().replace("+00:00", "Z"),
            "data_page": config["data_page"],
            "provider": "Zillow Research",
            "attribution": "Data provided by Zillow Group",
            "bundle_sha256": digest,
            "files": file_index,
            "map_release": map_release,
            "history_policy": {
                "strategy": "merge_forward",
                "previous_release": prior_release,
                "reports": history_reports,
            },
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
        total = sum(len(content) for content in bundle_files.values())
        if total > int(config["max_published_bytes_per_release"]):
            raise RuntimeError("Zillow release exceeded its storage budget")
        for filename, content in bundle_files.items():
            write_bytes(release_dir / filename, content)
        write_bytes(release_dir / "manifest.json", compact_json(manifest))
        atomic_write(
            PUBLIC_DATA / "latest.json",
            compact_json(
                {
                    "release": published_release,
                    "manifest": f"releases/{published_release}/manifest.json",
                }
            ),
        )
        removed = prune_releases(PUBLIC_DATA, int(config["keep_releases"]))
        suffix = f"; pruned {', '.join(removed)}" if removed else ""
        print(
            f"Published release {published_release}: "
            f"{len(payloads['city']['regions'])} city/community regions, "
            f"{len(payloads['zip']['regions'])} ZIP regions{suffix}."
        )


if __name__ == "__main__":
    main()
