#!/usr/bin/env python3
"""Build compact provider summaries for GitHub Actions runs."""

from __future__ import annotations

import argparse
import calendar
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class DataSource:
    key: str
    label: str
    pointer: str
    provider_group: str


DATA_SOURCES = (
    DataSource("zillow", "Zillow home values and rents", "public/data/latest.json", "zillow"),
    DataSource("redfin", "Redfin market activity", "public/data/redfin/latest.json", "redfin"),
    DataSource("realtor_inventory", "Realtor.com inventory", "public/data/realtor/inventory/latest.json", "realtor"),
    DataSource("realtor_hotness", "Realtor.com Market Hotness", "public/data/realtor/hotness/latest.json", "realtor"),
    DataSource("cpi", "BLS CPI", "public/data/cpi/latest.json", "cpi"),
    DataSource("permits_history", "Census building permits — final history", "public/data/permits/history/latest.json", "permits"),
    DataSource("permits_provisional", "Census building permits — provisional", "public/data/permits/provisional/latest.json", "permits"),
    DataSource("acs", "ACS five-year estimates", "public/data/acs/latest.json", "acs"),
)


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def current_pointers(root: Path) -> dict[str, dict[str, Any] | None]:
    return {source.key: read_json(root / source.pointer) for source in DATA_SOURCES}


