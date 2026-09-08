#!/usr/bin/env python3
"""One-time migration from monolithic snapshots to bounded storage schema v2."""

from __future__ import annotations

import argparse
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from pipeline.storage import (
        bundle_sha, compact_json, dataset_shards, load_dataset_release,
        map_shards, prune_releases,
    )
except ModuleNotFoundError:  # direct script execution
    from storage import (  # type: ignore[no-redef]
        bundle_sha, compact_json, dataset_shards, load_dataset_release,
        map_shards, prune_releases,
    )


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DATA = ROOT / "public" / "data"
POLICY = json.loads((ROOT / "config" / "storage_policy.json").read_text())


def release_id(root: Path) -> str:
    stem = datetime.now(timezone.utc).strftime("%Y-%m-%d-r%H%M%S")
    candidate = stem
    suffix = 2
    while (root / "releases" / candidate).exists():
        candidate = f"{stem}-{suffix}"
        suffix += 1
    return candidate


def atomic_pointer(root: Path, payload: dict[str, Any]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as handle:
        handle.write(compact_json(payload))
        temporary = Path(handle.name)
    temporary.replace(root / "latest.json")


def migrate_dataset_root(
    root: Path,
    geographies: list[str],
    keep: int,
    *,
    update_manifest: dict[str, Any] | None = None,
) -> str:
    datasets = {}
    current_manifest = None
    for geography in geographies:
        dataset, manifest = load_dataset_release(root, geography)
        if dataset is None or manifest is None:
            raise RuntimeError(f"Cannot migrate {root}: missing {geography} release")
        datasets[geography] = dataset
        current_manifest = manifest
    assert current_manifest is not None
    if current_manifest.get("storage_schema_version") == 2:
        prune_releases(root, keep)
        return str(current_manifest["release"])
    files: dict[str, bytes] = {}
    file_index: dict[str, list[str]] = {}
    for geography, dataset in datasets.items():
        shards, names = dataset_shards(dataset)
        files.update(shards)
        file_index[geography] = names
    digest = bundle_sha(files)
    release = release_id(root)
    release_dir = root / "releases" / release
    for name, content in files.items():
        release_dir.mkdir(parents=True, exist_ok=True)
        (release_dir / name).write_bytes(content)
    manifest = {
        **current_manifest,
        **(update_manifest or {}),
        "storage_schema_version": 2,
        "release": release,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "bundle_sha256": digest,
        "files": file_index,
        "history_policy": {
            "strategy": "merge_forward",
            "previous_release": current_manifest["release"],
            "report": {"migration": "no observation changes"},
        },
    }
    (release_dir / "manifest.json").write_bytes(compact_json(manifest))
    atomic_pointer(root, {
        "release": release,
        "bundle_sha256": digest,
        "manifest": f"releases/{release}/manifest.json",
    })
    removed = prune_releases(root, keep)
    print(f"Migrated {root.relative_to(ROOT)} to {release}; pruned {removed or 'none'}")
    return release


def migrate_maps() -> str:
    root = PUBLIC_DATA / "maps"
    if (root / "latest.json").exists():
        pointer = json.loads((root / "latest.json").read_text())
        prune_releases(root, int(POLICY["keep_releases"]["maps"]))
        return str(pointer["release"])
    zillow_pointer = json.loads((PUBLIC_DATA / "latest.json").read_text())
    source = PUBLIC_DATA / "releases" / zillow_pointer["release"]
    maps = {
        geography: json.loads((source / f"map-{geography}.json").read_text())
        for geography in ("city", "zip")
    }
    files, file_index = map_shards(maps)
    digest = bundle_sha(files)
    release = release_id(root)
    release_dir = root / "releases" / release
    release_dir.mkdir(parents=True, exist_ok=False)
    for name, content in files.items():
        (release_dir / name).write_bytes(content)
    (release_dir / "manifest.json").write_bytes(compact_json({
        "storage_schema_version": 2,
        "release": release,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "provider": "U.S. Census Bureau",
        "bundle_sha256": digest,
        "files": file_index,
    }))
    atomic_pointer(root, {"release": release, "bundle_sha256": digest})
    print(f"Migrated shared maps to {release}")
    return release


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    targets = {
        "zillow": (PUBLIC_DATA, ["city", "zip", "metro"]),
        "redfin": (PUBLIC_DATA / "redfin", ["city", "zip"]),
        "realtor_inventory": (PUBLIC_DATA / "realtor" / "inventory", ["zip"]),
        "realtor_hotness": (PUBLIC_DATA / "realtor" / "hotness", ["zip"]),
    }
    if args.dry_run:
        for key, (root, geographies) in targets.items():
            for geography in geographies:
                dataset, manifest = load_dataset_release(root, geography)
                if not dataset or not manifest:
                    raise RuntimeError(f"{key}/{geography} cannot be read")
                files, _ = dataset_shards(dataset)
                largest = max(len(content) for content in files.values())
                print(f"{key}/{geography}: {len(files)} shard(s), largest {largest:,} bytes")
        return
    map_release = migrate_maps()
    migrate_dataset_root(
        PUBLIC_DATA,
        ["city", "zip", "metro"],
        int(POLICY["keep_releases"]["zillow"]),
        update_manifest={"map_release": map_release},
    )
    migrate_dataset_root(
        PUBLIC_DATA / "redfin",
        ["city", "zip"],
        int(POLICY["keep_releases"]["redfin"]),
    )
    for product in ("inventory", "hotness"):
        migrate_dataset_root(
            PUBLIC_DATA / "realtor" / product,
            ["zip"],
            int(POLICY["keep_releases"][f"realtor_{product}"]),
            update_manifest={"retained_releases": 2},
        )
    prune_releases(PUBLIC_DATA / "cpi", int(POLICY["keep_releases"]["cpi"]))
    prune_releases(PUBLIC_DATA / "permits" / "history", int(POLICY["keep_releases"]["permits_history"]))
    prune_releases(PUBLIC_DATA / "permits" / "provisional", int(POLICY["keep_releases"]["permits_provisional"]))


if __name__ == "__main__":
    main()
