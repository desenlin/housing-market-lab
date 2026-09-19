#!/usr/bin/env python3
"""Publish a compact, source-isolated BLS CPI release.

The lab uses the Los Angeles-area CPI-U to express local values and rents in
constant dollars and the U.S. CPI-U as a common benchmark in cross-metro
figures, and publishes component series for the Regional inflation lens.
Official BLS bulk files are preferred because they are not subject to
the Public Data API's unregistered daily query quota. The API remains a
fallback, batched within its 25-series and ten-year unregistered limits. Missing
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

try:
    from pipeline.storage import prune_releases
except ModuleNotFoundError:  # direct script execution
    from storage import prune_releases  # type: ignore[no-redef]


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


def api_request(api_url: str, series_ids: list[str], start_year: int, end_year: int) -> dict[str, Any]:
    body = compact_json({
        "seriesid": series_ids,
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
    series = [item for item in payload.get("Results", {}).get("series", [])
              if item.get("seriesID") == expected_series_id]
    if len(series) != 1:
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


def build_series(
    config: dict[str, Any],
    source: dict[str, Any],
    end_year: int,
    observations: dict[str, float],
) -> dict[str, Any]:
    dates, values = complete_months(observations, int(config["start_year"]), end_year)
    observed = [value for value in values if value is not None]
    if len(dates) < 12 or len(observed) < 10:
        raise ValueError(f"{source['id']} has insufficient current-source history")
    if dates != sorted(set(dates)):
        raise ValueError(f"{source['id']} dates are not ordered and unique")
    latest_index = max(index for index, value in enumerate(values) if value is not None)
    return {
        **source,
        "frequency": source.get("frequency", "Monthly"),
        "unit": source.get("unit", "Index 1982-1984=100"),
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
    api_fetcher: Callable[[str, list[str], int, int], dict[str, Any]] = api_request,
    source_files: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Fetch each bulk file once; batch failed groups within public API limits."""
    records = source_files if source_files is not None else []
    groups: dict[str, list[dict[str, Any]]] = {}
    for source in config["series"]:
        groups.setdefault(source.get("bulk_url", config["bulk_url"]), []).append(source)
    observations: dict[str, dict[str, float]] = {}
    fallback: list[dict[str, Any]] = []
    for url, sources in groups.items():
        ids = {source["id"] for source in sources}
        try:
            raw = bulk_fetcher(url)
            parsed = parse_bulk_data(raw, ids, int(config["start_year"]), end_year)
        except (OSError, RuntimeError, ValueError, UnicodeError):
            fallback.extend(sources)
            continue
        observations.update(parsed)
        records.append({
            "url": url, "method": "bulk", "series_ids": sorted(ids),
            "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        })
    for offset in range(0, len(fallback), 25):
        ids = [source["id"] for source in fallback[offset:offset + 25]]
        for series_id in ids:
            observations[series_id] = {}
        for start, end in year_chunks(int(config["start_year"]), end_year):
            payload = api_fetcher(config["api_url"], ids, start, end)
            for series_id in ids:
                parsed = parse_response(payload, series_id)
                if observations[series_id].keys() & parsed.keys():
                    raise ValueError(f"Duplicate CPI dates returned for {series_id}")
                observations[series_id].update(parsed)
            records.append({
                "url": config["api_url"], "method": "api", "series_ids": ids,
                "start_year": start, "end_year": end,
                "sha256": hashlib.sha256(compact_json(payload)).hexdigest(),
            })
    return {
        source["key"]: build_series(config, source, end_year, observations[source["id"]])
        for source in config["series"]
    }


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


def load_current_dataset() -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    pointer = PUBLIC_DATA / "latest.json"
    if not pointer.exists():
        return None, None
    try:
        release = json.loads(pointer.read_text())["release"]
        root = PUBLIC_DATA / "releases" / release
        return (
            json.loads((root / "cpi.json").read_text()),
            json.loads((root / "manifest.json").read_text()),
        )
    except (OSError, KeyError, json.JSONDecodeError):
        return None, None


def merge_cpi_history(
    previous: dict[str, Any] | None, incoming: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not previous:
        return incoming, {"truncated_series": {}}
    merged = {**previous, **incoming, "series": {}}
    truncated = {}
    for key, current in incoming["series"].items():
        prior = previous.get("series", {}).get(key)
        if not prior:
            merged["series"][key] = current
            continue
        dates = sorted(set(prior["dates"]) | set(current["dates"]))
        prior_by_date = dict(zip(prior["dates"], prior["values"]))
        current_by_date = dict(zip(current["dates"], current["values"]))
        current_dates = set(current["dates"])
        values = [
            current_by_date.get(date) if date in current_dates else prior_by_date.get(date)
            for date in dates
        ]
        observed = [index for index, value in enumerate(values) if value is not None]
        if prior["dates"] and current["dates"] and prior["dates"][0] < current["dates"][0]:
            truncated[key] = {
                "incoming_start": current["dates"][0],
                "preserved_start": prior["dates"][0],
            }
        merged["series"][key] = {
            **prior,
            **current,
            "dates": dates,
            "values": values,
            "yoy": yoy_values(values),
            "latest_observation": dates[observed[-1]],
            "missing_observations": [
                date for date, value in zip(dates, values) if value is None
            ],
        }
    return merged, {"truncated_series": truncated}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--end-year", type=int, default=datetime.now(timezone.utc).year)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    source_files: list[dict[str, Any]] = []
    incoming = {
        "provider": config["provider"],
        "frequency": "Monthly",
        "data_page": config["data_page"],
        "real_value_interpolation": config.get("real_value_interpolation", []),
        "categories": config.get("categories", []),
        "series": fetch_all_series(config, args.end_year, source_files=source_files),
    }
    previous, previous_manifest = load_current_dataset()
    dataset, history_report = merge_cpi_history(previous, incoming)
    series = dataset["series"]
    for item in series.values():
        if len(item["dates"]) < 240 or sum(value is not None for value in item["values"]) < 235:
            raise ValueError(f"{item['id']} has insufficient retained monthly history")
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
        "storage_schema_version": 3,
        "source_files": source_files,
        "categories": config.get("categories", []),
        "real_value_interpolation": config.get("real_value_interpolation", []),
        "bundle_sha256": bundle_sha,
        "history_policy": {
            "strategy": "merge_forward",
            "previous_release": previous_manifest.get("release") if previous_manifest else None,
            "report": history_report,
        },
        "series": {
            key: {
                "id": item["id"],
                "label": item["label"],
                "area_key": item.get("area_key"),
                "category": item.get("category"),
                "first_observation": item["dates"][0],
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
    removed = prune_releases(PUBLIC_DATA, int(config["keep_releases"]))
    latest = ", ".join(f"{key}: {item['latest_observation']}" for key, item in series.items())
    suffix = f"; pruned {', '.join(removed)}" if removed else ""
    print(f"Published BLS CPI release {release}: {latest}{suffix}")


if __name__ == "__main__":
    main()