def pointer_at_ref(root: Path, ref: str, pointer: str) -> dict[str, Any] | None:
    if not ref or set(ref) == {"0"}:
        return None
    result = subprocess.run(
        ["git", "show", f"{ref}:{pointer}"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return json.loads(result.stdout)


def manifest_for(root: Path, source: DataSource, pointer: dict[str, Any] | None) -> dict[str, Any]:
    if not pointer or not pointer.get("release"):
        return {}
    pointer_path = root / source.pointer
    relative_manifest = pointer.get("manifest") or f"releases/{pointer['release']}/manifest.json"
    return read_json(pointer_path.parent / relative_manifest) or {}


def month_value(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, str) or len(value) < 7:
        return None
    try:
        return int(value[:4]), int(value[5:7])
    except ValueError:
        return None


def month_range(values: list[Any]) -> str:
    months = sorted({parsed for value in values if (parsed := month_value(value))})
    if not months:
        return "—"
    first_year, first_month = months[0]
    last_year, last_month = months[-1]
    if months[0] == months[-1]:
        return f"{calendar.month_name[first_month]} {first_year}"
    if first_year == last_year:
        return f"{calendar.month_name[first_month]}–{calendar.month_name[last_month]} {first_year}"
    return f"{calendar.month_name[first_month]} {first_year}–{calendar.month_name[last_month]} {last_year}"


def coverage_label(root: Path, source: DataSource, pointer: dict[str, Any] | None) -> str:
    manifest = manifest_for(root, source, pointer)
    if source.key in {"zillow", "redfin"}:
        return month_range(list((manifest.get("latest_observations") or {}).values()))
    if source.key.startswith("realtor_"):
        return month_range([(manifest.get("source") or {}).get("latest_observation")])
    if source.key == "cpi":
        return month_range([
            details.get("latest_observation")
            for details in (manifest.get("series") or {}).values()
        ])
    if source.key == "permits_history":
        return month_range([manifest.get("latest_final_month")])
    if source.key == "permits_provisional":
        return month_range([manifest.get("latest_observation")])
    if source.key == "acs" and manifest.get("latest_year"):
        return f"{manifest['latest_year']} five-year estimates"
    return "—"


def release_value(pointer: dict[str, Any] | None) -> str | None:
    return str(pointer.get("release")) if pointer and pointer.get("release") else None


def report_rows(
    root: Path,
    before: dict[str, dict[str, Any] | None],
    statuses: dict[str, int | None] | None,
) -> list[dict[str, str]]:
    after = current_pointers(root)
    rows: list[dict[str, str]] = []
    for source in DATA_SOURCES:
        previous_release = release_value(before.get(source.key))
        current_pointer = after.get(source.key)
        current_release = release_value(current_pointer)
        if current_release != previous_release:
            result = "Published"
        elif statuses is None or source.provider_group not in statuses:
            continue
        elif statuses[source.provider_group] is None:
            continue
        elif statuses[source.provider_group] == 0:
            result = "Checked — no new release"
        else:
            result = "Retained — update error"
        rows.append({
            "source": source.label,
            "result": result,
            "coverage": coverage_label(root, source, current_pointer),
            "release": current_release or "—",
        })
    return rows


def markdown_report(
    rows: list[dict[str, str]],
    run_url: str,
    site_url: str,
) -> str:
    published_at = datetime.now(timezone.utc)
    lines = [
        "### Data update summary",
        "",
        "**Housing Market Lab completed successfully.**",
        "",
        f"Completed {published_at.strftime('%B')} {published_at.day}, {published_at.strftime('%Y at %H:%M UTC')}.",
        "",
        "| Data source | Result | Data through | Validated release |",
        "|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['source']} | {row['result']} | {row['coverage']} | `{row['release']}` |"
        )
    lines.extend([
        "",
        f"[Open the dashboard]({site_url}) · [View the workflow run]({run_url})",
        "",
        "A source marked **Retained — update error** remains on its prior validated release.",
    ])
    return "\n".join(lines) + "\n"


def snapshot_command(args: argparse.Namespace) -> None:
    payload = {"sources": current_pointers(args.root)}
    args.output.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def status_command(args: argparse.Namespace) -> None:
    statuses: dict[str, int | None] = {}
    for entry in args.entries:
        key, value = entry.split("=", 1)
        statuses[key] = None if value == "not_checked" else int(value)
    args.output.write_text(json.dumps(statuses, sort_keys=True), encoding="utf-8")


def finish_report(args: argparse.Namespace, before: dict[str, dict[str, Any] | None], statuses: dict[str, int | None] | None) -> None:
    rows = report_rows(args.root, before, statuses)
    if rows:
        report = markdown_report(rows, args.run_url, args.site_url)
    else:
        report = (
            "### Data update summary\n\n"
            "Housing Market Lab completed successfully. No validated provider "
            "release pointers changed.\n"
        )
    with args.summary.open("a", encoding="utf-8") as summary:
        summary.write(report)


def report_command(args: argparse.Namespace) -> None:
    before_payload = json.loads(args.before.read_text(encoding="utf-8"))
    statuses = json.loads(args.statuses.read_text(encoding="utf-8"))
    finish_report(args, before_payload["sources"], statuses)


def git_report_command(args: argparse.Namespace) -> None:
    before = {
        source.key: pointer_at_ref(args.root, args.before_ref, source.pointer)
        for source in DATA_SOURCES
    }
    finish_report(args, before, None)


def add_report_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", type=Path, default=REPOSITORY_ROOT)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--site-url", required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--root", type=Path, default=REPOSITORY_ROOT)
    snapshot.add_argument("--output", type=Path, required=True)
    snapshot.set_defaults(func=snapshot_command)

    status = subparsers.add_parser("record-status")
    status.add_argument("--output", type=Path, required=True)
    status.add_argument("entries", nargs="+")
    status.set_defaults(func=status_command)

    report = subparsers.add_parser("report")
    add_report_arguments(report)
    report.add_argument("--before", type=Path, required=True)
    report.add_argument("--statuses", type=Path, required=True)
    report.set_defaults(func=report_command)

    git_report = subparsers.add_parser("git-report")
    add_report_arguments(git_report)
    git_report.add_argument("--before-ref", required=True)
    git_report.set_defaults(func=git_report_command)

    return parser.parse_args()


if __name__ == "__main__":
    parsed_args = parse_args()
    parsed_args.func(parsed_args)
