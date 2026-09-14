#!/usr/bin/env python3
"""Prepare a review-gated archival market brief from the current fact packet."""

from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    from pipeline.storage import bundle_sha
except ModuleNotFoundError:
    from storage import bundle_sha  # type: ignore[no-redef]

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = ROOT / "public" / "data"
CONFIG = json.loads((ROOT / "config" / "fact_engine.json").read_text())
BRIEF_CONFIG = json.loads((ROOT / "config" / "market_brief.json").read_text())
QUESTION_ALIASES = {
    "Are asking rents accelerating?": "How fast are asking rents changing?",
}
LEGACY_QUESTION_IDS = {
    "Are home values keeping pace with local inflation?": "real_zhvi-los-angeles-metro",
    "Is residential permitting increasing?": "permits_metro_ytd-los-angeles-metro",
    "Has metropolitan inventory shifted materially?": "inventory-los-angeles-metro",
    "How fast are asking rents changing?": "zori-los-angeles-metro",
}


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


def question_key(question: str) -> str:
    """Map retired wording to the continuing recurring question."""
    return QUESTION_ALIASES.get(question, question)


def natural_join(items: list[str]) -> str:
    if len(items) < 2:
        return items[0] if items else "the latest housing indicators"
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])}, and {items[-1]}"


def brief_headline_and_summary(
    sections: list[dict[str, Any]], advanced_questions: list[str]
) -> tuple[str, str]:
    """Describe only the evidence that qualified this edition for review."""
    if not advanced_questions:
        return (
            "Review of recurring Los Angeles housing indicators",
            "A maintainer-requested review of the Lab’s pre-specified internal question registry.",
        )
    selected = [item for item in sections if item["question"] in advanced_questions]
    topics = [item.get("topic", item["question"]) for item in selected]
    return f"New evidence on {natural_join(topics)}", " ".join(item["answer"] for item in selected)


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

    if len({item["period"] for item in permits}) != 1:
        raise ValueError("County BPS facts must use the same year-to-date window")
    if any(item["provider"] != "U.S. Census Bureau Building Permits Survey" or not item["provisional"] for item in permits):
        raise ValueError("The recurring permitting question requires preliminary Census BPS evidence, not HCD delivery")

    price_kept_pace = real_price["change"] >= 0
    price_answer = (
        f"{'Yes' if price_kept_pace else 'No'}. Los Angeles metro home values changed "
        f"{real_price['nominal_change_display']} from one year earlier, while LA-area CPI-U changed "
        f"{real_price['inflation_change_display']} over the same period. The implied inflation-adjusted change was "
        f"{real_price['change_display']}."
    )
    metro_permits = fact_by_metric(packet, "permits_metro_ytd")
    if metro_permits["period"] != permits[0]["period"] or metro_permits["value"] != sum(item["value"] for item in permits):
        raise ValueError("Metro permits must match the county counts and comparison window")
    if metro_permits["provider"] != permits[0]["provider"] or not metro_permits["provisional"] or metro_permits["prior_value"] != sum(item["prior_value"] for item in permits):
        raise ValueError("Metro permits must retain the BPS source and matched prior counts")
    change = metro_permits["change"]
    if change > 0:
        permit_answer = f"Yes. Los Angeles metro YTD permits rose {change:.1%}."
    elif change < 0:
        permit_answer = f"No. Los Angeles metro YTD permits fell {abs(change):.1%}."
    else:
        permit_answer = "No. Los Angeles metro YTD permits were unchanged at 0.0%."
    inventory_answer = (
        f"{'Yes' if inventory['material'] else 'Not under the Lab’s 5% reporting threshold'}. "
        f"Los Angeles metro for-sale inventory changed {inventory['change_display']} from one year earlier."
    )
    rent_answer = (
        f"Los Angeles metro typical asking rent changed {rent['change_display']} from one year earlier."
        if rent["material"]
        else f"Below the Lab’s 1.5% reporting threshold. Los Angeles metro typical asking rent changed {rent['change_display']} from one year earlier."
    )

    return [
        {
            "question": "Are home values keeping pace with local inflation?",
            "answer": price_answer,
            "trigger_fact_id": real_price["id"],
            "fact_ids": [real_price["id"], nominal_price["id"], inflation["id"]],
            "period_end": month_end(real_price["period"]),
            "observation_period": datetime.fromisoformat(month_end(real_price["period"])).strftime("%B %Y"),
            "status": "validated",
            "evidence": [real_price["evidence"], nominal_price["evidence"]],
            "sources": "Zillow Research + U.S. Bureau of Labor Statistics",
            "coverage": real_price["coverage"],
            "caveat": f"{real_price['caveat']} {inflation['caveat']}",
        },
        {
            "question": "Is residential permitting increasing?",
            "answer": permit_answer,
            "trigger_fact_id": metro_permits["id"],
            "fact_ids": [metro_permits["id"], *[item["id"] for item in permits]],
            "period_end": max(month_end(item["period"]) for item in permits),
            "observation_period": permits[0]["period"],
            "status": "preliminary",
            "evidence": [f"Los Angeles metro: {metro_permits['evidence']}"],
            "sources": "U.S. Census Bureau Building Permits Survey",
            "coverage": metro_permits["coverage"],
            "caveat": permits[0]["caveat"],
        },
        {
            "question": "Has metropolitan inventory shifted materially?",
            "answer": inventory_answer,
            "trigger_fact_id": inventory["id"],
            "fact_ids": [inventory["id"]],
            "period_end": month_end(inventory["period"]),
            "observation_period": datetime.fromisoformat(month_end(inventory["period"])).strftime("%B %Y"),
            "status": "validated",
            "evidence": [inventory["evidence"]],
            "sources": "Zillow Research",
            "coverage": inventory["coverage"],
            "caveat": inventory["caveat"],
        },
        {
            "question": "How fast are asking rents changing?",
            "answer": rent_answer,
            "trigger_fact_id": rent["id"],
            "fact_ids": [rent["id"]],
            "period_end": month_end(rent["period"]),
            "observation_period": datetime.fromisoformat(month_end(rent["period"])).strftime("%B %Y"),
            "status": "validated",
            "evidence": [rent["evidence"]],
            "sources": "Zillow Research",
            "coverage": rent["coverage"],
            "caveat": rent["caveat"],
        },
    ]


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _change_phrase(item: dict[str, Any]) -> str:
    display = item["change_display"].lstrip("+-")
    if item["change"] > 0:
        return f"increased by {display}"
    if item["change"] < 0:
        return f"decreased by {display}"
    return "was unchanged"


