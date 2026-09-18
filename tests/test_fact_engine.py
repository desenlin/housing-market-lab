import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FactEngineTests(unittest.TestCase):
    def packet(self):
        return json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())

    def fixture_packet(self):
        # Decision-rule expectations use the packet from commit 95ce19c, before
        # September 18's refresh. Live observations must not change this scenario.
        return json.loads((ROOT / "tests" / "fixtures" / "fact-packet-2026-09-17.json").read_text())

    def archive_fixture(self, data_root):
        (data_root / "facts").mkdir(parents=True)
        (data_root / "facts" / "latest.json").write_text(json.dumps(self.fixture_packet()))
        source = ROOT / "public" / "data" / "briefs"
        target = data_root / "briefs"
        target.mkdir()
        index = json.loads((source / "index.json").read_text())
        # Only these historical editions belong to the October test scenario.
        # Later approved briefs must not pre-fill its test issue month.
        index["briefs"] = [entry for entry in index["briefs"]
                           if entry["issue_month"] in {"2026-08", "2026-09"}]
        self.assertEqual({entry["issue_month"] for entry in index["briefs"]}, {"2026-08", "2026-09"})
        (target / "index.json").write_text(json.dumps(index))
        for entry in index["briefs"]:
            shutil.copyfile(source / entry["path"], target / entry["path"])

    def test_current_release_builds_auditable_packet(self):
        subprocess.run(["python", "pipeline/build_fact_engine.py"], cwd=ROOT, check=True, capture_output=True, text=True)
        packet = self.packet()
        self.assertEqual(packet["schema_version"], 2)
        self.assertEqual(packet["status"], "operational")
        self.assertEqual(len(packet["packet_sha256"]), 64)
        self.assertEqual(packet["summary"]["candidates"], len(packet["facts"]))
        self.assertTrue(all(item["release"] and item["evidence"] for item in packet["facts"]))

    def test_preliminary_permit_facts_require_review(self):
        permits = [item for item in self.packet()["facts"] if item["metric"] == "permits_ytd"]
        self.assertTrue(permits)
        self.assertTrue(all(item["provisional"] and item["confidence"] == "review" for item in permits))

    def test_percentage_change_is_not_labeled_percentage_points(self):
        inflation = next(item for item in self.packet()["facts"] if item["metric"] == "cpi_la")
        self.assertNotIn("percentage points", inflation["change_display"])
        self.assertTrue(inflation["change_display"].endswith("%"))

    def test_august_reconstruction_is_immutable_and_september_is_selective(self):
        archive_dir = ROOT / "public" / "data" / "briefs"
        index = json.loads((archive_dir / "index.json").read_text())
        entries = {entry["issue_month"]: entry for entry in index["briefs"]}
        self.assertTrue({"2026-08", "2026-09"}.issubset(entries))

        august_bytes = (archive_dir / entries["2026-08"]["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(august_bytes).hexdigest(), "b1d8de7f2d867b45d04eb521255a88b89ad46461ebc6e1da0ddebabae28b73c0")
        august = json.loads(august_bytes)
        self.assertEqual(august["status"], "historical_reconstruction")
        self.assertEqual(august["issue_month"], "2026-08")
        permit_section = next(section for section in august["sections"] if "permitting" in section["question"])
        self.assertEqual(permit_section["status"], "preliminary")
        self.assertIn("may be revised or imputed", permit_section["caveat"])

        september = json.loads((archive_dir / entries["2026-09"]["path"]).read_text())
        self.assertEqual(september["schema_version"], 3)
        self.assertEqual(september["status"], "published")
        self.assertEqual(
            [section["question_id"] for section in september["sections"]],
            ["median_sale_ppsf-los-angeles-county", "median_dom-orange-county"],
        )
        self.assertTrue(all(section["qualifications"] for section in september["sections"]))
        self.assertTrue(all(section["source_releases"] for section in september["sections"]))
        self.assertNotIn("permits", september["headline"].lower())
        self.assertEqual(september["housing_supply_review"]["status"], "first_review")
        self.assertEqual(september["housing_context_review"]["status"], "first_review")
        self.assertEqual(september["housing_context_review"]["latest_year"], 2024)

    def test_price_brief_uses_common_month_and_follows_real_change_sign(self):
        from pipeline.prepare_market_brief import month_end, question_sections

        packet = self.fixture_packet()
        real_price = next(item for item in packet["facts"] if item["metric"] == "real_zhvi")
        latest_inflation = next(item for item in packet["facts"] if item["metric"] == "cpi_la")
        price_section = question_sections(packet)[0]
        self.assertEqual(price_section["period_end"], month_end(real_price["period"]))
        self.assertIn(real_price["inflation_change_display"], price_section["answer"])
        if latest_inflation["period"] != real_price["period"]:
            self.assertNotIn(latest_inflation["change_display"], price_section["answer"])
        for change, expected in [(0.01, "Yes."), (-0.01, "No."), (0, "Yes.")]:
            real_price["change"] = change
            self.assertTrue(question_sections(packet)[0]["answer"].startswith(expected))

    def test_breadth_distinguishes_increases_decreases_and_unchanged_markets(self):
        from pipeline.build_fact_engine import breadth_facts

        with tempfile.TemporaryDirectory() as directory:
            release_dir = Path(directory)
            dates = [f"2025-{month:02d}" for month in range(1, 13)] + ["2026-01"]
            def series(prior, current):
                return [prior, *([None] * 11), current]
            payload = {
                "metrics": {"new_listing_count": {"dates": dates}},
                "regions": [
                    {"series": {"new_listing_count": series(1, 2)}},
                    {"series": {"new_listing_count": series(2, 1)}},
                    {"series": {"new_listing_count": series(1, 1)}},
                    {"series": {"new_listing_count": series(0, 1)}},
                    {"series": {"new_listing_count": series(1, None)}},
                ],
            }
            (release_dir / "orange.json").write_text(json.dumps(payload))
            result = breadth_facts(
                "fixture", "Fixture provider", "fixture-release", release_dir,
                ["orange.json"], ["new_listing_count"], "fixture",
            )[0]
            self.assertIn("1 increased, 1 decreased, and 1 was unchanged", result["evidence"])
            self.assertIn("3 of 5 local markets had calculable", result["coverage"])
            self.assertEqual(result["calculable_count"], 3)
            self.assertEqual(result["breadth_count"], 1)

    def test_expanded_registry_uses_multiple_meaningful_finding_paths(self):
        from pipeline.prepare_market_brief import build_current_snapshot, expanded_question_pool

        packet = self.fixture_packet()
        pool = expanded_question_pool(packet)
        snapshot, _ = build_current_snapshot(packet)
        self.assertEqual(len(pool), 27)
        self.assertEqual(snapshot["monitoring"]["question_count"], 27)
        self.assertLessEqual(len(snapshot["sections"]), 4)
        self.assertEqual(len({section["theme"] for section in snapshot["sections"]}), len(snapshot["sections"]))
        orange_speed = next(section for section in pool if section["question_id"] == "median_dom-orange-county")
        speed_fact = next(item for item in packet["facts"] if item["id"] == orange_speed["trigger_fact_id"])
        self.assertFalse(speed_fact["material"])
        self.assertIn("broad_local_shift", [rule["id"] for rule in orange_speed["qualifications"]])
        relationship_ids = {item["question_id"] for item in pool if item["question_id"] in {
            "inventory_price_cuts", "inventory_market_speed", "home_values_rents", "county_sale_prices"
        }}
        self.assertEqual(len(relationship_ids), 4)

    def test_archive_draft_is_skipped_without_new_qualifying_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory) / "data"
            self.archive_fixture(data_root)
            output = Path(directory) / "output.txt"
            result = subprocess.run(
                ["python", "pipeline/prepare_market_brief.py", "--data-root", str(data_root),
                 "--issue-month", "2026-10", "--today", "2026-10-24", "--github-output", str(output)],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            status = json.loads(result.stdout)
            self.assertFalse(status["ready"])
            self.assertIn("no newer question qualified", status["reason"])
            self.assertFalse((data_root / "briefs" / "2026-10.json").exists())
            self.assertIn("ready=false", output.read_text())

    def test_one_new_primary_fact_creates_a_selective_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory) / "data"
            self.archive_fixture(data_root)
            packet_path = data_root / "facts" / "latest.json"
            packet = json.loads(packet_path.read_text())
            for fact in packet["facts"]:
                if fact["metric"] in {"real_zhvi", "zhvi", "cpi_la"}:
                    fact["period"] = "2026-09-30"
            packet["packet_sha256"] = "a" * 64
            packet_path.write_text(json.dumps(packet))
            review = Path(directory) / "review.md"
            result = subprocess.run(
                ["python", "pipeline/prepare_market_brief.py", "--data-root", str(data_root),
                 "--issue-month", "2026-10", "--today", "2026-10-24", "--review-note", str(review)],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            status = json.loads(result.stdout)
            brief = json.loads((data_root / "briefs" / "2026-10.json").read_text())
            self.assertTrue(status["ready"])
            self.assertEqual(status["qualified_findings"], ["real_zhvi-los-angeles-metro"])
            self.assertEqual(brief["schema_version"], 3)
            self.assertEqual(len(brief["sections"]), 1)
            self.assertEqual(brief["headline"], "New evidence on inflation-adjusted home values")
            self.assertIn("Merging this draft pull request is the publication approval step", review.read_text())

    def test_supporting_fact_cannot_trigger_a_question(self):
        from pipeline.prepare_market_brief import expanded_question_pool

        packet = self.fixture_packet()
        for fact in packet["facts"]:
            if fact["metric"] == "real_zhvi":
                fact["material"] = False
                fact["change"] = 0.001
                fact["previous_change"] = None
            if fact["metric"] == "zhvi":
                fact["material"] = True
        real_question = next(
            section for section in expanded_question_pool(packet)
            if section["question_id"] == "real_zhvi-los-angeles-metro"
        )
        self.assertEqual(real_question["qualifications"], [])


if __name__ == "__main__":
    unittest.main()
