#!/usr/bin/env python3
"""Publish final-history and provisional Building Permits Survey releases.

SOCDS republishes the Census Bureau's Building Permits Survey.  This updater
uses Census's documented West-region place files because they are small,
comma-delimited, and do not require parsing HUD's national Access archive.
Final annual history and open preliminary years advance independently.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "permit_sources.json"
PUBLIC_ROOT = ROOT / "public" / "data" / "permits"
USER_AGENT = "HousingMarketLab/1.0 (academic data pipeline; desenlin.com)"

METRICS = {
    "total_units": {
        "label": "Housing units authorized",
        "short_label": "Total units",
        "unit": "units",
        "decimals": 0,
        "definition": "New privately owned housing units authorized by residential building permits across all structure types.",
    },
    "single_unit": {
        "label": "Single-unit housing",
        "short_label": "Single-unit",
        "unit": "units",
        "decimals": 0,
        "definition": "Housing units authorized in one-unit residential buildings, including attached and detached single-unit structures.",
    },
    "small_multifamily": {
        "label": "Units in 2–4-unit buildings",
        "short_label": "2–4 units",
        "unit": "units",
        "decimals": 0,
        "definition": "Housing units authorized in two-unit and three-to-four-unit residential buildings.",
    },
    "large_multifamily": {
        "label": "Units in 5+-unit buildings",
        "short_label": "5+ units",
        "unit": "units",
        "decimals": 0,
        "definition": "Housing units authorized in residential buildings containing five or more housing units.",
    },
    "large_multifamily_share": {
        "label": "5+-unit share",
        "short_label": "5+ share",
        "unit": "share",
        "decimals": 5,
        "definition": "Share of all authorized housing units located in residential buildings containing five or more units.",
    },
    "units_per_1000_stock": {
        "label": "Units authorized per 1,000 existing units",
        "short_label": "Units per 1,000",
        "unit": "rate",
        "decimals": 2,
        "definition": "Authorized housing units divided by the latest ACS five-year estimate of the jurisdiction's housing stock, multiplied by 1,000.",
    },
}


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def request(url: str, method: str = "GET") -> Request:
    return Request(url, method=method, headers={"User-Agent": USER_AGENT})


def fetch_bytes(url: str, cache_dir: Path | None = None) -> tuple[bytes, dict[str, Any]]:
    cache_path = None
    if cache_dir:
        cache_path = cache_dir / Path(url).name
        if cache_path.exists():
            data = cache_path.read_bytes()
            return data, {"url": url, "bytes": len(data), "etag": "", "last_modified": "", "sha256": hashlib.sha256(data).hexdigest()}
    with urlopen(request(url), timeout=90) as response:
        data = response.read()
        info = {
            "url": url,
            "bytes": len(data),
            "etag": response.headers.get("ETag", "").strip('"'),
            "last_modified": response.headers.get("Last-Modified", ""),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(data)
    return data, info


def fetch_text(url: str) -> str:
    raw, _ = fetch_bytes(url)
    return raw.decode("utf-8", errors="replace")


def fetch_metadata(url: str) -> dict[str, Any]:
    with urlopen(request(url, "HEAD"), timeout=45) as response:
        return {
            "url": url,
            "bytes": integer(response.headers.get("Content-Length", "0")),
            "etag": response.headers.get("ETag", "").strip('"'),
            "last_modified": response.headers.get("Last-Modified", ""),
        }


def discover_annual_files(directory: str) -> dict[int, tuple[int, str]]:
    return {
        int(year): (0, f"{directory}{filename}")
        for filename, year in re.findall(r'href="(we(\d{4})a\.txt)"', fetch_text(directory), re.I)
    }


def discover_monthly_files(directory: str) -> dict[int, tuple[int, str]]:
    matches: dict[int, tuple[int, str]] = {}
    for filename, short_year_text, month_text in re.findall(
        r'href="(we(\d{2})(\d{2})r\.txt)"', fetch_text(directory), re.I
    ):
        short_year = int(short_year_text)
        year = 2000 + short_year if short_year < 80 else 1900 + short_year
        month = int(month_text)
        previous = matches.get(year)
        if previous is None or month > previous[0]:
            matches[year] = (month, f"{directory}{filename}")
    return matches


def decode_rows(raw: bytes) -> tuple[list[str], list[str], list[list[str]]]:
    text = raw.decode("latin-1")
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 3:
        raise ValueError("BPS file did not contain the expected two-row header")
    header_a, header_b = rows[0], rows[1]
    data = [row for row in rows[2:] if row and any(cell.strip() for cell in row)]
    return header_a, header_b, data


def header_index(header_a: list[str], header_b: list[str], first: str, second: str) -> int | None:
    width = max(len(header_a), len(header_b))
    for index in range(width):
        a = header_a[index].strip() if index < len(header_a) else ""
        b = header_b[index].strip() if index < len(header_b) else ""
        if a.lower() == first.lower() and b.lower() == second.lower():
            return index
    return None


def integer(value: str) -> int:
    cleaned = value.strip().replace(",", "")
    if not cleaned:
        return 0
    return int(float(cleaned))


def clean_name(value: str) -> str:
    upper = value.upper()
    if "LOS ANGELES" in upper and ("UNINC" in upper or "BAL" in upper):
        return "Los Angeles County Unincorporated Area"
    if "ORANGE" in upper and ("UNINC" in upper or "BAL" in upper):
        return "Orange County Unincorporated Area"
    name = re.sub(r"[.*#]+", " ", value)
    name = re.sub(r"\s+(?:\(N\)|@\d+)\s*$", "", name, flags=re.I)
    return re.sub(r"\s+", " ", name).strip().title()


def name_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def row_match_key(row: dict[str, Any]) -> str:
    if row["fips_place"] and row["fips_place"] != "99990":
        return f"place:{row['fips_place']}"
    if row["is_unincorporated"]:
        return f"unincorporated:{row['county_fips']}"
    return f"name:{row['county_fips']}:{name_key(row['name'])}"


def parse_bps(raw: bytes, source_year: int, allowed_counties: set[str]) -> list[dict[str, Any]]:
    header_a, header_b, rows = decode_rows(raw)
    name_index = header_index(header_a, header_b, "Place", "Name")
    months_index = header_index(header_a, header_b, "Number of", "Months Rep")
    source_index = header_index(header_a, header_b, "Source", "Code")
    fips_index = header_index(header_a, header_b, "FIPS Place", "Code")
    if name_index is None:
        raise ValueError("BPS place-name column was not found")
    estimated_units = [name_index + 2 + 3 * offset for offset in range(4)]
    reported_units = [name_index + 14 + 3 * offset for offset in range(4)]
    minimum_width = estimated_units[-1] + 1
    parsed: list[dict[str, Any]] = []
    for row in rows:
        if len(row) < minimum_width or row[1].strip().zfill(2) != "06":
            continue
        county_fips = row[3].strip().zfill(3)
        if county_fips not in allowed_counties:
            continue
        components = [integer(row[index]) for index in estimated_units]
        total = sum(components)
        reported = None
        if len(row) > reported_units[-1]:
            reported = sum(integer(row[index]) for index in reported_units)
        raw_date = row[0].strip()
        if len(raw_date) >= 6 and raw_date[:4].isdigit():
            date = f"{raw_date[:4]}-{raw_date[4:6]}"
        elif len(raw_date) == 4 and raw_date.isdigit() and int(raw_date[:2]) <= 99:
            date = str(source_year)
        else:
            date = str(source_year)
        fips_place = row[fips_index].strip() if fips_index is not None and fips_index < len(row) else ""
        name = clean_name(row[name_index])
        unincorporated = fips_place == "99990" or "Unincorporated Area" in name
        parsed.append({
            "date": date,
            "bps_id": row[2].strip().zfill(6),
            "county_fips": county_fips,
            "fips_place": fips_place.zfill(5) if fips_place and fips_place != "00000" else None,
            "name": name,
            "is_unincorporated": unincorporated,
            "single_unit": components[0],
            "small_multifamily": components[1] + components[2],
            "large_multifamily": components[3],
            "total_units": total,
            "large_multifamily_share": round(components[3] / total, 5) if total else None,
            "reported_units": reported,
            "months_reported": integer(row[months_index]) if months_index is not None else None,
            "source_code": row[source_index].strip() if source_index is not None else None,
        })
    return parsed


def current_reference(raw: bytes, final_year: int, config: dict[str, Any]) -> list[dict[str, Any]]:
    rows = parse_bps(raw, final_year, set(config["counties"]))
    reference = []
    counts: dict[str, int] = {}
    for row in rows:
        county = config["counties"][row["county_fips"]]
        unincorporated = row["is_unincorporated"]
        if not unincorporated and not row["fips_place"]:
            raise ValueError(f"Current BPS city lacks a place FIPS code: {row['name']}")
        match_keys = [row_match_key(row)]
        if not unincorporated:
            match_keys.append(f"name:{row['county_fips']}:{name_key(row['name'])}")
        reference.append({
            "id": f"permit:unincorporated:{row['county_fips']}" if unincorporated else f"place:06{row['fips_place']}",
            "bps_id": row["bps_id"],
            "name": row["name"],
            "county": county["name"],
            "county_fips": row["county_fips"],
            "fips_place": None if unincorporated else row["fips_place"],
            "jurisdiction_type": "county_unincorporated" if unincorporated else "incorporated_city",
            "match_keys": list(dict.fromkeys(match_keys)),
        })
        counts[row["county_fips"]] = counts.get(row["county_fips"], 0) + 1
    for code, details in config["counties"].items():
        if counts.get(code) != details["expected_jurisdictions"]:
            raise ValueError(f"{details['name']} BPS coverage changed: {counts.get(code, 0)} records")
    if len({item["id"] for item in reference}) != len(reference):
        raise ValueError("Duplicate current BPS jurisdiction identifiers")
    return sorted(reference, key=lambda item: (item["county"], item["name"]))


def reference_from_dataset(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    reference = []
    for region in dataset["regions"]:
        unincorporated = region["jurisdiction_type"] == "county_unincorporated"
        match_keys = [f"unincorporated:{region['county_fips']}"] if unincorporated else [
            f"place:{region['fips_place']}",
            f"name:{region['county_fips']}:{name_key(region['name'])}",
        ]
        reference.append({
            key: region[key]
            for key in ("id", "bps_id", "name", "county", "county_fips", "fips_place", "jurisdiction_type")
        } | {"match_keys": match_keys})
    return reference


def sources_unchanged(manifest: dict[str, Any] | None, urls: list[str]) -> bool:
    if not manifest:
        return False
    previous = {source.get("url"): source for source in manifest.get("sources", [])}
    for url in urls:
        prior = previous.get(url)
        if not prior:
            return False
        try:
            current = fetch_metadata(url)
        except Exception:
            return False
        same_etag = bool(prior.get("etag") and current["etag"] and prior["etag"] == current["etag"])
        same_modified = bool(
            prior.get("last_modified")
            and current["last_modified"]
            and prior["last_modified"] == current["last_modified"]
            and (not current["bytes"] or prior.get("bytes") == current["bytes"])
        )
        if not (same_etag or same_modified):
            return False
    return True


def acs_housing_stock(config: dict[str, Any], reference: list[dict[str, Any]], cache_dir: Path | None) -> tuple[dict[str, int], list[dict[str, Any]]]:
    year = int(config["acs_year"])
    table_url = config["acs_table_url"].format(year=year)
    table_raw, table_info = fetch_bytes(table_url, cache_dir)
    reader = csv.DictReader(io.StringIO(table_raw.decode("utf-8")), delimiter="|")
    values = {row["GEO_ID"]: integer(row["B25001_E001"]) for row in reader}
    place_values = {
        geoid.removeprefix("1600000US06"): value
        for geoid, value in values.items()
        if geoid.startswith("1600000US06")
    }
    county_values = {
        geoid.removeprefix("0500000US06"): value
        for geoid, value in values.items()
        if geoid.startswith("0500000US06") and geoid.removeprefix("0500000US06") in config["counties"]
    }
    stock: dict[str, int] = {}
    incorporated_sums = {code: 0 for code in config["counties"]}
    for item in reference:
        if item["jurisdiction_type"] != "incorporated_city":
            continue
        value = place_values.get(item["fips_place"])
        if value is None or value <= 0:
            raise ValueError(f"ACS housing stock missing for {item['name']}")
        stock[item["id"]] = value
        incorporated_sums[item["county_fips"]] += value
    for item in reference:
        if item["jurisdiction_type"] != "county_unincorporated":
            continue
        residual = county_values[item["county_fips"]] - incorporated_sums[item["county_fips"]]
        if residual <= 0:
            raise ValueError(f"Invalid ACS unincorporated housing-stock residual for {item['county']}")
        stock[item["id"]] = residual
    return stock, [table_info]


def build_dataset(
    rows: list[dict[str, Any]],
    reference: list[dict[str, Any]],
    frequency: str,
    status: str,
    housing_stock: dict[str, int],
    stock_vintage: int,
) -> dict[str, Any]:
    dates = sorted({row["date"] for row in rows})
    date_index = {date: index for index, date in enumerate(dates)}
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row_match_key(row), row["date"])
        if key in by_key:
            raise ValueError(f"Duplicate BPS jurisdiction/date after matching: {key}")
        by_key[key] = row
    regions = []
    for item in reference:
        series = {key: [None] * len(dates) for key in METRICS}
        imputed: list[int] = []
        source_codes: dict[str, list[int]] = {}
        months_reported: list[int | None] = [None] * len(dates)
        for date in dates:
            row = next(
                (by_key[(match_key, date)] for match_key in item["match_keys"] if (match_key, date) in by_key),
                None,
            )
            if row is None:
                continue
            index = date_index[date]
            for key in ("total_units", "single_unit", "small_multifamily", "large_multifamily", "large_multifamily_share"):
                series[key][index] = row[key]
            denominator = housing_stock.get(item["id"])
            if denominator:
                series["units_per_1000_stock"][index] = round(row["total_units"] * 1000 / denominator, 2)
            months_reported[index] = row["months_reported"]
            if row["source_code"]:
                source_codes.setdefault(row["source_code"], []).append(index)
                if row["source_code"] == "5":
                    imputed.append(index)
            elif row["reported_units"] is not None and row["reported_units"] != row["total_units"]:
                imputed.append(index)
        public_item = {key: value for key, value in item.items() if key != "match_keys"}
        regions.append({
            **public_item,
            "housing_stock": housing_stock.get(item["id"]),
            "housing_stock_vintage": stock_vintage,
            "series": series,
            "quality": {
                "imputed": imputed,
                "source_codes": source_codes,
                "months_reported": months_reported,
            },
        })
    return {
        "schema_version": 1,
        "geography": "permit_jurisdiction",
        "frequency": frequency,
        "status": status,
        "dates": dates,
        "metrics": METRICS,
        "regions": regions,
    }


def compact_json(data: Any) -> bytes:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def bundle_sha(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(files[name])
    return digest.hexdigest()


def load_manifest(kind: str) -> dict[str, Any] | None:
    pointer = PUBLIC_ROOT / kind / "latest.json"
    if not pointer.exists():
        return None
    release = json.loads(pointer.read_text(encoding="utf-8"))["release"]
    path = PUBLIC_ROOT / kind / "releases" / release / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def publish(kind: str, files: dict[str, bytes], manifest: dict[str, Any], keep: int, max_bytes: int) -> bool:
    digest = bundle_sha(files)
    current = load_manifest(kind)
    if current and current.get("bundle_sha256") == digest:
        print(f"BPS {kind} observations are unchanged; retaining the current release.")
        return False
    release = datetime.now(timezone.utc).strftime("%Y-%m-%d-r%H%M%S")
    manifest = {**manifest, "release": release, "bundle_sha256": digest}
    payload = {**files, "manifest.json": compact_json(manifest)}
    total = sum(len(content) for content in payload.values())
    if total > max_bytes:
        raise ValueError(f"BPS {kind} release is too large: {total:,} bytes")
    root = PUBLIC_ROOT / kind
    release_dir = root / "releases" / release
    release_dir.mkdir(parents=True, exist_ok=False)
    for name, content in payload.items():
        (release_dir / name).write_bytes(content)
    temporary = root / "latest.json.tmp"
    temporary.write_bytes(compact_json({"release": release, "bundle_sha256": digest}))
    temporary.replace(root / "latest.json")
    releases = sorted(path for path in (root / "releases").iterdir() if path.is_dir())
    for stale in releases[:-keep]:
        shutil.rmtree(stale)
    print(f"Published BPS {kind} release {release}: {total:,} bytes")
    return True


def download_many(urls: list[str], cache_dir: Path | None) -> dict[str, tuple[bytes, dict[str, Any]]]:
    results: dict[str, tuple[bytes, dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(fetch_bytes, url, cache_dir): url for url in urls}
        for future in as_completed(futures):
            url = futures[future]
            results[url] = future.result()
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", type=Path, help="Optional download cache for development")
    parser.add_argument("--force-history", action="store_true", help="Rebuild final history even when its final year is unchanged")
    args = parser.parse_args()
    config = load_config()
    annual_files = discover_annual_files(config["annual_directory"])
    monthly_files = discover_monthly_files(config["monthly_directory"])
    final_year = max(year for year in annual_files if year >= int(config["annual_start_year"]))
    history_manifest = load_manifest("history")
    rebuild_history = args.force_history or not history_manifest or history_manifest.get("latest_final_year") != final_year
    housing_stock: dict[str, int]
    if history_manifest and not rebuild_history:
        release = history_manifest["release"]
        annual_path = PUBLIC_ROOT / "history" / "releases" / release / "annual.json"
        annual_existing = json.loads(annual_path.read_text(encoding="utf-8"))
        reference = reference_from_dataset(annual_existing)
        housing_stock = {region["id"]: region["housing_stock"] for region in annual_existing["regions"]}
    else:
        final_raw, _ = fetch_bytes(annual_files[final_year][1], args.cache_dir)
        reference = current_reference(final_raw, final_year, config)
        housing_stock, acs_sources = acs_housing_stock(config, reference, args.cache_dir)
        annual_years = list(range(int(config["annual_start_year"]), final_year + 1))
        missing_annual = [year for year in annual_years if year not in annual_files]
        if missing_annual:
            raise ValueError(f"Missing BPS annual files: {missing_annual}")
        monthly_years = list(range(int(config["monthly_start_year"]), final_year + 1))
        missing_monthly = [year for year in monthly_years if year not in monthly_files or monthly_files[year][0] < 12]
        if missing_monthly:
            raise ValueError(f"Missing complete BPS monthly files: {missing_monthly}")
        annual_urls = [annual_files[year][1] for year in annual_years]
        monthly_urls = [monthly_files[year][1] for year in monthly_years]
        downloaded = download_many(sorted(set(annual_urls + monthly_urls)), args.cache_dir)
        annual_rows = []
        monthly_rows = []
        sources = []
        for year in annual_years:
            raw, info = downloaded[annual_files[year][1]]
            annual_rows.extend(parse_bps(raw, year, set(config["counties"])))
            sources.append(info)
        for year in monthly_years:
            raw, info = downloaded[monthly_files[year][1]]
            monthly_rows.extend(parse_bps(raw, year, set(config["counties"])))
            sources.append(info)
        annual_dataset = build_dataset(annual_rows, reference, "Annual", "Final", housing_stock, int(config["acs_year"]))
        monthly_dataset = build_dataset(monthly_rows, reference, "Monthly", "Final", housing_stock, int(config["acs_year"]))
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        history_files = {"annual.json": compact_json(annual_dataset), "monthly.json": compact_json(monthly_dataset)}
        publish(
            "history",
            history_files,
            {
                "schema_version": 1,
                "created_at": now,
                "provider": config["provider"],
                "attribution": "Source: U.S. Census Bureau Building Permits Survey.",
                "data_page": config["data_page"],
                "socds_page": config["socds_page"],
                "methodology_page": config["methodology_page"],
                "documentation_page": config["documentation_page"],
                "latest_final_year": final_year,
                "latest_final_month": monthly_dataset["dates"][-1] if monthly_dataset["dates"] else None,
                "monthly_methodology_start": f"{config['monthly_start_year']}-01",
                "acs_vintage": int(config["acs_year"]),
                "counts": {"jurisdictions": len(reference), "cities": sum(item["jurisdiction_type"] == "incorporated_city" for item in reference), "county_unincorporated": 2},
                "sources": sources + acs_sources,
            },
            int(config["keep_history_releases"]),
            int(config["max_history_bytes"]),
        )

    open_years = sorted(year for year in monthly_files if year > final_year and year >= int(config["monthly_start_year"]))
    if not open_years:
        raise ValueError("No provisional BPS monthly year is available")
    provisional_urls = [monthly_files[year][1] for year in open_years]
    provisional_manifest = load_manifest("provisional")
    if sources_unchanged(provisional_manifest, provisional_urls):
        print("BPS provisional source metadata are unchanged; retaining the current release.")
        return
    downloaded = download_many(provisional_urls, args.cache_dir)
    provisional_rows = []
    provisional_sources = []
    for year in open_years:
        raw, info = downloaded[monthly_files[year][1]]
        provisional_rows.extend(parse_bps(raw, year, set(config["counties"])))
        provisional_sources.append(info)
    provisional_dataset = build_dataset(provisional_rows, reference, "Monthly", "Preliminary", housing_stock, int(config["acs_year"]))
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    publish(
        "provisional",
        {"monthly.json": compact_json(provisional_dataset)},
        {
            "schema_version": 1,
            "created_at": now,
            "provider": config["provider"],
            "attribution": "Source: U.S. Census Bureau Building Permits Survey.",
            "data_page": config["data_page"],
            "socds_page": config["socds_page"],
            "methodology_page": config["methodology_page"],
            "documentation_page": config["documentation_page"],
            "latest_final_year": final_year,
            "latest_observation": provisional_dataset["dates"][-1],
            "open_years": open_years,
            "acs_vintage": int(config["acs_year"]),
            "counts": {"jurisdictions": len(reference), "cities": sum(item["jurisdiction_type"] == "incorporated_city" for item in reference), "county_unincorporated": 2},
            "sources": provisional_sources,
        },
        int(config["keep_provisional_releases"]),
        int(config["max_provisional_bytes"]),
    )


if __name__ == "__main__":
    main()