def _qualification(item: dict[str, Any]) -> list[dict[str, str]]:
    """Apply independent, pre-specified paths; materiality is not a tail probability."""
    rules = BRIEF_CONFIG["selection"]
    threshold = float(CONFIG["metrics"][item["metric"]]["materiality"])
    output: list[dict[str, str]] = []
    if item["material"]:
        output.append({
            "id": "material_movement",
            "label": "Material movement",
            "explanation": BRIEF_CONFIG["qualification_paths"]["material_movement"],
        })
    if (
        item.get("coverage_ratio", 1) >= rules["minimum_coverage_ratio"]
        and item.get("breadth_share", 0) >= rules["breadth_minimum_share"]
        and abs(item["change"]) >= threshold * rules["breadth_minimum_threshold_fraction"]
    ):
        output.append({
            "id": "broad_local_shift",
            "label": "Broad local shift",
            "explanation": (
                f"{item['breadth_count']} of {item['calculable_count']} covered local markets "
                f"{item['breadth_direction']}; the median change also reached at least half of its editorial threshold."
            ),
        })
    previous = item.get("previous_change")
    if (
        previous is not None
        and previous * item["change"] < 0
        and abs(previous) >= threshold * rules["turn_minimum_threshold_fraction"]
        and abs(item["change"]) >= threshold * rules["turn_minimum_threshold_fraction"]
    ):
        output.append({
            "id": "direction_change",
            "label": "Direction change",
            "explanation": BRIEF_CONFIG["qualification_paths"]["direction_change"],
        })
    return output


