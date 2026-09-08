#!/usr/bin/env python3
"""Reject unbounded releases, oversized JSON objects, and committed raw data."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DATA = ROOT / "public" / "data"
POLICY = json.loads((ROOT / "config" / "storage_policy.json").read_text())
RELEASE_ROOTS = {
    "zillow": PUBLIC_DATA,
    "maps": PUBLIC_DATA / "maps",
    "redfin": PUBLIC_DATA / "redfin",
    "realtor_inventory": PUBLIC_DATA / "realtor" / "inventory",
    "realtor_hotness": PUBLIC_DATA / "realtor" / "hotness",
    "cpi": PUBLIC_DATA / "cpi",
    "acs": PUBLIC_DATA / "acs",
    "permits_history": PUBLIC_DATA / "permits" / "history",
    "permits_provisional": PUBLIC_DATA / "permits" / "provisional",
}


def main() -> None:
    failures = []
    json_files = sorted(PUBLIC_DATA.rglob("*.json"))
    total = sum(path.stat().st_size for path in PUBLIC_DATA.rglob("*") if path.is_file())
    if total > int(POLICY["max_public_data_bytes"]):
        failures.append(
            f"public data uses {total:,} bytes; budget is {POLICY['max_public_data_bytes']:,}"
        )
    for path in json_files:
        size = path.stat().st_size
        if size > int(POLICY["max_generated_json_bytes"]):
            failures.append(
                f"{path.relative_to(ROOT)} is {size:,} bytes; shard limit is "
                f"{POLICY['max_generated_json_bytes']:,}"
            )
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as caught:
            failures.append(f"{path.relative_to(ROOT)} is not valid JSON: {caught}")
    forbidden = {
        suffix.lower() for suffix in POLICY["forbidden_public_suffixes"]
    }
    for path in PUBLIC_DATA.rglob("*"):
        if path.is_file() and path.suffix.lower() in forbidden:
            failures.append(f"raw/archive file must not be published: {path.relative_to(ROOT)}")
    for key, release_root in RELEASE_ROOTS.items():
        releases_root = release_root / "releases"
        releases = sorted(path for path in releases_root.iterdir() if path.is_dir()) if releases_root.exists() else []
        keep = int(POLICY["keep_releases"][key])
        if len(releases) > keep:
            failures.append(f"{key} retains {len(releases)} releases; policy allows {keep}")
        pointer_path = release_root / "latest.json"
        if not pointer_path.exists():
            failures.append(f"{key} has no latest.json pointer")
            continue
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
        selected = releases_root / pointer.get("release", "")
        if not selected.is_dir() or not (selected / "manifest.json").exists():
            failures.append(f"{key} latest.json does not resolve to a complete release")
            continue
        manifest = json.loads((selected / "manifest.json").read_text(encoding="utf-8"))
        for names in manifest.get("files", {}).values():
            for name in names:
                if not (selected / name).is_file():
                    failures.append(f"{key} manifest references missing file {name}")
    if failures:
        raise SystemExit("Storage policy failed:\n- " + "\n- ".join(failures))
    largest = max(json_files, key=lambda path: path.stat().st_size)
    print(
        f"Storage policy passed: {total:,} public bytes, {len(json_files)} JSON files, "
        f"largest object {largest.stat().st_size:,} bytes ({largest.relative_to(ROOT)})."
    )


if __name__ == "__main__":
    main()
