#!/usr/bin/env python3
"""Prepare a review-gated archival market brief from the current fact packet."""

from __future__ import annotations

import argparse
import calendar
import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = ROOT / "public" / "data"
CONFIG = json.loads((ROOT / "config" / "fact_engine.json").read_text())


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def month_end(value: str) -> str:
    match = re.search(r"(\d{4})-(\d{2})(?:-(\d{2}))?$", value)
    if not match:
        raise ValueError(f"Cannot determine period end from {value!r}")
    year, month = int(match.group(1)), int(match.group(2))
    day = int(match.group(3)) if match.group(3) else calendar.monthrange(year, month)[1]
    return f"{year:04d}-{month:02d}-{day:02d}"


def fact_by_metric(packet: dict[str, Any], metric: str) -> dict[str, Any]:
    matches = [item for item in packet["facts"] if item["metric"] == metric]
    if len(matches) != 1:
        raise ValueError(f"Expected one {metric} fact; found {len(matches)}")
    return matches[0]


def question_sections(packet: dict[str, Any]) -> list[dict[str, Any]]:
    real_price = fact_by_metric(packet, "real_zhvi")
    nominal_price = fact_by_metric(packet, "zhvi")
    inflation = fact_by_metric(packet, "cpi_la")
    inventory = fact_by_metric(packet, "inventory")
    rent = fact_by_metric(packet, "zori")
    permits = sorted(
        (item for item in packet["facts"] if item["metric"] == "permits_ytd"),
        key=lambda item: item["geography"],
    )
    if len(permits) != 2:
        raise ValueError(f"Expected two county permit facts; found {len(permits)}")

    price_kept_pace = real_price["change"] >= 0
    price_answer = (
        f"{'Yes' if price_kept_pace else 'No'}. Los Angeles metro home values changed "
        f"{nominal_price['change_display']} from one year earlier, while LA-area CPI-U changed "
        f"{inflation['change_display']}. The implied inflation-adjusted change was "
        f"{real_price['change_display']}."
    )
    permit_changes = " and ".join(
        f"{item['change_display']} in {item['geography']}" for item in permits
    )
    inventory_answer = (
        f"{'Yes' if inventory['material'] else 'Not under the Lab’s 5% reporting threshold'}. "
        f"Los Angeles metro for-sale inventory changed {inventory['change_display']} from one year earlier."
    )
    rent_answer = (
        f"Typical asking rent changed {rent['change_display']} from one year earlier."
        if rent["material"]
        else f"No material acceleration was detected. Typical asking rent changed {rent['change_display']} from one year earlier."
    )

    return [
        {
            "question": "Are home values keeping pace with local inflation?",
            "answer": price_answer,
            "fact_ids": [real_price["id"], nominal_price["id"], inflation["id"]],
            "period_end": max(month_end(item["period"]) for item in (real_price, nominal_price, inflation)),
            "observation_period": datetime.fromisoformat(month_end(real_price["period"])).strftime("%B %Y"),
            "status": "validated",
            "evidence": [nominal_price["evidence"], inflation["evidence"]],
            "sources": "Zillow Research + U.S. Bureau of Labor Statistics",
            "caveat": f"{real_price['caveat']} {inflation['caveat']}",
        },
        {
            "question": "Is residential permitting increasing?",
            "answer": f"Preliminary year-to-date authorizations changed {permit_changes}.",
            "fact_ids": [item["id"] for item in permits],
            "period_end": max(month_end(item["period"]) for item in permits),
            "observation_period": permits[0]["period"],
            "status": "preliminary",
            "evidence": [item["evidence"] for item in permits],
            "sources": "U.S. Census Bureau Building Permits Survey",
            "caveat": permits[0]["caveat"],
        },
        {
            "question": "Has metropolitan inventory shifted materially?",
            "answer": inventory_answer,
            "fact_ids": [inventory["id"]],
            "period_end": month_end(inventory["period"]),
            "observation_period": datetime.fromisoformat(month_end(inventory["period"])).strftime("%B %Y"),
            "status": "validated",
            "evidence": [inventory["evidence"]],
            "sources": "Zillow Research",
            "caveat": inventory["caveat"],
        },
        {
            "question": "Are asking rents accelerating?",
            "answer": rent_answer,
            "fact_ids": [rent["id"]],
            "period_end": month_end(rent["period"]),
            "observation_period": datetime.fromisoformat(month_end(rent["period"])).strftime("%B %Y"),
            "status": "validated",
            "evidence": [rent["evidence"]],
            "sources": "Zillow Research",
            "caveat": rent["caveat"],
        },
    ]


def source_releases(packet: dict[str, Any]) -> list[dict[str, str]]:
    labels = {
        "zillow": "Zillow Research",
        "cpi": "U.S. Bureau of Labor Statistics",
        "permits_provisional": "U.S. Census Bureau Building Permits Survey",
    }
    return [
        {"provider": label, **packet["source_releases"][key]}
        for key, label in labels.items()
    ]


