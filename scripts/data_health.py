#!/usr/bin/env python3
"""Audit observation freshness separately from deployment and statistical quality.

Only actual provider attempts update the bounded, git-backed state. A successful
check with unchanged observations resets failures; a deploy-only run does not.
"""
from __future__ import annotations

import argparse
import calendar
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path

try:
    from scripts.data_update_report import DATA_SOURCES, REPOSITORY_ROOT, current_pointers, manifest_for
except ModuleNotFoundError:
    from data_update_report import DATA_SOURCES, REPOSITORY_ROOT, current_pointers, manifest_for


def shift_month(value: date, months: int) -> date:
    year, month = divmod(value.year * 12 + value.month - 1 + months, 12)
    return date(year, month + 1, 1)


def expected_period(rule: dict, today: date, series: str = "") -> str:
    if rule["frequency"] == "annual":
        cutoff = date.fromisoformat(f"{today.year}-{rule['check_month_day']}")
        return str(today.year - rule["lag_years"] - (today < cutoff))
    lag = rule.get("series_lag_months", {}).get(series, rule["lag_months"])
    # Evaluate each observation month's own deadline, so a delayed official
    # release remains delayed even when its date crosses a calendar month.
    for offset in range(lag, lag + 36):
        observation = shift_month(today, -offset)
        period = observation.strftime("%Y-%m")
        if period in rule.get("release_dates", {}):
            deadline = date.fromisoformat(rule["release_dates"][period]) + timedelta(days=rule.get("grace_days", 0))
        else:
            due_month = shift_month(observation, lag)
            day = min(rule["check_day"], calendar.monthrange(due_month.year, due_month.month)[1])
            deadline = due_month.replace(day=day)
        if today >= deadline:
            return period
    raise ValueError("No freshness deadline found")


def record_attempts(state: dict, statuses: dict, run_id: str, now: str) -> dict:
    updated = deepcopy(state)
    for group, code in statuses.items():
        if code is None:
            continue
        previous = updated["providers"].get(group, {})
        failures = previous.get("consecutive_failures", 0)
        # A rerun of one Actions run is still one attempted update.
        if code == 0:
            failures = 0
        elif previous.get("last_run_id") != run_id or previous.get("last_exit_code") == 0:
            failures += 1
        updated["providers"][group] = {
            **previous, "last_run_id": run_id, "last_attempt_at": now,
            "last_exit_code": code, "consecutive_failures": failures,
        }
        if code == 0:
            updated["providers"][group]["last_success_at"] = now
    return updated


def observations(key: str, manifest: dict) -> dict:
    if key == "cpi":
        return {name: details.get("latest_observation") for name, details in manifest.get("series", {}).items()}
    if key == "permits_history":
        return {"annual": str(manifest.get("latest_final_year") or "")}
    if key in {"acs", "hcd"}:
        return {"annual": str(manifest.get("latest_year") or "")}
    if key == "permits_provisional":
        return {"monthly": manifest.get("latest_observation")}
    return manifest.get("latest_observations", {})


def assess(root: Path, policy: dict, state: dict, today: date, groups: set[str] | None = None) -> list[dict]:
    pointers = current_pointers(root)
    rows = []
    for source in DATA_SOURCES:
        if groups and source.provider_group not in groups:
            continue
        rule = policy["sources"][source.key]
        manifest = manifest_for(root, source, pointers[source.key])
        values = observations(source.key, manifest)
        issues = []
        if not values:
            issues.append("Missing observation coverage")
        for series, value in values.items():
            expected = expected_period(rule, today, series)
            try:
                parsed = date.fromisoformat(str(value)[:7] + "-01") if len(expected) == 7 else date(int(value), 1, 1)
                actual = parsed.strftime("%Y-%m") if len(expected) == 7 else str(parsed.year)
            except (ValueError, TypeError):
                actual = ""
            if not actual or actual < expected:
                issues.append(f"{series}: through {actual or 'unknown'}, expected at least {expected}")
        attempt = state["providers"].get(source.provider_group, {})
        failures = attempt.get("consecutive_failures", 0)
        if failures >= policy["failure_threshold"]:
            issues.append(f"{failures} consecutive update failures")
        rows.append({
            "source": source.label, "issues": issues, "failures": failures,
            "last_success": attempt.get("last_success_at", "Not yet recorded"),
            "result": "Attention needed" if issues else "Update error; coverage within window" if failures else "Within expected window",
        })
    return rows


def render_report(rows: list[dict], policy: dict, today: date) -> str:
    lines = ["### Data health", "", f"Observation audit: {today.isoformat()} (UTC).", "",
             "| Source | Freshness / update status | Failure streak | Last successful check |",
             "|---|---|---:|---|"]
    for row in rows:
        detail = "; ".join(row["issues"]) or row["result"]
        lines.append(f"| {row['source']} | {detail} | {row['failures']} | {row['last_success']} |")
    lines.extend(["", "These are update-monitoring thresholds, not provider release guarantees or statistical quality ratings. "
                  "A failed health check does not prevent deployment of releases that pass validation.", "",
                  f"Reference and calendar review due: **{policy['reference_review_due']}**."])
    if today >= date.fromisoformat(policy["reference_review_due"]):
        lines.extend(["", "**Maintainer reference review is due.** Fixed vintages do not advance automatically.", ""])
        lines.extend(f"- {item}" for item in policy["reference_review"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=REPOSITORY_ROOT)
    parser.add_argument("--statuses", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--groups", nargs="+")
    parser.add_argument("--today", type=date.fromisoformat)
    args = parser.parse_args()
    policy = json.loads((args.root / "config/data_health_policy.json").read_text())
    state_path = args.root / ".github/data-update-state.json"
    state = json.loads(state_path.read_text())
    today = args.today or datetime.now(timezone.utc).date()
    statuses = json.loads(args.statuses.read_text()) if args.statuses else {}
    if statuses:
        if not args.run_id:
            parser.error("--run-id is required when recording attempts")
        state = record_attempts(state, statuses, args.run_id, datetime.now(timezone.utc).isoformat(timespec="seconds"))
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
        temporary.replace(state_path)
    rows = assess(args.root, policy, state, today, set(args.groups) if args.groups else None)
    attempted = [code for code in statuses.values() if code is not None]
    # Complete refresh failure is actionable on its first occurrence, including
    # annual workflows with a single provider.
    attention = any(row["issues"] for row in rows) or bool(attempted and all(code != 0 for code in attempted))
    report = render_report(rows, policy, today)
    if attempted and all(code != 0 for code in attempted):
        report += "\n**Every attempted provider update failed.** Inspect the refresh logs.\n"
    print(report)
    for row in rows:
        if row["issues"] or row["failures"]:
            print(f"::warning::{row['source']}: {'; '.join(row['issues']) or row['result']}")
    if today >= date.fromisoformat(policy["reference_review_due"]):
        print("::warning::Annual reference and release-calendar review is due; see the data health summary.")
    if args.summary:
        with args.summary.open("a") as stream:
            stream.write(report)
    if args.output:
        with args.output.open("a") as stream:
            stream.write(f"attention={'true' if attention else 'false'}\n")


if __name__ == "__main__":
    main()
