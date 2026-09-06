#!/usr/bin/env python3
"""Publish compact, independently versioned Realtor.com ZIP releases.

The provider files are large national histories. They are streamed directly,
never saved to disk, and filtered against the lab's existing two-county ZCTA
boundary reference. Inventory and Hotness use separate pointers because their
release dates can differ. A small release history is retained for rollback.
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
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "realtor_sources.json"
PUBLIC_DATA = ROOT / "public" / "data" / "realtor"
ZILLOW_PUBLIC_DATA = ROOT / "public" / "data"
USER_AGENT = "housing-market-lab/0.4 academic research"
MISSING = {"", "NA", "N/A", "NULL", "null", "-"}
SCHEMA_VERSION = 3


def compact_json(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def parse_value(raw: str | None, decimals: int) -> int | float | None:
    if raw is None or raw.strip() in MISSING:
        return None
    value = float(raw)
    if not math.isfinite(value):
        return None
    return int(round(value)) if decimals == 0 else round(value, decimals)


def compact_series(values: list[int | float | None]) -> list[Any] | dict[str, Any]:
    observed = [index for index, value in enumerate(values) if value is not None]
    if not observed:
        return []
    start, end = observed[0], observed[-1] + 1
    trimmed = values[start:end]
    return trimmed if start == 0 and end == len(values) else {"o": start, "v": trimmed}


def month_date(raw: str) -> str:
    value = raw.strip()
    if len(value) != 6 or not value.isdigit() or not 1 <= int(value[4:]) <= 12:
        raise ValueError(f"Invalid Realtor.com month: {raw!r}")
    return f"{value[:4]}-{value[4:]}-01"


def load_zip_reference() -> dict[str, dict[str, str | None]]:
    pointer = json.loads((ZILLOW_PUBLIC_DATA / "latest.json").read_text())
    release_dir = ZILLOW_PUBLIC_DATA / "releases" / pointer["release"]
    zip_map = json.loads((release_dir / "map-zip.json").read_text())
    zip_data = json.loads((release_dir / "zip.json").read_text())
    context_by_zip = {
        str(region["name"]).zfill(5): region.get("context")
        for region in zip_data["regions"]
    }
    reference: dict[str, dict[str, str | None]] = {}
    for county, county_map in zip_map["counties"].items():
        for region in county_map["regions"]:
            postal_code = str(region["name"]).zfill(5)
            reference[postal_code] = {
                "id": region["id"],
                "name": postal_code,
                "county": county,
                "context": context_by_zip.get(postal_code),
            }
    return reference


def product_url(product: dict[str, Any]) -> str:
    return os.environ.get(f"REALTOR_{product['key'].upper()}_URL") or product["url"]


def request(url: str, method: str = "GET"):
    return urllib.request.urlopen(
        urllib.request.Request(
            url,
            method=method,
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"},
        ),
        timeout=180,
    )


def source_metadata(product: dict[str, Any]) -> dict[str, Any]:
    url = product_url(product)
    with request(url, "HEAD") as response:
        declared_bytes = int(response.headers.get("Content-Length") or 0)
        if declared_bytes and declared_bytes > int(product["max_source_bytes"]):
            raise ValueError(
                f"{product['key']} is unexpectedly large: {declared_bytes:,} bytes"
            )
        return {
            "url": url,
            "bytes": declared_bytes,
            "etag": response.headers.get("ETag", "").strip(),
            "last_modified": response.headers.get("Last-Modified", "").strip(),
        }


def current_manifest(product_key: str) -> dict[str, Any] | None:
    pointer = PUBLIC_DATA / product_key / "latest.json"
    if not pointer.exists():
        return None
    try:
        release = json.loads(pointer.read_text())["release"]
        path = PUBLIC_DATA / product_key / "releases" / release / "manifest.json"
        return json.loads(path.read_text())
    except (OSError, KeyError, json.JSONDecodeError):
        return None


def source_is_unchanged(existing: dict[str, Any] | None, source: dict[str, Any]) -> bool:
    if not existing or existing.get("schema_version") != SCHEMA_VERSION:
        return False
    previous = existing.get("source", {})
    if source["etag"] and previous.get("etag"):
        return source["etag"] == previous["etag"]
    return bool(
        source["last_modified"]
        and source["bytes"]
        and source["last_modified"] == previous.get("last_modified")
        and source["bytes"] == previous.get("bytes")
    )


def stream_selected_rows(
    rows: Iterable[dict[str, str]],
    product: dict[str, Any],
    metric_config: dict[str, dict[str, Any]],
    reference: dict[str, dict[str, str | None]],
    start_month: str,
) -> tuple[
    dict[str, dict[str, dict[str, int | float | None]]], set[str], int, int
]:
    selected: dict[str, dict[str, dict[str, int | float | None]]] = defaultdict(dict)
    dates: set[str] = set()
    scanned = 0
    flagged = 0
    for row in rows:
        scanned += 1
        raw_postal_code = (row.get("postal_code") or "").strip().split(".")[0]
        postal_code = raw_postal_code.zfill(5)
        target = reference.get(postal_code)
        if not target:
            continue
        date = month_date(row.get("month_date_yyyymm") or "")
        if date[:7] < start_month:
            continue
        is_flagged = (row.get("quality_flag") or "0").strip() not in {"", "0", "0.0"}
        if is_flagged:
            flagged += 1
        values = {
            metric: parse_value(
                row.get(metric_config[metric]["field"]),
                int(metric_config[metric]["decimals"]),
            )
            for metric in product["metrics"]
        }
        values["__quality_flag"] = int(is_flagged)
        selected[str(target["id"])][date] = values
        dates.add(date)
    return selected, dates, scanned, flagged


def fetch_product(
    config: dict[str, Any],
    product: dict[str, Any],
    reference: dict[str, dict[str, str | None]],
    source: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    with request(source["url"]) as response:
        declared_bytes = int(response.headers.get("Content-Length") or 0)
        if declared_bytes and declared_bytes > int(product["max_source_bytes"]):
            raise ValueError(
                f"{product['key']} is unexpectedly large: {declared_bytes:,} bytes"
            )
        text = io.TextIOWrapper(response, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        required = {"month_date_yyyymm", "postal_code", "quality_flag"}
        required.update(config["metrics"][metric]["field"] for metric in product["metrics"])
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{product['key']} missing columns: {sorted(missing)}")
        selected, date_set, scanned, flagged = stream_selected_rows(
            reader,
            product,
            config["metrics"],
            reference,
            config["start_date"],
        )

    dates = sorted(date_set)
    metrics = {
        metric: {
            "dates": dates,
            "label": config["metrics"][metric]["label"],
            "short_label": config["metrics"][metric]["short_label"],
            "unit": config["metrics"][metric]["unit"],
            "decimals": config["metrics"][metric]["decimals"],
            "definition": config["metrics"][metric]["definition"],
            "provider": config["provider"],
            "frequency": "Monthly",
            "source_product": product["key"],
            "change_mode": config["metrics"][metric]["change_mode"],
        }
        for metric in product["metrics"]
    }
    by_id = {str(item["id"]): item for item in reference.values()}
    regions = []
    for region_id, observations in selected.items():
        series = {
            metric: compact_series(
                [observations.get(date, {}).get(metric) for date in dates]
            )
            for metric in product["metrics"]
        }
        if any(value for value in series.values()):
            quality_indices = [
                index
                for index, date in enumerate(dates)
                if observations.get(date, {}).get("__quality_flag") == 1
            ]
            regions.append({
                **by_id[region_id],
                "series": series,
                "quality": {product["key"]: quality_indices},
            })
    regions.sort(key=lambda item: (str(item["county"]), str(item["name"])))
    payload = {
        "geography": "zip",
        "provider": config["provider"],
        "product": product["key"],
        "metrics": metrics,
        "regions": regions,
    }
    source.update(
        {
            "latest_observation": dates[-1] if dates else "",
            "rows_scanned": scanned,
            "regions": len(regions),
            "flagged_local_rows_retained": flagged,
        }
    )
    return payload, source


def validate_payload(payload: dict[str, Any], product: dict[str, Any]) -> None:
    if set(payload["metrics"]) != set(product["metrics"]):
        raise ValueError(f"{product['key']} metric contract changed")
    if len(payload["regions"]) < 150:
        raise ValueError(
            f"{product['key']} coverage dropped to {len(payload['regions'])} ZIP codes"
        )
    for metric, metadata in payload["metrics"].items():
        if len(metadata["dates"]) < 60:
            raise ValueError(f"{product['key']}/{metric} has fewer than 60 months")
        if metadata["dates"] != sorted(set(metadata["dates"])):
            raise ValueError(f"{product['key']}/{metric} dates are not ordered and unique")
    date_count = len(next(iter(payload["metrics"].values()))["dates"])
    for region in payload["regions"]:
        indices = region.get("quality", {}).get(product["key"], [])
        if indices != sorted(set(indices)) or any(
            not isinstance(index, int) or index < 0 or index >= date_count
            for index in indices
        ):
            raise ValueError(f"{product['key']}/{region['id']} has invalid quality indices")


def bundle_sha(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(files[name])
    return digest.hexdigest()


def prune_releases(product_root: Path, keep: int) -> list[str]:
    releases_root = product_root / "releases"
    if not releases_root.exists():
        return []
    releases = sorted(path for path in releases_root.iterdir() if path.is_dir())
    removed = releases[:-keep] if len(releases) > keep else []
    for path in removed:
        shutil.rmtree(path)
    return [path.name for path in removed]


def publish_product(
    config: dict[str, Any],
    product: dict[str, Any],
    reference: dict[str, dict[str, str | None]],
) -> str:
    source = source_metadata(product)
    existing = current_manifest(product["key"])
    if source_is_unchanged(existing, source):
        print(f"{product['key']}: upstream file unchanged; retaining validated release")
        return "unchanged"

    payload, source = fetch_product(config, product, reference, source)
    validate_payload(payload, product)
    files = {"zip.json": compact_json(payload)}
    digest = bundle_sha(files)
    release = datetime.now(timezone.utc).strftime("%Y-%m-%d-r%H%M%S")
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "release": release,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "provider": config["provider"],
        "product": product["key"],
        "attribution": "Data provided by Realtor.com® Economic Research.",
        "data_page": config["data_page"],
        "methodology_page": config["methodology_page"],
        "frequency": "Monthly",
        "start_date": config["start_date"],
        "bundle_sha256": digest,
        "counts": {"zip": len(payload["regions"])},
        "latest_observations": {
            metric: metadata["dates"][-1]
            for metric, metadata in payload["metrics"].items()
        },
        "source": source,
        "retained_releases": int(config["keep_releases"]),
    }
    files["manifest.json"] = compact_json(manifest)
    total = sum(len(contents) for contents in files.values())
    if total > int(config["max_published_bytes_per_product"]):
        raise ValueError(
            f"Processed {product['key']} release is too large: {total:,} bytes"
        )

    product_root = PUBLIC_DATA / product["key"]
    release_dir = product_root / "releases" / release
    release_dir.mkdir(parents=True, exist_ok=False)
    for name, contents in files.items():
        (release_dir / name).write_bytes(contents)
    pointer = compact_json({"release": release, "bundle_sha256": digest})
    product_root.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=product_root, delete=False) as handle:
        handle.write(pointer)
        temporary_pointer = Path(handle.name)
    temporary_pointer.replace(product_root / "latest.json")
    removed = prune_releases(product_root, int(config["keep_releases"]))
    suffix = f"; pruned {', '.join(removed)}" if removed else ""
    print(
        f"Published Realtor.com {product['key']} release {release}: "
        f"{len(payload['regions'])} ZIP codes, {total:,} bytes{suffix}"
    )
    return "published"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    reference = load_zip_reference()
    failures = []
    for product in config["products"]:
        try:
            publish_product(config, product, reference)
        except Exception as caught:  # retain the other product's prior pointer
            failures.append(f"{product['key']}: {caught}")
            print(f"WARNING: Realtor.com {product['key']} refresh failed: {caught}")
    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
