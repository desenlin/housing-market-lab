#!/usr/bin/env python3
"""Build an auditable prototype fact packet from current validated releases."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from statistics import median
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"
CONFIG = json.loads((ROOT / "config" / "fact_engine.json").read_text())


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def current_release(family: str) -> tuple[str, Path, dict[str, Any]]:
    base = PUBLIC / family
    pointer = read_json(base / "latest.json")
    release = pointer["release"]
    release_dir = base / "releases" / release
    return release, release_dir, read_json(release_dir / "manifest.json")


def metric_change(current: float, prior: float, mode: str) -> float | None:
    if mode == "percent":
        return None if prior == 0 else current / prior - 1
    return current - prior


def fmt(value: float, unit: str, change: bool = False, change_mode: str | None = None) -> str:
    if change and change_mode == "percentage_point":
        return f"{value * 100:+.1f} percentage points"
    if change and unit in {"days", "months"}:
        return f"{value:+.1f} {unit}"
    if change:
        return f"{value * 100:+.1f}%"
    if unit == "usd":
        return f"${value:,.0f}"
    if unit == "usd_sqft":
        return f"${value:,.0f}/sq. ft."
    if unit == "share":
        return f"{value * 100:.1f}%"
    if unit in {"number", "units"}:
        return f"{value:,.0f}"
    return f"{value:,.1f} {unit}"


def priority(change: float, threshold: float, breadth: float = 1.0, quality: float = 1.0) -> float:
    magnitude = min(abs(change) / threshold, 4.0) / 4.0 if threshold else 0
    return round(100 * (0.55 * magnitude + 0.25 * breadth + 0.20 * quality), 1)


def fact(*, fact_id: str, provider: str, release: str, metric: str, geography: str,
         period: str, value: float, change: float, comparison: str, breadth: float,
         coverage: str, evidence: str, caveat: str | None = None,
         provisional: bool = False) -> dict[str, Any]:
    spec = CONFIG["metrics"][metric]
    material = abs(change) >= spec["materiality"]
    direction = "increased" if change > 0 else "decreased" if change < 0 else "was unchanged"
    confidence = "review" if provisional or breadth < 0.7 else "high"
    return {
        "id": fact_id,
        "domain": spec["domain"],
        "provider": provider,
        "release": release,
        "metric": metric,
        "metric_label": spec["label"],
        "geography": geography,
        "period": period,
        "value": value,
        "value_display": fmt(value, spec["unit"]),
        "change": change,
        "change_display": fmt(change, spec["unit"], True, spec["change_mode"]),
        "comparison": comparison,
        "direction": direction,
        "material": material,
        "score": priority(change, spec["materiality"], breadth, 0.8 if provisional else 1.0),
        "confidence": confidence,
        "coverage": coverage,
        "evidence": evidence,
        "caveat": caveat,
        "provisional": provisional,
    }


def metro_facts(release: str, release_dir: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    data = read_json(release_dir / "metro.json")
    region = next(r for r in data["regions"] if r["name"] == "Los Angeles, CA")
    facts: list[dict[str, Any]] = []
    current_values: dict[str, Any] = {}
    for key in ("zhvi", "zori", "inventory", "days_pending", "price_cut_share", "sale_to_list"):
        spec = CONFIG["metrics"][key]
        meta = data["metrics"][key]
        values = region["series"][key]
        i = max(i for i, value in enumerate(values) if value is not None)
        if i < 12 or values[i - 12] is None:
            continue
        value = float(values[i])
        change = metric_change(value, float(values[i - 12]), spec["change_mode"])
        if change is None:
            continue
        period = meta["dates"][i]
        current_values[key] = {"value": value, "period": period, "prior": float(values[i - 12])}
        facts.append(fact(
            fact_id=f"zillow-la-metro-{key}", provider="Zillow Research", release=release,
            metric=key, geography="Los Angeles metro", period=period, value=value,
            change=change, comparison="Same month one year earlier", breadth=1,
            coverage="One focus metropolitan series",
            evidence=f"{fmt(value, spec['unit'])} compared with {fmt(float(values[i - 12]), spec['unit'])} one year earlier.",
            caveat="Descriptive metropolitan estimate; not a causal or predictive measure."
        ))
    return facts, current_values


def breadth_facts(family: str, provider: str, release: str, release_dir: Path,
                  files: list[str], metric_keys: list[str], prefix: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for filename in files:
        data = read_json(release_dir / filename)
        county = "Orange County" if "orange" in filename else "Los Angeles County"
        for key in metric_keys:
            if key not in data["metrics"]:
                continue
            spec = CONFIG["metrics"][key]
            dates = data["metrics"][key]["dates"]
            changes: list[float] = []
            current: list[float] = []
            eligible = 0
            for region in data["regions"]:
                values = region["series"].get(key, [])
                if len(values) < 13:
                    continue
                i = len(values) - 1
                if values[i] is None or values[i - 12] is None:
                    continue
                # Realtor quality arrays contain provider-flagged observation indexes.
                if family.startswith("realtor") and i in region.get("quality", {}).get("inventory", []):
                    continue
                eligible += 1
                delta = metric_change(float(values[i]), float(values[i - 12]), spec["change_mode"])
                if delta is not None and math.isfinite(delta):
                    changes.append(delta)
                    current.append(float(values[i]))
            total = len(data["regions"])
            if not changes or total == 0:
                continue
            med = median(changes)
            positive = sum(change > 0 for change in changes)
            breadth = max(positive, len(changes) - positive) / len(changes)
            direction_word = "increases" if positive >= len(changes) / 2 else "decreases"
            caveat = "Unweighted median across covered local markets; it is not a county aggregate."
            if family.startswith("redfin"):
                caveat = "Unweighted median across covered cities using Redfin rolling three-month estimates; it is not a county aggregate."
            output.append(fact(
                fact_id=f"{prefix}-{county.lower().replace(' ', '-')}-{key}", provider=provider,
                release=release, metric=key, geography=county, period=dates[-1],
                value=median(current), change=med, comparison="Median local change from one year earlier",
                breadth=breadth, coverage=f"{eligible} of {total} local markets eligible",
                evidence=f"The median local change was {fmt(med, spec['unit'], True, spec['change_mode'])}; {max(positive, len(changes)-positive)} of {len(changes)} eligible markets recorded {direction_word}.",
                caveat=caveat
            ))
    return output


def cpi_and_real_fact(cpi_release: str, cpi_dir: Path, zillow_release: str,
                      zillow_values: dict[str, Any]) -> list[dict[str, Any]]:
    data = read_json(cpi_dir / "cpi.json")
    la = data["series"]["la"]
    i = max(i for i, value in enumerate(la["values"]) if value is not None)
    inflation = float(la["yoy"][i])
    facts = [fact(
        fact_id="bls-la-cpi", provider="U.S. Bureau of Labor Statistics", release=cpi_release,
        metric="cpi_la", geography="Los Angeles–Long Beach–Anaheim", period=la["dates"][i],
        value=float(la["values"][i]), change=inflation, comparison="Same month one year earlier",
        breadth=1, coverage="Official LA-area CPI-U series",
        evidence=f"CPI-U was {la['values'][i]:.3f}, an increase of {inflation * 100:.1f}% from one year earlier.",
        caveat="Not seasonally adjusted; the area index covers Los Angeles and Orange Counties."
    )]
    zhvi = zillow_values.get("zhvi")
    if zhvi and zhvi["period"][:7] in {date[:7] for date in la["dates"]}:
        cpi_index = next(j for j, date in enumerate(la["dates"]) if date[:7] == zhvi["period"][:7])
        if cpi_index >= 12 and la["values"][cpi_index - 12]:
            nominal = zhvi["value"] / zhvi["prior"]
            inflation_ratio = float(la["values"][cpi_index]) / float(la["values"][cpi_index - 12])
            real_change = nominal / inflation_ratio - 1
            facts.append(fact(
                fact_id="derived-la-real-zhvi", provider="Zillow Research + BLS CPI-U",
                release=f"{zillow_release} + {cpi_release}", metric="real_zhvi",
                geography="Los Angeles metro", period=zhvi["period"], value=zhvi["value"],
                change=real_change, comparison="Inflation-adjusted change from one year earlier",
                breadth=1, coverage="Common-month Zillow ZHVI and LA-area CPI-U",
                evidence=f"Nominal ZHVI changed {(nominal-1)*100:+.1f}% while LA-area CPI-U changed {(inflation_ratio-1)*100:+.1f}%.",
                caveat="Real change is a purchasing-power comparison, not an affordability measure."
            ))
    return facts


def permit_facts(provisional_release: str, provisional_dir: Path, history_dir: Path) -> list[dict[str, Any]]:
    current = read_json(provisional_dir / "monthly.json")
    history = read_json(history_dir / "monthly.json")
    months = current["dates"]
    prior_months = [f"{int(month[:4])-1}{month[4:]}" for month in months]
    history_indexes = {date: i for i, date in enumerate(history["dates"])}
    current_by_id = {region["id"]: region for region in current["regions"]}
    output = []
    for county in ("Los Angeles County", "Orange County"):
        now = prior = jurisdictions = 0
        for old_region in history["regions"]:
            if old_region["county"] != county or old_region["id"] not in current_by_id:
                continue
            new_region = current_by_id[old_region["id"]]
            current_values = new_region["series"]["total_units"]
            previous_values = old_region["series"]["total_units"]
            if any(value is None for value in current_values):
                continue
            comparable = [previous_values[history_indexes[month]] for month in prior_months]
            if any(value is None for value in comparable):
                continue
            now += sum(current_values)
            prior += sum(comparable)
            jurisdictions += 1
        if not jurisdictions or prior == 0:
            continue
        change = now / prior - 1
        output.append(fact(
            fact_id=f"permits-{county.lower().replace(' ', '-')}-ytd", provider="U.S. Census Bureau Building Permits Survey",
            release=provisional_release, metric="permits_ytd", geography=county,
            period=f"{months[0]} through {months[-1]}", value=float(now), change=change,
            comparison=f"Same months of {int(months[-1][:4])-1}", breadth=1,
            coverage=f"{jurisdictions} matched permit jurisdictions",
            evidence=f"{now:,.0f} units were authorized, compared with {prior:,.0f} in the same months one year earlier.",
            caveat="Current-year observations are preliminary and may be revised or imputed; permits are authorizations, not starts or completions.",
            provisional=True
        ))
    return output


def main() -> None:
    z_release, z_dir, z_manifest = current_release("")
    r_release, r_dir, r_manifest = current_release("redfin")
    ri_release, ri_dir, ri_manifest = current_release("realtor/inventory")
    c_release, c_dir, c_manifest = current_release("cpi")
    p_release, p_dir, p_manifest = current_release("permits/provisional")
    _, ph_dir, ph_manifest = current_release("permits/history")

    facts, zillow_values = metro_facts(z_release, z_dir)
    facts += breadth_facts("redfin", "Redfin", r_release, r_dir, r_manifest["files"]["city"],
                           ["months_supply", "median_dom", "sold_above_original_share", "price_drop_share", "median_sale_ppsf"], "redfin")
    facts += breadth_facts("realtor/inventory", "Realtor.com® Economic Research", ri_release, ri_dir,
                           ri_manifest["files"]["zip"], ["active_listing_count", "new_listing_count", "pending_ratio"], "realtor")
    facts += cpi_and_real_fact(c_release, c_dir, z_release, zillow_values)
    facts += permit_facts(p_release, p_dir, ph_dir)
    facts.sort(key=lambda item: (not item["material"], -item["score"], item["id"]))

    source_releases = {
        "zillow": {"release": z_release, "sha256": z_manifest["bundle_sha256"]},
        "redfin": {"release": r_release, "sha256": r_manifest["bundle_sha256"]},
        "realtor_inventory": {"release": ri_release, "sha256": ri_manifest["bundle_sha256"]},
        "cpi": {"release": c_release, "sha256": c_manifest["bundle_sha256"]},
        "permits_provisional": {"release": p_release, "sha256": p_manifest["bundle_sha256"]},
        "permits_history": {"release": ph_manifest["release"], "sha256": ph_manifest["bundle_sha256"]},
    }
    generated_at = max(
        manifest["created_at"]
        for manifest in (z_manifest, r_manifest, ri_manifest, c_manifest, p_manifest, ph_manifest)
    )
    packet = {
        "schema_version": 1,
        "status": "prototype",
        "generated_at": generated_at,
        "data_cutoff": max(item["period"].split(" through ")[-1] for item in facts),
        "method": "Deterministic calculations only; no language model generated these facts.",
        "source_releases": source_releases,
        "summary": {
            "candidates": len(facts),
            "material": sum(item["material"] for item in facts),
            "high_confidence": sum(item["confidence"] == "high" for item in facts),
            "review_required": sum(item["confidence"] != "high" for item in facts),
        },
        "facts": facts,
    }
    canonical = json.dumps(packet, sort_keys=True, separators=(",", ":")).encode()
    packet["packet_sha256"] = hashlib.sha256(canonical).hexdigest()
    output_dir = PUBLIC / "facts"
    output_dir.mkdir(exist_ok=True)
    (output_dir / "latest.json").write_text(json.dumps(packet, indent=2) + "\n")
    print(f"Wrote {len(facts)} candidate facts; {packet['summary']['material']} exceed materiality thresholds.")


if __name__ == "__main__":
    main()
