#!/usr/bin/env python3
"""Publish a compact, source-isolated BLS CPI release.

The lab uses the Los Angeles-area CPI-U to express local values and rents in
constant dollars and the U.S. CPI-U as a common benchmark in cross-metro
figures. The official BLS bulk file is preferred because it is not subject to
the Public Data API's unregistered daily query quota. The API remains a
fallback, with requests split within its ten-year unregistered limit. Missing
official observations remain explicit nulls. A disclosed interpolation policy
is published separately for the application's derived real-value calculations.
"""

from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import math
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "cpi_sources.json"
PUBLIC_DATA = ROOT / "public" / "data" / "cpi"
USER_AGENT = "HousingMarketLab/1.0 (academic visualization; desenlin.com)"
MAX_PUBLISHED_BYTES = 2 * 1024 * 1024


def compact_json(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def year_chunks(start_year: int, end_year: int, width: int = 10) -> list[tuple[int, int]]:
    if start_year > end_year:
        raise ValueError("start year must not exceed end year")
    chunks = []
    current = start_year
    while current <= end_year:
        chunk_end = min(current + width - 1, end_year)
        chunks.append((current, chunk_end))
        current = chunk_end + 1
    return chunks


def month_end(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}-{calendar.monthrange(year, month)[1]:02d}"


def api_request(api_url: str, series_id: str, start_year: int, end_year: int) -> dict[str, Any]:
    body = compact_json({
        "seriesid": [series_id],
        "startyear": str(start_year),
        "endyear": str(end_year),
    })
    request = urllib.request.Request(
        api_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        if getattr(response, "status", 200) != 200:
            raise RuntimeError(f"BLS API returned HTTP {response.status}")
        return json.loads(response.read())


def bulk_request(bulk_url: str) -> str:
    request = urllib.request.Request(bulk_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        if getattr(response, "status", 200) != 200:
            raise RuntimeError(f"BLS bulk download returned HTTP {response.status}")
        return response.read().decode("utf-8-sig")


def parse_response(payload: dict[str, Any], expected_series_id: str) -> dict[str, float]:
    if payload.get("status") != "REQUEST_SUCCEEDED":
        raise ValueError(f"BLS request failed: {payload.get('message')}")
    series = payload.get("Results", {}).get("series", [])
    if len(series) != 1 or series[0].get("seriesID") != expected_series_id:
        raise ValueError(f"BLS response did not contain {expected_series_id}")
    observations: dict[str, float] = {}
    for row in series[0].get("data", []):
        period = str(row.get("period", ""))
        if not period.startswith("M") or period == "M13":
            continue
        month = int(period[1:])
        if month < 1 or month > 12:
            continue
        raw_value = str(row.get("value", "")).strip()
        if raw_value in {"", "-", "NA", "N/A"}:
            continue
        value = float(raw_value)
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"Invalid CPI value for {row.get('year')} {period}")
        observations[month_end(int(row["year"]), month)] = value
    return observations


def parse_bulk_data(
    payload: str,
    series_ids: set[str],
    start_year: int,
    end_year: int,
) -> dict[str, dict[str, float]]:
    observations = {series_id: {} for series_id in series_ids}
    for line_number, line in enumerate(payload.splitlines(), start=1):
        if line_number == 1:
            continue
        columns = line.split("\t")
        if len(columns) < 4:
            continue
        series_id, raw_year, period, raw_value = (column.strip() for column in columns[:4])
        if series_id not in observations or not period.startswith("M") or period == "M13":
            continue
        if raw_value in {"", "-", "NA", "N/A"}:
            continue
        year = int(raw_year)
        month = int(period[1:])
        if year < start_year or year > end_year or month < 1 or month > 12:
            continue
        value = float(raw_value)
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"Invalid CPI value for {series_id} {year} {period}")
        date = month_end(year, month)
        if date in observations[series_id]:
            raise ValueError(f"Duplicate CPI date in BLS bulk data: {series_id} {date}")
        observations[series_id][date] = value
    missing = sorted(series_id for series_id, values in observations.items() if not values)
    if missing:
        raise ValueError(f"BLS bulk data did not contain required series: {missing}")
    return observations


def complete_months(
    observations: dict[str, float], start_year: int, end_year: int
) -> tuple[list[str], list[float | None]]:
    if not observations:
        raise ValueError("BLS returned no monthly observations")
    first = min(observations)
    last = max(observations)
    dates: list[str] = []
    values: list[float | None] = []
    for year in range(max(start_year, int(first[:4])), min(end_year, int(last[:4])) + 1):
        for month in range(1, 13):
            date = month_end(year, month)
            if date < first or date > last:
                continue
            dates.append(date)
            values.append(observations.get(date))
    return dates, values


def yoy_values(values: list[float | None]) -> list[float | None]:
    result: list[float | None] = []
    for index, value in enumerate(values):
        prior = values[index - 12] if index >= 12 else None
        result.append(
            round(value / prior - 1, 6)
            if value is not None and prior is not None and prior != 0
            else None
        )
    return result


def fetch_series(
    config: dict[str, Any],
    source: dict[str, Any],
    end_year: int,
    fetcher: Callable[[str, str, int, int], dict[str, Any]] = api_request,
) -> dict[str, Any]:
    observations: dict[str, float] = {}
    for start, end in year_chunks(int(config["start_year"]), end_year):
        payload = fetcher(config["api_url"], source["id"], start, end)
        parsed = parse_response(payload, source["id"])
        overlap = observations.keys() & parsed.keys()
        if overlap:
            raise ValueError(f"Duplicate CPI dates returned for {source['id']}: {sorted(overlap)[:3]}")
        observations.update(parsed)
    return build_series(config, source, end_year, observations)


def build_series(
    config: dict[str, Any],
    source: dict[str, Any],
    end_year: int,
    observations: dict[str, float],
) -> dict[str, Any]:
    dates, values = complete_months(observations, int(config["start_year"]), end_year)
    observed = [value for value in values if value is not None]
    if len(dates) < 240 or len(observed) < 235:
        raise ValueError(f"{source['id']} has insufficient monthly history")
    if dates != sorted(set(dates)):
        raise ValueError(f"{source['id']} dates are not ordered and unique")
    latest_index = max(index for index, value in enumerate(values) if value is not None)
    return {
        **source,
        "frequency": "Monthly",
        "unit": "Index 1982-1984=100",
        "dates": dates,
        "values": values,
        "yoy": yoy_values(values),
        "latest_observation": dates[latest_index],
        "missing_observations": [date for date, value in zip(dates, values) if value is None],
    }


def fetch_all_series(
    config: dict[str, Any],
    end_year: int,
    bulk_fetcher: Callable[[str], str] = bulk_request,
    api_fetcher: Callable[[str, str, int, int], dict[str, Any]] = api_request,
) -> dict[str, Any]:
    try:
        bulk_payload = bulk_fetcher(config["bulk_url"])
        observations = parse_bulk_data(
            bulk_payload,
            {source["id"] for source in config["series"]},
            int(config["start_year"]),
            end_year,
        )
        return {
            source["key"]: build_series(config, source, end_year, observations[source["id"]])
            for source in config["series"]
        }
    except (OSError, RuntimeError, ValueError, UnicodeError) as bulk_error:
        try:
            return {
                source["key"]: fetch_series(config, source, end_year, api_fetcher)
                for source in config["series"]
            }
        except (OSError, RuntimeError, ValueError) as api_error:
            raise RuntimeError(
                f"BLS bulk download failed ({bulk_error}); API fallback failed ({api_error})"
            ) from api_error


def existing_bundle_sha() -> str | None:
    pointer = PUBLIC_DATA / "latest.json"
    if not pointer.exists():
        return None
    try:
        latest = json.loads(pointer.read_text())
        manifest = json.loads((PUBLIC_DATA / "releases" / latest["release"] / "manifest.json").read_text())
        return manifest.get("bundle_sha256")
    except (OSError, KeyError, json.JSONDecodeError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--end-year", type=int, default=datetime.now(timezone.utc).year)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    series = fetch_all_series(config, args.end_year)
    dataset = {
        "provider": config["provider"],
        "frequency": "Monthly",
        "data_page": config["data_page"],
        "real_value_interpolation": config.get("real_value_interpolation", []),
        "series": series,
    }
    dataset_bytes = compact_json(dataset)
    bundle_sha = hashlib.sha256(dataset_bytes).hexdigest()
    if existing_bundle_sha() == bundle_sha:
        print("BLS CPI observations are unchanged; retaining the current release.")
        return

    now = datetime.now(timezone.utc)
    release = now.strftime("%Y-%m-%d-r%H%M%S")
    manifest = {
        "release": release,
        "created_at": now.isoformat(),
        "provider": config["provider"],
        "attribution": "Consumer Price Index data provided by the U.S. Bureau of Labor Statistics.",
        "data_page": config["data_page"],
        "frequency": "Monthly",
        "real_value_interpolation": config.get("real_value_interpolation", []),
        "bundle_sha256": bundle_sha,
        "series": {
            key: {
                "id": item["id"],
                "label": item["label"],
                "latest_observation": item["latest_observation"],
                "missing_observations": item["missing_observations"],
            }
            for key, item in series.items()
        },
    }
    files = {
        "cpi.json": dataset_bytes,
        "manifest.json": compact_json(manifest),
    }
    total = sum(len(contents) for contents in files.values())
    if total > MAX_PUBLISHED_BYTES:
        raise ValueError(f"Processed CPI release is too large: {total:,} bytes")
    release_dir = PUBLIC_DATA / "releases" / release
    release_dir.mkdir(parents=True, exist_ok=False)
    for name, contents in files.items():
        (release_dir / name).write_bytes(contents)
    pointer = compact_json({"release": release, "bundle_sha256": bundle_sha})
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=PUBLIC_DATA, delete=False) as handle:
        handle.write(pointer)
        temporary_pointer = Path(handle.name)
    temporary_pointer.replace(PUBLIC_DATA / "latest.json")
    latest = ", ".join(f"{key}: {item['latest_observation']}" for key, item in series.items())
    print(f"Published BLS CPI release {release}: {latest}")


if __name__ == "__main__":
    main()
