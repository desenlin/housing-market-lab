#!/usr/bin/env python3
"""Publish a compact, source-isolated Redfin activity release.

The source CSVs contain national city/ZIP observations and are ordered newest
first. The parser streams them, retains only local geographies in the two study
counties, and stops after the configured historical cutoff. City/community
coverage comes from Census place boundaries rather than another data provider.
Raw files are never committed or retained.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import shutil
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from pipeline.storage import (
        atomic_write, bundle_sha, dataset_shards, load_dataset_release,
        load_map_release, merge_dataset_history, prune_releases,
    )
except ModuleNotFoundError:  # direct script execution
    from storage import (  # type: ignore[no-redef]
        atomic_write, bundle_sha, dataset_shards, load_dataset_release,
        load_map_release, merge_dataset_history, prune_releases,
    )


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "redfin_sources.json"
PUBLIC_DATA = ROOT / "public" / "data" / "redfin"
ZILLOW_PUBLIC_DATA = ROOT / "public" / "data"
USER_AGENT = "housing-market-lab/0.3 academic research"
MISSING = {"", "NA", "N/A", "NULL", "null", "-"}


def compact_json(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def parse_value(raw: str | None, decimals: int, scale: float = 1.0) -> int | float | None:
    if raw is None or raw.strip() in MISSING:
        return None
    value = float(raw) * scale
    if not math.isfinite(value):
        return None
    return int(round(value)) if decimals == 0 else round(value, decimals)


def compact_series(values: list[int | float | None]) -> list[Any] | dict[str, Any]:
    non_missing = [index for index, value in enumerate(values) if value is not None]
    if not non_missing:
        return []
    start, end = non_missing[0], non_missing[-1] + 1
    trimmed = values[start:end]
    return trimmed if start == 0 and end == len(values) else {"o": start, "v": trimmed}


def load_local_reference() -> dict[str, dict[str, dict[str, str | None]]]:
    city_map = load_map_release(ZILLOW_PUBLIC_DATA / "maps", "city")
    if city_map is None:
        pointer = json.loads((ZILLOW_PUBLIC_DATA / "latest.json").read_text())
        release_dir = ZILLOW_PUBLIC_DATA / "releases" / pointer["release"]
        city_map = json.loads((release_dir / "map-city.json").read_text())
    reference: dict[str, dict[str, dict[str, str | None]]] = {"city": {}}
    for county, county_map in city_map["counties"].items():
        for region in county_map["regions"]:
            reference["city"][f"{region['name']}, CA"] = {
                "id": region["id"],
                "name": region["name"],
                "county": county,
                "context": None,
            }

    # Zillow's county-labelled ZIP table remains the curated assignment source
    # because ZCTAs can cross county lines and do not nest within counties.
    zip_payload, _ = load_dataset_release(ZILLOW_PUBLIC_DATA, "zip")
    if zip_payload is None:
        raise RuntimeError("No validated Zillow ZIP reference is available")
    reference["zip"] = {
        region["name"]: {
            "id": f"zcta:{region['name']}",
            "name": region["name"],
            "county": region["county"],
            "context": region.get("context"),
        }
        for region in zip_payload["regions"]
    }
    return reference


def source_url(config: dict[str, Any], source: dict[str, Any]) -> str:
    override = os.environ.get(f"REDFIN_{source['key'].upper()}_URL")
    return override or f"{config['source_root'].rstrip('/')}/{source['path']}"


def request(url: str):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=120
    )


def stream_selected_rows(
    rows: Iterable[dict[str, str]],
    source: dict[str, Any],
    metric_config: dict[str, dict[str, Any]],
    reference: dict[str, dict[str, str | None]],
    start_date: str,
) -> tuple[dict[str, dict[str, dict[str, int | float | None]]], str, int]:
    """Return region -> date -> metric values from newest-first Redfin rows."""
    selected: dict[str, dict[str, dict[str, int | float | None]]] = defaultdict(dict)
    selected_weight: dict[tuple[str, str], float] = {}
    previous_date = "9999-99-99"
    latest = ""
    scanned = 0
    for row in rows:
        scanned += 1
        period_end = (row.get("PERIOD END") or "").strip()
        if not period_end:
            continue
        if period_end > previous_date:
            raise ValueError(f"{source['key']} is not ordered newest first at {period_end}")
        previous_date = period_end
        latest = max(latest, period_end)
        if period_end < start_date:
            break
        if (row.get("FREQUENCY") or "").strip() != "Rolling 3 Months":
            continue
        region_name = (row.get("REGION NAME") or "").strip()
        target = reference.get(region_name)
        if not target:
            continue
        target_id = str(target["id"])
        weight = parse_value(row.get(source["selection_weight"]), 5) or 0.0
        key = (target_id, period_end)
        # Duplicate provider names are resolved to the row representing the
        # larger market observation; this is deterministic and avoids summing
        # medians or shares.
        if key in selected_weight and float(weight) < selected_weight[key]:
            continue
        values: dict[str, int | float | None] = {}
        for metric in source["metrics"]:
            metadata = metric_config[metric]
            values[metric] = parse_value(
                row.get(metadata["field"]),
                int(metadata["decimals"]),
                float(metadata.get("scale", 1.0)),
            )
        selected[target_id][period_end] = values
        selected_weight[key] = float(weight)
    return selected, latest, scanned


def fetch_source(
    config: dict[str, Any],
    source: dict[str, Any],
    reference: dict[str, dict[str, str | None]],
) -> tuple[dict[str, dict[str, dict[str, int | float | None]]], dict[str, Any]]:
    url = source_url(config, source)
    with request(url) as response:
        declared_bytes = int(response.headers.get("Content-Length") or 0)
        if declared_bytes and declared_bytes > int(config["max_source_bytes"]):
            raise ValueError(f"{source['key']} is unexpectedly large: {declared_bytes:,} bytes")
        text = io.TextIOWrapper(response, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        required = {"FREQUENCY", "PERIOD END", "REGION NAME", source["selection_weight"]}
        required.update(config["metrics"][metric]["field"] for metric in source["metrics"])
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{source['key']} missing columns: {sorted(missing)}")
        rows, latest, scanned = stream_selected_rows(
            reader,
            source,
            config["metrics"],
            reference,
            config["start_date"],
        )
    return rows, {
        "url": url,
        "bytes": declared_bytes,
        "latest_observation": latest,
        "rows_scanned": scanned,
        "regions": len(rows),
    }


def combine_geography(
    geography: str,
    source_results: list[tuple[dict[str, dict[str, dict[str, int | float | None]]], dict[str, Any]]],
    reference: dict[str, dict[str, str | None]],
    metric_config: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    metric_dates: dict[str, set[str]] = defaultdict(set)
    merged: dict[str, dict[str, dict[str, int | float | None]]] = defaultdict(lambda: defaultdict(dict))
    for rows, _metadata in source_results:
        for region_id, observations in rows.items():
            for date, values in observations.items():
                for metric, value in values.items():
                    merged[region_id][metric][date] = value
                    metric_dates[metric].add(date)
    metrics: dict[str, Any] = {}
    ordered_dates: dict[str, list[str]] = {}
    for metric, dates in metric_dates.items():
        ordered_dates[metric] = sorted(dates)
        metadata = metric_config[metric]
        metrics[metric] = {
            "dates": ordered_dates[metric],
            "label": metadata["label"],
            "short_label": metadata["short_label"],
            "unit": metadata["unit"],
            "decimals": metadata["decimals"],
            "definition": metadata["definition"],
            "provider": "Redfin",
            "frequency": "Rolling 3 Months",
            "change_mode": metadata["change_mode"],
        }
    by_id = {str(item["id"]): item for item in reference.values()}
    regions = []
    for region_id, metric_values in merged.items():
        item = by_id[region_id]
        series = {
            metric: compact_series([metric_values.get(metric, {}).get(date) for date in dates])
            for metric, dates in ordered_dates.items()
        }
        if any(value for value in series.values()):
            regions.append({**item, "series": series})
    regions.sort(key=lambda item: (str(item["county"]), str(item["name"])))
    return {"geography": geography, "provider": "Redfin", "metrics": metrics, "regions": regions}


def validate_payloads(payloads: dict[str, dict[str, Any]], config: dict[str, Any]) -> None:
    required_metrics = set(config["metrics"])
    minimums = {"city": 45, "zip": 160}
    for geography, payload in payloads.items():
        missing = required_metrics.difference(payload["metrics"])
        if missing:
            raise ValueError(f"{geography} missing Redfin metrics: {sorted(missing)}")
        if len(payload["regions"]) < minimums[geography]:
            raise ValueError(
                f"{geography} Redfin coverage dropped to {len(payload['regions'])}; "
                f"expected at least {minimums[geography]}"
            )
        for metric, metadata in payload["metrics"].items():
            if len(metadata["dates"]) < 60:
                raise ValueError(f"{geography}/{metric} has fewer than 60 monthly observations")
            if metadata["dates"] != sorted(set(metadata["dates"])):
                raise ValueError(f"{geography}/{metric} dates are not ordered and unique")


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


def publish_release(
    root: Path,
    release: str,
    digest: str,
    files: dict[str, bytes],
    keep: int,
) -> list[str]:
    """Promote a complete release without leaving an orphan on failure."""
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest.lower())
    ):
        raise ValueError("Redfin bundle digest must be a SHA-256 hex string")

    pointer = compact_json({"release": release, "bundle_sha256": digest})
    release_dir = root / "releases" / release
    release_created = False
    try:
        release_dir.mkdir(parents=True, exist_ok=False)
        release_created = True
        for name, contents in files.items():
            (release_dir / name).write_bytes(contents)
        atomic_write(root / "latest.json", pointer)
    except Exception:
        if release_created:
            shutil.rmtree(release_dir, ignore_errors=True)
        raise
    return prune_releases(root, keep)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    reference = load_local_reference()
    grouped: dict[str, list[Any]] = {"city": [], "zip": []}
    source_manifest: dict[str, Any] = {}
    for source in config["sources"]:
        result = fetch_source(config, source, reference[source["geography"]])
        grouped[source["geography"]].append(result)
        source_manifest[source["key"]] = result[1]
        print(
            f"{source['key']}: {result[1]['regions']} retained regions, "
            f"latest {result[1]['latest_observation']}"
        )
    incoming_payloads = {
        geography: combine_geography(
            geography, results, reference[geography], config["metrics"]
        )
        for geography, results in grouped.items()
    }
    payloads = {}
    history_reports = {}
    prior_release = None
    for geography, incoming in incoming_payloads.items():
        previous, previous_manifest = load_dataset_release(PUBLIC_DATA, geography)
        if previous_manifest:
            prior_release = previous_manifest.get("release")
        payloads[geography], history_reports[geography] = merge_dataset_history(
            previous, incoming
        )
    validate_payloads(payloads, config)
    files: dict[str, bytes] = {}
    file_index: dict[str, list[str]] = {}
    for geography, payload in payloads.items():
        shards, names = dataset_shards(payload)
        files.update(shards)
        file_index[geography] = names
    digest = bundle_sha(files)
    if existing_bundle_sha() == digest:
        print("Redfin observations are unchanged; retaining the current release.")
        return
    release = datetime.now(timezone.utc).strftime("%Y-%m-%d-r%H%M%S")
    manifest = {
        "release": release,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "provider": config["provider"],
        "attribution": "Data provided by Redfin, a national real estate brokerage.",
        "data_page": config["data_page"],
        "methodology_page": config["methodology_page"],
        "frequency": "Rolling 3 Months",
        "start_date": config["start_date"],
        "storage_schema_version": 2,
        "bundle_sha256": digest,
        "files": file_index,
        "history_policy": {
            "strategy": "merge_forward",
            "previous_release": prior_release,
            "reports": history_reports,
        },
        "counts": {key: len(value["regions"]) for key, value in payloads.items()},
        "latest_observations": {
            f"{geography}_{metric}": metadata["dates"][-1]
            for geography, payload in payloads.items()
            for metric, metadata in payload["metrics"].items()
        },
        "sources": source_manifest,
    }
    files["manifest.json"] = compact_json(manifest)
    total = sum(len(value) for value in files.values())
    if total > int(config["max_published_bytes_per_release"]):
        raise ValueError(f"Processed Redfin release is too large: {total:,} bytes")
    removed = publish_release(
        PUBLIC_DATA,
        release,
        digest,
        files,
        int(config["keep_releases"]),
    )
    suffix = f"; pruned {', '.join(removed)}" if removed else ""
    print(f"Published Redfin release {release}: {total:,} bytes{suffix}")


if __name__ == "__main__":
    main()
