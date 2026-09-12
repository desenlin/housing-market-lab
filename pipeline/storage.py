"""Shared compact-release storage and history-preservation helpers."""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any


COUNTY_SLUGS = {
    "Los Angeles County": "los-angeles",
    "Orange County": "orange",
}


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def compact_json(payload: Any) -> bytes:
    return json.dumps(
        payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False
    ).encode("utf-8")


def bundle_sha(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(files[name])
    return digest.hexdigest()


def expand_series(series: list[Any] | dict[str, Any] | None, length: int) -> list[Any]:
    if series is None:
        return [None] * length
    if isinstance(series, list):
        return [*series, *([None] * max(0, length - len(series)))][:length]
    values = [None] * length
    offset = int(series.get("o", 0))
    for index, value in enumerate(series.get("v", [])):
        if 0 <= offset + index < length:
            values[offset + index] = value
    return values


def compact_series(values: list[Any]) -> list[Any] | dict[str, Any]:
    observed = [index for index, value in enumerate(values) if value is not None]
    if not observed:
        return []
    start, end = observed[0], observed[-1] + 1
    trimmed = values[start:end]
    return trimmed if start == 0 and end == len(values) else {"o": start, "v": trimmed}


def _quality_dates(dataset: dict[str, Any], quality_key: str) -> list[str]:
    for metadata in dataset.get("metrics", {}).values():
        if metadata.get("source_product") == quality_key:
            return metadata.get("dates", [])
    metrics = list(dataset.get("metrics", {}).values())
    return metrics[0].get("dates", []) if metrics else []


def merge_dataset_history(
    previous: dict[str, Any] | None,
    incoming: dict[str, Any],
    *,
    allowed_region_names: set[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Merge a new provider snapshot over a retained compact history.

    Incoming values govern every date the current provider file contains,
    including explicit nulls and revisions. Prior values are used only for
    dates absent from the current file, or for a previously observed region
    omitted entirely from the current file. This preserves truncated history
    without masking a provider's current missing-value signal.
    """
    if not previous:
        return incoming, {"preserved_values": 0, "truncated_metrics": {}}
    if previous.get("geography") != incoming.get("geography"):
        raise ValueError("cannot merge different geographies")

    previous = deepcopy(previous)
    incoming = deepcopy(incoming)
    metrics: dict[str, Any] = {}
    truncated: dict[str, Any] = {}
    for metric in sorted(set(previous.get("metrics", {})) | set(incoming.get("metrics", {}))):
        prior_meta = previous.get("metrics", {}).get(metric, {})
        current_meta = incoming.get("metrics", {}).get(metric, {})
        prior_dates = prior_meta.get("dates", [])
        current_dates = current_meta.get("dates", [])
        dates = sorted(set(prior_dates) | set(current_dates))
        metrics[metric] = {**prior_meta, **current_meta, "dates": dates}
        if prior_dates and current_dates and prior_dates[0] < current_dates[0]:
            truncated[metric] = {
                "incoming_start": current_dates[0],
                "preserved_start": prior_dates[0],
                "retained_dates": sum(date < current_dates[0] for date in prior_dates),
            }

    previous_regions = {
        str(region["id"]): region
        for region in previous.get("regions", [])
        if allowed_region_names is None or region.get("name") in allowed_region_names
    }
    incoming_regions = {str(region["id"]): region for region in incoming.get("regions", [])}
    preserved_values = 0
    regions = []
    for region_id in sorted(set(previous_regions) | set(incoming_regions)):
        prior_region = previous_regions.get(region_id)
        current_region = incoming_regions.get(region_id)
        metadata = {
            key: value
            for key, value in {**(prior_region or {}), **(current_region or {})}.items()
            if key not in {"series", "quality"}
        }
        series: dict[str, Any] = {}
        for metric, merged_meta in metrics.items():
            dates = merged_meta["dates"]
            prior_dates = previous.get("metrics", {}).get(metric, {}).get("dates", [])
            current_dates = incoming.get("metrics", {}).get(metric, {}).get("dates", [])
            prior_values = expand_series(
                (prior_region or {}).get("series", {}).get(metric), len(prior_dates)
            )
            current_values = expand_series(
                (current_region or {}).get("series", {}).get(metric), len(current_dates)
            )
            prior_by_date = dict(zip(prior_dates, prior_values))
            current_by_date = dict(zip(current_dates, current_values))
            current_date_set = set(current_dates)
            values = []
            for date in dates:
                if current_region is not None and date in current_date_set:
                    value = current_by_date.get(date)
                else:
                    value = prior_by_date.get(date)
                    preserved_values += int(value is not None)
                values.append(value)
            series[metric] = compact_series(values)
        metadata["series"] = series

        quality: dict[str, list[int]] = {}
        quality_keys = set((prior_region or {}).get("quality", {})) | set(
            (current_region or {}).get("quality", {})
        )
        for quality_key in quality_keys:
            prior_dates = _quality_dates(previous, quality_key)
            current_dates = _quality_dates(incoming, quality_key)
            dates = sorted(set(prior_dates) | set(current_dates))
            prior_flags = {
                prior_dates[index]
                for index in (prior_region or {}).get("quality", {}).get(quality_key, [])
                if 0 <= index < len(prior_dates)
            }
            current_flags = {
                current_dates[index]
                for index in (current_region or {}).get("quality", {}).get(quality_key, [])
                if 0 <= index < len(current_dates)
            }
            current_date_set = set(current_dates)
            flags = [
                index
                for index, date in enumerate(dates)
                if (
                    date in current_flags
                    if current_region is not None and date in current_date_set
                    else date in prior_flags
                )
            ]
            quality[quality_key] = flags
        if quality_keys:
            metadata["quality"] = quality
        regions.append(metadata)

    regions.sort(key=lambda item: (str(item.get("county") or ""), str(item.get("name") or "")))
    merged = {**previous, **incoming, "metrics": metrics, "regions": regions}
    return merged, {
        "preserved_values": preserved_values,
        "truncated_metrics": truncated,
    }


def merge_uniform_history(
    previous: dict[str, Any] | None, incoming: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Merge datasets whose metrics share one top-level date calendar."""
    if not previous:
        return incoming, {"preserved_values": 0, "truncated": False}
    if previous.get("geography") != incoming.get("geography"):
        raise ValueError("cannot merge different geographies")
    prior_dates = previous.get("dates", [])
    current_dates = incoming.get("dates", [])
    dates = sorted(set(prior_dates) | set(current_dates))
    current_date_set = set(current_dates)
    previous_regions = {str(region["id"]): region for region in previous.get("regions", [])}
    incoming_regions = {str(region["id"]): region for region in incoming.get("regions", [])}
    metrics = sorted(set(previous.get("metrics", {})) | set(incoming.get("metrics", {})))
    preserved_values = 0
    regions = []
    for region_id in sorted(set(previous_regions) | set(incoming_regions)):
        prior_region = previous_regions.get(region_id)
        current_region = incoming_regions.get(region_id)
        output = {
            key: value
            for key, value in {**(prior_region or {}), **(current_region or {})}.items()
            if key not in {"series", "quality"}
        }
        output["series"] = {}
        for metric in metrics:
            prior_values = expand_series(
                (prior_region or {}).get("series", {}).get(metric), len(prior_dates)
            )
            current_values = expand_series(
                (current_region or {}).get("series", {}).get(metric), len(current_dates)
            )
            prior_by_date = dict(zip(prior_dates, prior_values))
            current_by_date = dict(zip(current_dates, current_values))
            values = []
            for date in dates:
                if current_region is not None and date in current_date_set:
                    value = current_by_date.get(date)
                else:
                    value = prior_by_date.get(date)
                    preserved_values += int(value is not None)
                values.append(value)
            output["series"][metric] = values
        prior_quality = (prior_region or {}).get("quality", {})
        current_quality = (current_region or {}).get("quality", {})
        if prior_quality or current_quality:
            prior_imputed = {
                prior_dates[index]
                for index in prior_quality.get("imputed", [])
                if 0 <= index < len(prior_dates)
            }
            current_imputed = {
                current_dates[index]
                for index in current_quality.get("imputed", [])
                if 0 <= index < len(current_dates)
            }
            prior_codes = {
                prior_dates[int(index)]: value
                for index, value in prior_quality.get("source_codes", {}).items()
                if 0 <= int(index) < len(prior_dates)
            }
            current_codes = {
                current_dates[int(index)]: value
                for index, value in current_quality.get("source_codes", {}).items()
                if 0 <= int(index) < len(current_dates)
            }
            prior_months = dict(zip(prior_dates, prior_quality.get("months_reported", [])))
            current_months = dict(zip(current_dates, current_quality.get("months_reported", [])))
            imputed = []
            source_codes = {}
            months_reported = []
            for index, date in enumerate(dates):
                use_current = current_region is not None and date in current_date_set
                if date in (current_imputed if use_current else prior_imputed):
                    imputed.append(index)
                code = (current_codes if use_current else prior_codes).get(date)
                if code is not None:
                    source_codes[str(index)] = code
                months_reported.append(
                    (current_months if use_current else prior_months).get(date)
                )
            output["quality"] = {
                "imputed": imputed,
                "source_codes": source_codes,
                "months_reported": months_reported,
            }
        regions.append(output)
    regions.sort(key=lambda item: (str(item.get("county") or ""), str(item.get("name") or "")))
    return (
        {
            **previous,
            **incoming,
            "dates": dates,
            "metrics": {**previous.get("metrics", {}), **incoming.get("metrics", {})},
            "regions": regions,
        },
        {
            "preserved_values": preserved_values,
            "truncated": bool(prior_dates and current_dates and prior_dates[0] < current_dates[0]),
        },
    )


def dataset_shards(dataset: dict[str, Any]) -> tuple[dict[str, bytes], list[str]]:
    geography = str(dataset["geography"])
    if geography == "metro":
        name = "metro.json"
        return {name: compact_json(dataset)}, [name]
    files: dict[str, bytes] = {}
    names: list[str] = []
    counties = sorted({str(region.get("county")) for region in dataset["regions"]})
    for county in counties:
        slug = COUNTY_SLUGS.get(county)
        if not slug:
            raise ValueError(f"no storage slug configured for {county}")
        name = f"{geography}-{slug}.json"
        shard = {
            **dataset,
            "regions": [region for region in dataset["regions"] if region.get("county") == county],
        }
        files[name] = compact_json(shard)
        names.append(name)
    return files, names


def map_shards(maps: dict[str, dict[str, Any]]) -> tuple[dict[str, bytes], dict[str, list[str]]]:
    files: dict[str, bytes] = {}
    file_index: dict[str, list[str]] = {}
    for geography, dataset in maps.items():
        names = []
        for county, details in sorted(dataset["counties"].items()):
            slug = COUNTY_SLUGS.get(county)
            if not slug:
                raise ValueError(f"no storage slug configured for {county}")
            name = f"{geography}-{slug}.json"
            files[name] = compact_json(
                {"geography": geography, "counties": {county: details}}
            )
            names.append(name)
        file_index[geography] = names
    return files, file_index


def combine_dataset_shards(shards: list[dict[str, Any]]) -> dict[str, Any]:
    if not shards:
        raise ValueError("dataset release contains no shards")
    geography = shards[0]["geography"]
    if any(shard.get("geography") != geography for shard in shards):
        raise ValueError("dataset shards have inconsistent geographies")
    regions = [region for shard in shards for region in shard.get("regions", [])]
    return {**shards[0], "regions": regions}


def load_dataset_release(
    root: Path, geography: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    pointer_path = root / "latest.json"
    if not pointer_path.exists():
        return None, None
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    release_dir = root / "releases" / pointer["release"]
    manifest_path = release_dir / "manifest.json"
    if not manifest_path.exists():
        return None, None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    names = manifest.get("files", {}).get(geography, [f"{geography}.json"])
    shards = [json.loads((release_dir / name).read_text(encoding="utf-8")) for name in names]
    return combine_dataset_shards(shards), manifest


def load_map_release(root: Path, geography: str) -> dict[str, Any] | None:
    pointer_path = root / "latest.json"
    if not pointer_path.exists():
        return None
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    release_dir = root / "releases" / pointer["release"]
    manifest = json.loads((release_dir / "manifest.json").read_text(encoding="utf-8"))
    names = manifest.get("files", {}).get(geography, [f"map-{geography}.json"])
    shards = [json.loads((release_dir / name).read_text(encoding="utf-8")) for name in names]
    counties = {
        county: details
        for shard in shards
        for county, details in shard.get("counties", {}).items()
    }
    return {"geography": geography, "counties": counties}


def prune_releases(root: Path, keep: int) -> list[str]:
    releases_root = root / "releases"
    if not releases_root.exists():
        return []
    releases = sorted(path for path in releases_root.iterdir() if path.is_dir())
    removed = releases[:-keep] if len(releases) > keep else []
    for path in removed:
        shutil.rmtree(path)
    return [path.name for path in removed]