def write_outputs(path: Path | None, values: dict[str, str]) -> None:
    if not path:
        return
    with path.open("a") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    data_root = args.data_root
    packet = read_json(data_root / "facts" / "latest.json")
    archive_dir = data_root / "briefs"
    index_path = archive_dir / "index.json"
    index = read_json(index_path)
    today = date.fromisoformat(args.today) if args.today else datetime.now(ZoneInfo("America/Los_Angeles")).date()
    issue_month = args.issue_month or today.strftime("%Y-%m")
    if not re.fullmatch(r"\d{4}-\d{2}", issue_month):
        raise ValueError("Issue month must use YYYY-MM format")
    existing = next((item for item in index["briefs"] if item["issue_month"] == issue_month), None)
    latest_entry = max(index["briefs"], key=lambda item: item["issue_month"], default=None)
    latest = read_json(archive_dir / latest_entry["path"]) if latest_entry else None
    sections = question_sections(packet)
    prior_periods = {item["question"]: item["period_end"] for item in latest["sections"]} if latest else {}
    advanced = [
        item["question"] for item in sections
        if item["period_end"] > prior_periods.get(item["question"], "0000-00-00")
    ]
    facts_by_id = {item["id"]: item for item in packet["facts"]}
    advanced_material = [
        item["question"] for item in sections
        if item["question"] in advanced
        and any(facts_by_id[fact_id]["material"] for fact_id in item["fact_ids"])
    ]
    minimum = int(CONFIG["brief_archive"]["minimum_advanced_questions"])
    single_material_allowed = bool(CONFIG["brief_archive"]["allow_single_material_question"])
    reasons = []
    if existing:
        reasons.append(f"{issue_month} is already in the approved archive")
    if latest and packet["packet_sha256"] == latest["source_packet_sha256"]:
        reasons.append("the current fact packet is already represented by the latest archive")
    advancement_gate = len(advanced) >= minimum or (single_material_allowed and bool(advanced_material))
    if not advancement_gate and not args.force:
        reasons.append(
            f"only {len(advanced)} recurring questions advanced and none contains a material change; "
            f"{minimum} newer questions or one material change are required"
        )
    issue_end = month_end(issue_month)
    if any(item["period_end"] > issue_end for item in sections):
        reasons.append("the selected evidence extends beyond the issue month")
    ready = not reasons

    result = {
        "ready": ready,
        "issue_month": issue_month,
        "advanced_questions": advanced,
        "advanced_material_questions": advanced_material,
        "reason": "; ".join(reasons) if reasons else "readiness checks passed",
        "packet_sha256": packet["packet_sha256"],
    }
    if not ready:
        return result

    archive_dir.mkdir(parents=True, exist_ok=True)
    issue_label = datetime.strptime(issue_month, "%Y-%m").strftime("%B %Y")
    price = sections[0]
    permits = sections[1]
    brief = {
        "schema_version": 1,
        "status": "published",
        "issue_month": issue_month,
        "observation_cutoff": max(item["period_end"] for item in sections),
        "prepared_at": today.isoformat(),
        "title": f"{issue_label} Housing Market Brief",
        "headline": "Home values after inflation and the residential construction pipeline",
        "summary": f"The latest eligible observations show that {price['answer'][0].lower() + price['answer'][1:]} {permits['answer']}",
        "reconstruction_note": "Prepared from the Lab’s validated fact packet. Each finding retains its observation period and source release; later provider revisions do not silently alter this archived edition.",
        "source_packet_sha256": packet["packet_sha256"],
        "source_releases": source_releases(packet),
        "sections": sections,
    }
    brief_path = archive_dir / f"{issue_month}.json"
    brief_path.write_text(json.dumps(brief, indent=2, ensure_ascii=False) + "\n")
    entry = {
        "issue_month": issue_month,
        "title": brief["title"],
        "status": brief["status"],
        "prepared_at": brief["prepared_at"],
        "path": brief_path.name,
    }
    index["briefs"] = sorted([entry, *index["briefs"]], key=lambda item: item["issue_month"], reverse=True)
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    return result


def review_markdown(result: dict[str, Any]) -> str:
    questions = "\n".join(f"- {item}" for item in result["advanced_questions"]) or "- None"
    if not result["ready"]:
        return f"## Market brief readiness\n\nNo draft is recommended: {result['reason']}.\n\n### Questions with newer evidence\n\n{questions}\n"
    return (
        f"## Proposed {result['issue_month']} market brief\n\n"
        "This candidate was generated deterministically from the current validated fact packet. "
        "Merging this draft pull request is the publication approval step.\n\n"
        "### Questions with newer evidence\n\n"
        f"{questions}\n\n"
        f"Materially changed questions: {len(result['advanced_material_questions'])}.\n\n"
        "### Reviewer checklist\n\n"
        "- [ ] Every number matches its evidence line.\n"
        "- [ ] Observation periods are clear and compatible.\n"
        "- [ ] Preliminary permit evidence is labeled.\n"
        "- [ ] No causal claim or forecast has been introduced.\n"
        "- [ ] Source releases and the fact-packet fingerprint are retained.\n\n"
        f"Fact packet: `{result['packet_sha256']}`\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    parser.add_argument("--issue-month")
    parser.add_argument("--today", help="ISO date override for reproducible tests")
    parser.add_argument("--force", action="store_true", help="Bypass only the minimum-advancement rule")
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--review-note", type=Path)
    args = parser.parse_args()
    result = prepare(args)
    if args.review_note:
        args.review_note.write_text(review_markdown(result))
    write_outputs(args.github_output, {
        "ready": str(result["ready"]).lower(),
        "issue_month": result["issue_month"],
        "reason": result["reason"],
    })
    print(json.dumps(result))


if __name__ == "__main__":
    main()
