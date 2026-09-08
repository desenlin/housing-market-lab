#!/usr/bin/env python3
"""Publish a compact, infrequently refreshed ACS housing-context layer.

Routine runs first check whether the next ACS five-year vintage exists.  When
the configured vintage is already current, the script exits without a data
query or rebuild.  A new vintage is retrieved from the Census API in two
requests: selected variables for California places and for California ZCTAs.
Only map geographies in Los Angeles and Orange Counties are retained.

The optional --bootstrap-bulk mode exists to seed a release without an API
key.  It streams only the six required national table files and discards all
nonlocal rows; it is not used by the scheduled workflow.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from pipeline.storage import atomic_write, bundle_sha, compact_json
except ModuleNotFoundError:  # direct script execution
    from storage import atomic_write, bundle_sha, compact_json  # type: ignore[no-redef]


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "acs_sources.json"
PUBLIC_ROOT = ROOT / "public" / "data" / "acs"
USER_AGENT = "HousingMarketLab/1.0 (academic data pipeline; desenlin.com)"

TABLES = ("B01002", "B19013", "B25003", "B25010", "B25024", "B25070")
RAW_VARIABLES = (
    "B01002_001E", "B01002_001M",
    "B19013_001E", "B19013_001M",
    "B25003_001E", "B25003_001M", "B25003_002E", "B25003_002M", "B25003_003E", "B25003_003M",
    "B25010_001E", "B25010_001M",
    "B25024_001E", "B25024_001M",
    "B25024_006E", "B25024_006M", "B25024_007E", "B25024_007M",
    "B25024_008E", "B25024_008M", "B25024_009E", "B25024_009M",
    *tuple(f"B25070_{index:03d}{suffix}" for index in range(2, 12) for suffix in ("E", "M")),
)

METRICS: dict[str, dict[str, Any]] = {
    "median_household_income": {
        "label": "Median household income",
        "short_label": "Household income",
        "unit": "currency",
        "decimals": 0,
        "change_mode": "percent",
        "source_table": "B19013",
        "universe": "Households",
        "definition": "Median household income in inflation-adjusted dollars for the ACS period's final year.",
    },
    "renter_share": {
        "label": "Renter-occupied share",
        "short_label": "Renter share",
        "unit": "share",
        "decimals": 1,
        "change_mode": "percentage_point",
        "source_table": "B25003",
        "universe": "Occupied housing units",
        "definition": "Share of occupied housing units that are renter occupied.",
    },
    "rent_burden_share": {
        "label": "Rent-burdened households",
        "short_label": "Rent burden",
        "unit": "share",
        "decimals": 1,
        "change_mode": "percentage_point",
        "source_table": "B25070",
        "universe": "Renter-occupied units paying cash rent with burden computed",
        "definition": "Share of renter households with gross rent equal to at least 30 percent of household income, excluding records where burden is not computed.",
    },
    "average_household_size": {
        "label": "Average household size",
        "short_label": "Household size",
        "unit": "people",
        "decimals": 2,
        "change_mode": "difference",
        "source_table": "B25010",
        "universe": "Occupied housing units",
        "definition": "Average number of people per occupied housing unit.",
    },
    "median_age": {
        "label": "Median age",
        "short_label": "Median age",
        "unit": "years",
        "decimals": 1,
        "change_mode": "difference",
        "source_table": "B01002",
        "universe": "Total population",
        "definition": "Age that divides the population into two numerically equal groups.",
    },
    "multifamily_share": {
        "label": "Housing in 5+-unit structures",
        "short_label": "Multifamily share",
        "unit": "share",
        "decimals": 1,
        "change_mode": "percentage_point",
        "source_table": "B25024",
        "universe": "Housing units",
        "definition": "Share of housing units located in structures containing five or more units.",
    },
}


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def request(url: str, method: str = "GET") -> urllib.request.Request:
    return urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})


def current_release() -> tuple[dict[str, Any] | None, Path | None]:
    pointer = PUBLIC_ROOT / "latest.json"
    if not pointer.exists():
        return None, None
    release = json.loads(pointer.read_text(encoding="utf-8"))["release"]
    root = PUBLIC_ROOT / "releases" / release
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    return manifest, root


def table_url(config: dict[str, Any], year: int, table: str) -> str:
    base = config["summary_file_base"]
    if year <= 2021:
        return f"{base}/{year}/prototype/5YRData/acsdt5y{year}-{table.lower()}.dat"
    return f"{base}/{year}/table-based-SF/data/5YRData/acsdt5y{year}-{table.lower()}.dat"


def vintage_available(config: dict[str, Any], year: int) -> bool:
    try:
        with urllib.request.urlopen(request(table_url(config, year, "B19013"), "HEAD"), timeout=45) as response:
            return getattr(response, "status", 200) == 200
    except (OSError, urllib.error.HTTPError):
        return False


def map_reference() -> dict[str, dict[str, dict[str, str]]]:
    pointer = json.loads((ROOT / "public" / "data" / "maps" / "latest.json").read_text())
    root = ROOT / "public" / "data" / "maps" / "releases" / pointer["release"]
    manifest = json.loads((root / "manifest.json").read_text())
    output: dict[str, dict[str, dict[str, str]]] = {"city": {}, "zip": {}}
    for geography in output:
        for filename in manifest["files"][geography]:
            shard = json.loads((root / filename).read_text())
            for county_name, county in shard["counties"].items():
                for region in county["regions"]:
                    output[geography][region["id"]] = {
                        "id": region["id"],
                        "name": region["name"],
                        "county": county_name,
                    }
    return output


def api_url(config: dict[str, Any], year: int, geography: str, key: str) -> str:
    summary_level = "1600000" if geography == "city" else "8600000"
    params = {
        "get": ",".join(("NAME", *RAW_VARIABLES)),
        "ucgid": f"pseudo(0400000US{config['state_fips']}${summary_level})",
        "key": key,
    }
    return f"{config['api_base']}/{year}/{config['dataset']}?{urllib.parse.urlencode(params)}"


def parse_api(payload: bytes) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    rows = json.loads(payload)
    if not rows or "ucgid" not in rows[0]:
        raise ValueError("Census API response is missing UCGID geography identifiers")
    header = rows[0]
    parsed = {row[header.index("ucgid")]: dict(zip(header, row)) for row in rows[1:]}
    return parsed, {"rows_returned": len(parsed), "bytes": len(payload)}


def fetch_api(config: dict[str, Any], year: int, geography: str, key: str) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    url = api_url(config, year, geography, key)
    with urllib.request.urlopen(request(url), timeout=90) as response:
        payload = response.read()
    rows, info = parse_api(payload)
    info["url"] = url.split("&key=", 1)[0]
    info["sha256"] = hashlib.sha256(payload).hexdigest()
    return rows, info


def bulk_column(api_variable: str) -> str:
    table, suffix = api_variable.split("_", 1)
    return f"{table}_{suffix[-1]}{suffix[:-1]}"


def fetch_bulk_table(url: str, wanted_geoids: set[str]) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    digest = hashlib.sha256()
    observed_bytes = 0

    class DigestReader(io.RawIOBase):
        def __init__(self, raw: Any):
            self.raw = raw

        def readable(self) -> bool:
            return True

        def readinto(self, buffer: bytearray) -> int:
            nonlocal observed_bytes
            data = self.raw.read(len(buffer))
            size = len(data)
            if size:
                buffer[:size] = data
                digest.update(data)
                observed_bytes += size
            return size

    with urllib.request.urlopen(request(url), timeout=180) as response:
        stream = io.TextIOWrapper(io.BufferedReader(DigestReader(response)), encoding="utf-8-sig", newline="")
        reader = csv.DictReader(stream, delimiter="|")
        rows = {row["GEO_ID"]: row for row in reader if row.get("GEO_ID") in wanted_geoids}
    return rows, {"url": url, "bytes": observed_bytes, "sha256": digest.hexdigest(), "rows_retained": len(rows)}


def fetch_bulk(config: dict[str, Any], year: int, reference: dict[str, dict[str, dict[str, str]]], include_zip: bool) -> tuple[dict[str, dict[str, str]], list[dict[str, Any]]]:
    wanted = set()
    for region_id in reference["city"]:
        wanted.add(f"1600000US{region_id.removeprefix('place:')}")
    if include_zip:
        for region_id in reference["zip"]:
            wanted.add(f"860Z200US{region_id.removeprefix('zcta:')}")
    combined: dict[str, dict[str, str]] = {geoid: {} for geoid in wanted}
    sources = []
    for table in TABLES:
        url = table_url(config, year, table)
        rows, info = fetch_bulk_table(url, wanted)
        sources.append(info)
        for geoid, row in rows.items():
            combined[geoid].update({
                variable: row.get(bulk_column(variable), "")
                for variable in RAW_VARIABLES
                if variable.startswith(f"{table}_")
            })
    return {geoid: row for geoid, row in combined.items() if row}, sources


def number(row: dict[str, str], variable: str) -> float | None:
    raw = row.get(variable, "").strip()
    if raw in {"", "null", "-666666666", "-888888888", "-999999999"}:
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


def direct(row: dict[str, str], stem: str) -> tuple[float | None, float | None]:
    return number(row, f"{stem}E"), number(row, f"{stem}M")


def sum_cells(row: dict[str, str], stems: Iterable[str]) -> tuple[float | None, float | None]:
    pairs = [direct(row, stem) for stem in stems]
    if any(estimate is None or moe is None for estimate, moe in pairs):
        return None, None
    return sum(estimate for estimate, _ in pairs if estimate is not None), math.sqrt(sum(moe * moe for _, moe in pairs if moe is not None))


def share(numerator: tuple[float | None, float | None], denominator: tuple[float | None, float | None]) -> tuple[float | None, float | None]:
    num, num_moe = numerator
    den, den_moe = denominator
    if num is None or num_moe is None or den is None or den_moe is None or den <= 0:
        return None, None
    proportion = num / den
    radicand = num_moe * num_moe - proportion * proportion * den_moe * den_moe
    if radicand < 0:
        radicand = num_moe * num_moe + proportion * proportion * den_moe * den_moe
    return round(proportion * 100, 3), round(math.sqrt(radicand) / den * 100, 3)


def derive(row: dict[str, str]) -> dict[str, tuple[float | None, float | None]]:
    rent_computed = sum_cells(row, (f"B25070_{index:03d}" for index in range(2, 11)))
    rent_burden = sum_cells(row, (f"B25070_{index:03d}" for index in range(7, 11)))
    multifamily = sum_cells(row, (f"B25024_{index:03d}" for index in range(6, 10)))
    return {
        "median_household_income": direct(row, "B19013_001"),
        "renter_share": share(direct(row, "B25003_003"), direct(row, "B25003_001")),
        "rent_burden_share": share(rent_burden, rent_computed),
        "average_household_size": direct(row, "B25010_001"),
        "median_age": direct(row, "B01002_001"),
        "multifamily_share": share(multifamily, direct(row, "B25024_001")),
    }


def cpi_factor(prior_year: int, current_year: int) -> float:
    pointer = json.loads((ROOT / "public" / "data" / "cpi" / "latest.json").read_text())
    path = ROOT / "public" / "data" / "cpi" / "releases" / pointer["release"] / "cpi.json"
    cpi = json.loads(path.read_text())["series"]["us"]
    values: dict[int, list[float]] = {}
    for date, value in zip(cpi["dates"], cpi["values"]):
        if value is not None:
            values.setdefault(int(date[:4]), []).append(float(value))
    if prior_year not in values or current_year not in values:
        raise ValueError("U.S. CPI series does not cover both ACS income vintages")
    return (sum(values[current_year]) / len(values[current_year])) / (sum(values[prior_year]) / len(values[prior_year]))


def canonical_geoid(region_id: str) -> str:
    if region_id.startswith("place:"):
        return f"1600000US{region_id.removeprefix('place:')}"
    return f"860Z200US{region_id.removeprefix('zcta:')}"


def build_dataset(
    geography: str,
    reference: dict[str, dict[str, str]],
    prior_rows: dict[str, dict[str, str]],
    current_rows: dict[str, dict[str, str]],
    prior_period: str,
    current_period: str,
    income_factor: float,
) -> dict[str, Any]:
    regions = []
    for region_id, item in sorted(reference.items(), key=lambda pair: (pair[1]["county"], pair[1]["name"])):
        geoid = canonical_geoid(region_id)
        periods = [derive(prior_rows[geoid]) if geoid in prior_rows else {}, derive(current_rows[geoid]) if geoid in current_rows else {}]
        series: dict[str, list[float | None]] = {}
        moe: dict[str, list[float | None]] = {}
        for metric in METRICS:
            estimates = [period.get(metric, (None, None))[0] for period in periods]
            margins = [period.get(metric, (None, None))[1] for period in periods]
            if metric == "median_household_income" and estimates[0] is not None:
                estimates[0] = round(estimates[0] * income_factor)
                margins[0] = round(margins[0] * income_factor) if margins[0] is not None else None
            series[metric] = estimates
            moe[metric] = margins
        regions.append({**item, "series": series, "moe": moe})
    return {
        "schema_version": 1,
        "geography": geography,
        "period_kind": "acs_five_year",
        "comparison_available": geography == "city",
        "periods": [prior_period, current_period],
        "metrics": METRICS,
        "regions": regions,
    }


def publish(config: dict[str, Any], datasets: dict[str, dict[str, Any]], manifest: dict[str, Any]) -> bool:
    files = {f"{geography}.json": compact_json(dataset) for geography, dataset in datasets.items()}
    digest = bundle_sha(files)
    current, _ = current_release()
    if current and current.get("bundle_sha256") == digest:
        print("ACS observations are unchanged; retaining the current release.")
        return False
    release = datetime.now(timezone.utc).strftime("%Y-%m-%d-r%H%M%S")
    manifest = {
        **manifest,
        "release": release,
        "bundle_sha256": digest,
        "files": {geography: [f"{geography}.json"] for geography in datasets},
    }
    payload = {**files, "manifest.json": compact_json(manifest)}
    total = sum(len(value) for value in payload.values())
    if total > int(config["max_release_bytes"]):
        raise ValueError(f"ACS compact release is too large: {total:,} bytes")
    root = PUBLIC_ROOT / "releases" / release
    root.mkdir(parents=True, exist_ok=False)
    for filename, content in payload.items():
        (root / filename).write_bytes(content)
    atomic_write(PUBLIC_ROOT / "latest.json", compact_json({"release": release, "bundle_sha256": digest}))
    releases = sorted(path for path in (PUBLIC_ROOT / "releases").iterdir() if path.is_dir())
    for stale in releases[:-int(config["keep_releases"])]:
        shutil.rmtree(stale)
    print(f"Published ACS release {release}: {total:,} bytes")
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap-bulk", action="store_true", help="Stream Census table files instead of using the keyed API")
    parser.add_argument("--force", action="store_true", help="Rebuild the configured vintage even if it is already published")
    args = parser.parse_args()
    config = load_config()
    current, _ = current_release()
    configured_year = int(config["latest_year"])
    latest_year = configured_year
    comparison_year = int(config["comparison_year"])
    next_year = configured_year + 1

    if not args.force and current and int(current["latest_year"]) >= configured_year:
        if not vintage_available(config, next_year):
            print(f"ACS {configured_year} five-year vintage remains current; no data query or processing needed.")
            return
        latest_year = next_year
        comparison_year = next_year - 5

    if latest_year - comparison_year != 5:
        raise ValueError("ACS comparison vintages must be non-overlapping five-year periods")
    reference = map_reference()
    sources: list[dict[str, Any]] = []
    if args.bootstrap_bulk:
        prior_rows, prior_sources = fetch_bulk(config, comparison_year, reference, include_zip=False)
        current_rows, current_sources = fetch_bulk(config, latest_year, reference, include_zip=True)
        sources.extend(prior_sources + current_sources)
    else:
        key = os.environ.get("CENSUS_API_KEY", "").strip()
        if not key:
            raise RuntimeError("CENSUS_API_KEY is required when a new ACS vintage must be retrieved")
        prior_rows, prior_info = fetch_api(config, comparison_year, "city", key)
        current_places, place_info = fetch_api(config, latest_year, "city", key)
        current_zctas, zcta_info = fetch_api(config, latest_year, "zip", key)
        current_rows = {**current_places, **current_zctas}
        sources.extend([prior_info, place_info, zcta_info])

    factor = cpi_factor(comparison_year, latest_year)
    prior_period = f"{comparison_year - 4}–{comparison_year}"
    current_period = f"{latest_year - 4}–{latest_year}"
    datasets = {
        "city": build_dataset("city", reference["city"], prior_rows, current_rows, prior_period, current_period, factor),
        "zip": build_dataset("zip", reference["zip"], {}, current_rows, prior_period, current_period, factor),
    }
    if sum(any(value is not None for values in region["series"].values() for value in values) for region in datasets["city"]["regions"]) < 170:
        raise ValueError("ACS city/community coverage fell below the validation floor")
    if sum(any(value is not None for values in region["series"].values() for value in values) for region in datasets["zip"]["regions"]) < 330:
        raise ValueError("ACS ZCTA coverage fell below the validation floor")
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    publish(config, datasets, {
        "schema_version": 1,
        "created_at": now,
        "provider": config["provider"],
        "attribution": "Source: U.S. Census Bureau, American Community Survey five-year estimates.",
        "data_page": config["data_page"],
        "comparison_guidance": config["comparison_guidance"],
        "geography_guidance": config["geography_guidance"],
        "latest_year": latest_year,
        "comparison_year": comparison_year,
        "periods": [prior_period, current_period],
        "comparison_design": "Non-overlapping five-year estimates; city/community comparison only",
        "income_adjustment": {"basis": f"{latest_year} dollars", "method": "Annual-average U.S. CPI-U", "factor": round(factor, 6)},
        "counts": {key: len(value["regions"]) for key, value in datasets.items()},
        "sources": sources,
    })
    if latest_year != configured_year:
        updated = {**config, "latest_year": latest_year, "comparison_year": comparison_year}
        atomic_write(CONFIG_PATH, json.dumps(updated, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")


if __name__ == "__main__":
    main()