def _section_from_fact(item: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    qualifications = _qualification(item)
    if any(rule["id"] == "broad_local_shift" for rule in qualifications):
        answer = (
            f"{item['geography']} {item['metric_label'].lower()} "
            f"{_change_phrase(item)}; {item['breadth_count']} of {item['calculable_count']} covered local markets "
            f"{item['breadth_direction']}."
        )
    elif any(rule["id"] == "direction_change" for rule in qualifications):
        answer = (
            f"The direction changed. {item['geography']} {item['metric_label'].lower()} {_change_phrase(item)} "
            f"after a preceding year-over-year change of {item['previous_change_display']}."
        )
    else:
        answer = f"{item['geography']} {item['metric_label'].lower()} {_change_phrase(item)} from one year earlier."
    return {
        "question_id": f"{item['metric']}-{_slug(item['geography'])}",
        "theme": spec["theme"],
        "kicker": spec["kicker"],
        "question": spec["question"].format(geography=item["geography"]),
        "topic": spec["topic"].format(geography=item["geography"]),
        "answer": answer,
        "trigger_fact_id": item["id"],
        "trigger_fact_ids": [item["id"]],
        "fact_ids": [item["id"]],
        "period_end": month_end(item["period"]),
        "observation_period": (
            item["period"] if " through " in item["period"]
            else datetime.fromisoformat(month_end(item["period"])).strftime("%B %Y")
        ),
        "status": "preliminary" if item["provisional"] else "validated",
        "evidence": [f"{item['geography']}: {item['evidence']}"],
        "sources": item["provider"],
        "source_releases": [{"provider": item["provider"], "release": item["release"]}],
        "coverage": item["coverage"],
        "caveat": item["caveat"],
        "destination": spec["destination"],
        "link_label": spec["link_label"],
        "qualifications": qualifications,
        "selection_score": item["score"] + 8 * len(qualifications),
    }


def _section_source_releases(facts: dict[str, dict[str, Any]], fact_ids: list[str]) -> list[dict[str, str]]:
    releases: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for fact_id in fact_ids:
        if fact_id not in facts:
            continue
        item = facts[fact_id]
        key = (item["provider"], item["release"])
        if key not in seen:
            releases.append({"provider": key[0], "release": key[1]})
            seen.add(key)
    return releases


def expanded_question_pool(packet: dict[str, Any]) -> list[dict[str, Any]]:
    """Build the internal monitoring pool from every configured fact and relationship."""
    facts = {item["id"]: item for item in packet["facts"]}
    by_metric = BRIEF_CONFIG["questions_by_metric"]
    sections: list[dict[str, Any]] = []
    base_by_metric = {
        "real_zhvi": question_sections(packet)[0],
        "permits_metro_ytd": question_sections(packet)[1],
        "inventory": question_sections(packet)[2],
        "zori": question_sections(packet)[3],
    }
    for metric, base in base_by_metric.items():
        item = facts[base["trigger_fact_id"]]
        spec = by_metric[metric]
        qualifications = _qualification(item)
        section = {
            **base,
            "question_id": f"{metric}-{_slug(item['geography'])}",
            "theme": spec["theme"],
            "kicker": spec["kicker"],
            "question": spec["question"].format(geography=item["geography"]),
            "topic": spec["topic"],
            "trigger_fact_ids": [item["id"]],
            "destination": spec["destination"],
            "link_label": spec["link_label"],
            "qualifications": qualifications,
            "selection_score": item["score"] + 8 * len(qualifications),
        }
        section["source_releases"] = _section_source_releases(facts, section["fact_ids"])
        sections.append(section)
    handled = set(base_by_metric)
    for item in packet["facts"]:
        if item["metric"] in handled or item["metric"] not in by_metric:
            continue
        sections.append(_section_from_fact(item, by_metric[item["metric"]]))

    for relationship in BRIEF_CONFIG["relationships"]:
        if any(fact_id not in facts for fact_id in relationship["fact_ids"]):
            continue
        related = [facts[fact_id] for fact_id in relationship["fact_ids"]]
        fraction = BRIEF_CONFIG["selection"]["divergence_minimum_threshold_fraction"]
        if relationship["mode"] == "opposite_direction":
            meaningful = related[0]["change"] * related[1]["change"] < 0 and all(
                abs(item["change"]) >= CONFIG["metrics"][item["metric"]]["materiality"] * fraction
                for item in related
            )
        else:
            meaningful = abs(related[0]["change"] - related[1]["change"]) >= relationship["minimum_gap"]
        period_end = max(month_end(item["period"]) for item in related)
        sections.append({
            "question_id": relationship["id"],
            "theme": relationship["theme"],
            "kicker": relationship["kicker"],
            "question": relationship["question"],
            "topic": relationship["topic"],
            "answer": (
                f"The indicators diverged. {related[0]['metric_label']} {_change_phrase(related[0])}, while "
                f"{related[1]['metric_label'].lower()} {_change_phrase(related[1])}."
            ),
            "trigger_fact_ids": relationship["fact_ids"],
            "fact_ids": relationship["fact_ids"],
            "period_end": period_end,
            "observation_period": datetime.fromisoformat(period_end).strftime("%B %Y"),
            "status": "preliminary" if any(item["provisional"] for item in related) else "validated",
            "evidence": [f"{item['geography']}: {item['evidence']}" for item in related],
            "sources": " + ".join(dict.fromkeys(item["provider"] for item in related)),
            "source_releases": _section_source_releases(facts, relationship["fact_ids"]),
            "coverage": " ".join(dict.fromkeys(item["coverage"] for item in related)),
            "caveat": " ".join(dict.fromkeys(item["caveat"] for item in related if item["caveat"])),
            "destination": relationship["destination"],
            "link_label": relationship["link_label"],
            "qualifications": [{
                "id": "indicator_divergence",
                "label": "Indicator divergence",
                "explanation": BRIEF_CONFIG["qualification_paths"]["indicator_divergence"],
            }] if meaningful else [],
            "selection_score": max(item["score"] for item in related) + 12,
        })
    return sections


def select_findings(
    sections: list[dict[str, Any]], prior_periods: dict[str, str] | None = None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible = [item for item in sections if item["qualifications"]]
    if prior_periods is not None:
        eligible = [
            item for item in eligible
            if item["period_end"] > prior_periods.get(item["question_id"], "0000-00-00")
        ]
    ranked = sorted(eligible, key=lambda item: (-item["selection_score"], item["question_id"]))
    selected: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    theme_counts: dict[str, int] = {}
    rules = BRIEF_CONFIG["selection"]
    for item in ranked:
        if len(selected) >= rules["maximum_findings"] or theme_counts.get(item["theme"], 0) >= rules["maximum_per_theme"]:
            suppressed.append(item)
            continue
        selected.append(item)
        theme_counts[item["theme"]] = theme_counts.get(item["theme"], 0) + 1
    return selected, suppressed


def finding_headline_and_summary(sections: list[dict[str, Any]]) -> tuple[str, str]:
    if not sections:
        return (
            "No new finding met the Lab’s reporting rules",
            "The internal monitoring pool found no newer material movement, broad local shift, direction change, or pre-specified indicator divergence.",
        )
    topics = [item["topic"] for item in sections]
    return f"New evidence on {natural_join(topics)}", " ".join(item["answer"] for item in sections)


def build_current_snapshot(packet: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    pool = expanded_question_pool(packet)
    selected, suppressed = select_findings(pool)
    snapshot = {
        "schema_version": 1,
        "status": "automatic_snapshot",
        "generated_at": packet["generated_at"],
        "data_cutoff": packet["data_cutoff"],
        "source_packet_sha256": packet["packet_sha256"],
        "method": "Deterministic screening only; the rules identify review candidates and do not infer causes or forecasts.",
        "monitoring": {
            "question_count": len(pool),
            "qualified_before_editorial_cap": sum(bool(item["qualifications"]) for item in pool),
            "displayed_findings": len(selected),
            "suppressed_related_findings": len(suppressed),
        },
        "qualification_rules": BRIEF_CONFIG["qualification_paths"],
        "source_releases": source_releases(packet),
        "sections": selected,
    }
    return snapshot, pool


def write_current_snapshot(data_root: Path, packet: dict[str, Any]) -> dict[str, Any]:
    snapshot, _ = build_current_snapshot(packet)
    output = data_root / "briefs" / "current.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
    return snapshot


def source_releases(packet: dict[str, Any]) -> list[dict[str, str]]:
    labels = {
        "zillow": "Zillow Research",
        "redfin": "Redfin",
        "realtor_inventory": "Realtor.com® Economic Research — Inventory",
        "cpi": "U.S. Bureau of Labor Statistics",
        "permits_provisional": "Census BPS — preliminary current-year observations",
        "permits_history": "Census BPS — final comparison history",
    }
    return [
        {"provider": label, **packet["source_releases"][key]}
        for key, label in labels.items()
    ]


def housing_supply_review(data_root: Path, latest: dict[str, Any] | None, issue_month: str) -> dict[str, Any]:
    """Track annual HCD evidence separately from monthly question advancement."""
    base = data_root / "hcd"
    if not (base / "latest.json").exists():
        return {"status": "unavailable", "review_required": True,
                "reason": "No HCD snapshot is available; do not infer annual delivery from BPS permits."}
    try:
        pointer = read_json(base / "latest.json")
        folder = base / "releases" / pointer["release"]
        manifest = read_json(folder / "manifest.json")
        payload = (folder / "annual.json").read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if digest != pointer["bundle_sha256"] or digest != manifest["bundle_sha256"] or manifest["release"] != pointer["release"]:
            raise ValueError("HCD pointer, manifest and annual payload do not agree")
        dataset = json.loads(payload)
        year = manifest["latest_year"]
        if year != max(dataset["years"]):
            raise ValueError("HCD coverage year does not match the annual payload")
        # Annual data from a later validated snapshot must not support an earlier issue.
        cutoff = month_end(issue_month)
        if manifest["created_at"][:10] > cutoff or f"{year}-12-31" > cutoff:
            return {"status": "outside_issue", "review_required": True,
                    "reason": "The HCD snapshot was validated after the issue cutoff or contains a later reporting year; exclude it from this issue."}
        prior = (latest or {}).get("housing_supply_review", {})
        if prior.get("sha256") == digest:
            status = "unchanged"
        elif not prior.get("sha256"):
            status = "first_review"
        elif year > prior.get("latest_year", 0):
            status = "new_annual_year"
        elif year < prior.get("latest_year", 0):
            raise ValueError("HCD reporting year regressed")
        else:
            status = "revised_annual_snapshot"
        rows = []
        current_index = dataset["years"].index(year)
        for county in ("Los Angeles County", "Orange County"):
            cities = [r for r in dataset["regions"] if r["county"] == county and r["jurisdiction_type"] == "incorporated_city"]
            observed = sum(r["annual"][current_index] is not None and r["annual"][current_index]["completions"]["total"] is not None for r in cities)
            rows.append({"county": county, "reporting_cities": observed, "reference_cities": len(cities)})
        return {"status": status, "review_required": status != "unchanged", "provider": "California HCD APR",
                "release": pointer["release"], "sha256": digest, "latest_year": year,
                "validated_at": manifest["created_at"], "coverage": rows,
                "reason": "Annual context only; this does not advance a monthly question or certify complete reporting."}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {"status": "invalid", "review_required": True, "reason": f"HCD evidence is ineligible: {error}"}


def supply_review_markdown(review: dict[str, Any]) -> str:
    text = ("\n### Housing Supply review (separate annual check)\n\n"
            f"HCD status: **{review['status']}**. {review['reason']}\n")
    if "release" in review:
        text += f"\nAnnual coverage: {review['latest_year']}; release `{review['release']}`; SHA-256 `{review['sha256']}`.\n"
        for row in review["coverage"]:
            text += f"- {row['county']}: {row['reporting_cities']} of {row['reference_cities']} cities have reported completion totals.\n"
    return text + (
        "\n- [ ] Keep Census BPS monthly/YTD authorizations separate from HCD annual permitted/completed units.\n"
        "- [ ] Treat HCD revisions as revisions, not new monthly activity; review first or changed snapshots before adding findings.\n"
        "- [ ] Use matched cities and reporting years for changes; missing values and zero-base growth remain unavailable.\n"
        "- [ ] State the county pool, coverage, metric, and year for rankings; identify city medians as unweighted, not county totals.\n"
        "- [ ] Do not infer starts, actual occupancy, net stock growth, backlog, or a cohort completion rate from these annual flows.\n"
        "- [ ] Confirm any added HCD finding is supported by the eligible release and cite that release explicitly.\n"
    )


def housing_context_review(data_root: Path, latest: dict[str, Any] | None, issue_month: str) -> dict[str, Any]:
    """Track the non-overlapping ACS context release outside monthly finding selection."""
    base = data_root / "acs"
    if not (base / "latest.json").exists():
        return {"status": "unavailable", "review_required": True,
                "reason": "No ACS housing-context snapshot is available; do not infer structural conditions from monthly market series."}
    try:
        pointer = read_json(base / "latest.json")
        folder = base / "releases" / pointer["release"]
        manifest = read_json(folder / "manifest.json")
        files = {
            name: (folder / name).read_bytes()
            for names in manifest["files"].values()
            for name in names
        }
        digest = bundle_sha(files)
        if (
            manifest["release"] != pointer["release"]
            or digest != pointer["bundle_sha256"]
            or digest != manifest["bundle_sha256"]
        ):
            raise ValueError("ACS pointer, manifest and compact payloads do not agree")
        issue_end = month_end(issue_month)
        if manifest["created_at"][:10] > issue_end or f"{manifest['latest_year']}-12-31" > issue_end:
            return {"status": "outside_issue", "review_required": True,
                    "reason": "The ACS snapshot was validated after the issue cutoff or represents a later period; exclude it from this issue."}
        prior = (latest or {}).get("housing_context_review", {})
        if prior.get("sha256") == digest:
            status = "unchanged"
        elif not prior.get("sha256"):
            status = "first_review"
        elif manifest["latest_year"] > prior.get("latest_year", 0):
            status = "new_vintage"
        elif manifest["latest_year"] < prior.get("latest_year", 0):
            raise ValueError("ACS vintage regressed")
        else:
            status = "revised_snapshot"
        coverage = []
        for geography, names in manifest["files"].items():
            rows = sum(len(read_json(folder / name)["regions"]) for name in names)
            coverage.append({"geography": geography, "regions": rows})
        return {
            "status": status,
            "review_required": status != "unchanged",
            "provider": "U.S. Census Bureau ACS five-year estimates",
            "release": pointer["release"],
            "sha256": digest,
            "latest_year": manifest["latest_year"],
            "comparison_year": manifest["comparison_year"],
            "validated_at": manifest["created_at"],
            "coverage": coverage,
            "reason": "Structural context only; this does not advance a monthly question or imply a current market change.",
        }
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {"status": "invalid", "review_required": True, "reason": f"ACS evidence is ineligible: {error}"}


def context_review_markdown(review: dict[str, Any]) -> str:
    text = ("\n### Housing Context review (separate structural check)\n\n"
            f"ACS status: **{review['status']}**. {review['reason']}\n")
    if "release" in review:
        text += (
            f"\nLatest five-year vintage: {review['latest_year']}; non-overlapping comparison: "
            f"{review['comparison_year']}; release `{review['release']}`; SHA-256 `{review['sha256']}`.\n"
        )
        for row in review["coverage"]:
            text += f"- {row['geography']}: {row['regions']} retained regions.\n"
    return text + (
        "\n- [ ] Keep structural ACS estimates separate from monthly market signals.\n"
        "- [ ] Retain 90% margins of error and use non-overlapping five-year periods for change.\n"
        "- [ ] Do not interpret estimate differences as statistically meaningful without considering uncertainty.\n"
        "- [ ] Confirm any added ACS finding cites the exact vintage, geography, universe, and release.\n"
    )


def write_outputs(path: Path | None, values: dict[str, str]) -> None:
    if not path:
        return
    with path.open("a") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    data_root = args.data_root
    packet = read_json(data_root / "facts" / "latest.json")
    snapshot, pool = build_current_snapshot(packet)
    archive_dir = data_root / "briefs"
    archive_dir.mkdir(parents=True, exist_ok=True)
    (archive_dir / "current.json").write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
    index_path = archive_dir / "index.json"
    index = read_json(index_path)
    today = date.fromisoformat(args.today) if args.today else datetime.now(ZoneInfo("America/Los_Angeles")).date()
    issue_month = args.issue_month or today.strftime("%Y-%m")
    if not re.fullmatch(r"\d{4}-\d{2}", issue_month):
        raise ValueError("Issue month must use YYYY-MM format")
    existing = next((item for item in index["briefs"] if item["issue_month"] == issue_month), None)
    latest_entry = max(index["briefs"], key=lambda item: item["issue_month"], default=None)
    latest = read_json(archive_dir / latest_entry["path"]) if latest_entry else None
    supply_review = housing_supply_review(data_root, latest, issue_month)
    context_review = housing_context_review(data_root, latest, issue_month)
    prior_periods: dict[str, str] = {}
    for archived_entry in index["briefs"]:
        archived = read_json(archive_dir / archived_entry["path"])
        for item in archived["sections"]:
            key = item.get("question_id", LEGACY_QUESTION_IDS.get(question_key(item["question"]), question_key(item["question"])))
            prior_periods[key] = max(prior_periods.get(key, "0000-00-00"), item["period_end"])
    selected, suppressed = select_findings(pool, prior_periods)
    reasons = []
    if existing:
        reasons.append(f"{issue_month} is already in the approved archive")
    if latest and packet["packet_sha256"] == latest["source_packet_sha256"]:
        reasons.append("the current fact packet is already represented by the latest archive")
    if not selected and not args.force:
        reasons.append(
            "no newer question qualified through material movement, broad local shift, "
            "direction change, or pre-specified indicator divergence"
        )
    issue_end = month_end(issue_month)
    if any(item["period_end"] > issue_end for item in selected):
        reasons.append("the selected evidence extends beyond the issue month")
    ready = not reasons

    result = {
        "housing_supply_review": supply_review,
        "housing_context_review": context_review,
        "ready": ready,
        "issue_month": issue_month,
        "advanced_questions": [item["question"] for item in selected],
        "qualified_findings": [item["question_id"] for item in selected],
        "qualification_paths": sorted({rule["id"] for item in selected for rule in item["qualifications"]}),
        "suppressed_related_findings": [item["question_id"] for item in suppressed],
        "monitored_questions": len(pool),
        "reason": "; ".join(reasons) if reasons else "readiness checks passed",
        "packet_sha256": packet["packet_sha256"],
    }
    if not ready:
        return result

    issue_label = datetime.strptime(issue_month, "%Y-%m").strftime("%B %Y")
    if not selected and args.force:
        selected, _ = select_findings(pool)
    headline, summary = finding_headline_and_summary(selected)
    brief = {
        "schema_version": 3,
        "status": "published",
        "issue_month": issue_month,
        "observation_cutoff": max((item["period_end"] for item in selected), default=issue_end),
        "prepared_at": today.isoformat(),
        "title": f"{issue_label} Housing Market Brief",
        "headline": headline,
        "summary": summary,
        "reconstruction_note": "Prepared from the Lab’s validated fact packet. Each finding retains its observation period and source release; later provider revisions do not silently alter this archived edition.",
        "source_packet_sha256": packet["packet_sha256"],
        "source_releases": source_releases(packet),
        "selection_method": {
            "question_pool": len(pool),
            "qualification_paths": BRIEF_CONFIG["qualification_paths"],
            "maximum_findings": BRIEF_CONFIG["selection"]["maximum_findings"],
            "maximum_per_theme": BRIEF_CONFIG["selection"]["maximum_per_theme"],
        },
        "sections": selected,
        "housing_supply_review": supply_review,
        "housing_context_review": context_review,
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
    supply_note = supply_review_markdown(result["housing_supply_review"])
    context_note = context_review_markdown(result["housing_context_review"])
    if not result["ready"]:
        return f"## Market brief readiness\n\nNo draft is recommended: {result['reason']}.\n\n### Questions with newer evidence\n\n{questions}\n" + supply_note + context_note
    return (
        f"## Proposed {result['issue_month']} market brief\n\n"
        "This candidate was generated deterministically from the current validated fact packet. "
        "Merging this draft pull request is the publication approval step.\n\n"
        f"The internal registry evaluated {result['monitored_questions']} questions. Only findings that passed a "
        "pre-specified qualification path and the one-per-theme editorial cap appear below.\n\n"
        "### Qualified findings with newer evidence\n\n"
        f"{questions}\n\n"
        f"Qualification paths: {', '.join(result['qualification_paths']) or 'manual review'}.\n\n"
        "### Reviewer checklist\n\n"
        "- [ ] Every number matches its evidence line.\n"
        "- [ ] Observation periods are clear and compatible.\n"
        "- [ ] Preliminary permit evidence is labeled.\n"
        "- [ ] No causal claim or forecast has been introduced.\n"
        "- [ ] Source releases and the fact-packet fingerprint are retained.\n\n"
        f"Fact packet: `{result['packet_sha256']}`\n"
        + supply_note
        + context_note
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    parser.add_argument("--issue-month")
    parser.add_argument("--today", help="ISO date override for reproducible tests")
    parser.add_argument("--force", action="store_true", help="Prepare a maintainer-requested review even when no newer finding qualifies")
    parser.add_argument("--snapshot-only", action="store_true", help="Write the selective current snapshot without preparing an archive candidate")
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--review-note", type=Path)
    args = parser.parse_args()
    if args.snapshot_only:
        packet = read_json(args.data_root / "facts" / "latest.json")
        print(json.dumps(write_current_snapshot(args.data_root, packet)))
        return
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
