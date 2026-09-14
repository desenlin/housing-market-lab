import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FactEngineTests(unittest.TestCase):
    def test_current_release_builds_auditable_packet(self):
        subprocess.run(
            ["python", "pipeline/build_fact_engine.py"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        packet = json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())
        self.assertEqual(packet["status"], "prototype")
        self.assertEqual(len(packet["packet_sha256"]), 64)
        self.assertGreaterEqual(packet["summary"]["candidates"], 1)
        self.assertEqual(packet["summary"]["candidates"], len(packet["facts"]))
        self.assertTrue(all(item["release"] for item in packet["facts"]))
        self.assertTrue(all(item["evidence"] for item in packet["facts"]))

    def test_preliminary_permit_facts_require_review(self):
        packet = json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())
        permits = [item for item in packet["facts"] if item["metric"] == "permits_ytd"]
        self.assertTrue(permits)
        self.assertTrue(all(item["provisional"] for item in permits))
        self.assertTrue(all(item["confidence"] == "review" for item in permits))

    def test_percentage_change_is_not_labeled_percentage_points(self):
        packet = json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())
        inflation = next(item for item in packet["facts"] if item["metric"] == "cpi_la")
        self.assertNotIn("percentage points", inflation["change_display"])
        self.assertTrue(inflation["change_display"].endswith("%"))

    def test_historical_brief_archive_is_auditable(self):
        archive_dir = ROOT / "public" / "data" / "briefs"
        index = json.loads((archive_dir / "index.json").read_text())
        self.assertEqual(len(index["briefs"]), 1)
        entry = index["briefs"][0]
        brief = json.loads((archive_dir / entry["path"]).read_text())

        self.assertEqual(entry["status"], "historical_reconstruction")
        self.assertEqual(brief["status"], "historical_reconstruction")
        self.assertEqual(brief["issue_month"], "2026-08")
        self.assertLessEqual(brief["observation_cutoff"], "2026-07-31")
        self.assertEqual(len(brief["source_packet_sha256"]), 64)
        self.assertTrue(all(len(source["sha256"]) == 64 for source in brief["source_releases"]))
        self.assertTrue(all(section["observation_period"] for section in brief["sections"]))
        permit_section = next(section for section in brief["sections"] if "permitting" in section["question"])
        self.assertEqual(permit_section["status"], "preliminary")
        self.assertIn("may be revised or imputed", permit_section["caveat"])
        self.assertTrue(all(section["fact_ids"] for section in brief["sections"]))
        self.assertTrue(all(section["period_end"] <= brief["observation_cutoff"] for section in brief["sections"]))

    def test_price_brief_uses_common_month_inflation(self):
        from pipeline.prepare_market_brief import month_end, question_sections

        packet = json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())
        real_price = next(item for item in packet["facts"] if item["metric"] == "real_zhvi")
        latest_inflation = next(item for item in packet["facts"] if item["metric"] == "cpi_la")
        price_section = question_sections(packet)[0]

        self.assertEqual(price_section["period_end"], month_end(real_price["period"]))
        self.assertIn(real_price["inflation_change_display"], price_section["answer"])
        if latest_inflation["period"] != real_price["period"]:
            self.assertNotIn(latest_inflation["change_display"], price_section["answer"])

    def test_price_brief_answer_follows_the_real_change_sign(self):
        from pipeline.prepare_market_brief import question_sections

        packet = json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())
        real_price = next(item for item in packet["facts"] if item["metric"] == "real_zhvi")
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
            self.assertIn("1 additional market had paired observations", result["coverage"])

    def test_archive_draft_is_skipped_without_new_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory) / "data"
            shutil.copytree(ROOT / "public" / "data" / "facts", data_root / "facts")
            shutil.copytree(ROOT / "public" / "data" / "briefs", data_root / "briefs")
            output = Path(directory) / "output.txt"
            result = subprocess.run(
                [
                    "python", "pipeline/prepare_market_brief.py",
                    "--data-root", str(data_root),
                    "--issue-month", "2026-09",
                    "--today", "2026-09-18",
                    "--github-output", str(output),
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            status = json.loads(result.stdout)
            self.assertFalse(status["ready"])
            self.assertIn("only 0 recurring questions advanced", status["reason"])
            self.assertFalse((data_root / "briefs" / "2026-09.json").exists())
            self.assertIn("ready=false", output.read_text())

    def test_archive_draft_is_created_for_one_new_material_question(self):
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory) / "data"
            shutil.copytree(ROOT / "public" / "data" / "facts", data_root / "facts")
            shutil.copytree(ROOT / "public" / "data" / "briefs", data_root / "briefs")
            packet_path = data_root / "facts" / "latest.json"
            packet = json.loads(packet_path.read_text())
            for fact in packet["facts"]:
                if fact["metric"] in {"real_zhvi", "zhvi", "cpi_la"}:
                    fact["period"] = "2026-08-31"
            packet["packet_sha256"] = "a" * 64
            packet_path.write_text(json.dumps(packet))
            review = Path(directory) / "review.md"
            result = subprocess.run(
                [
                    "python", "pipeline/prepare_market_brief.py",
                    "--data-root", str(data_root),
                    "--issue-month", "2026-09",
                    "--today", "2026-09-24",
                    "--review-note", str(review),
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            status = json.loads(result.stdout)
            brief = json.loads((data_root / "briefs" / "2026-09.json").read_text())
            index = json.loads((data_root / "briefs" / "index.json").read_text())
            self.assertTrue(status["ready"])
            self.assertEqual(len(status["advanced_questions"]), 1)
            self.assertEqual(status["advanced_questions"], status["advanced_material_questions"])
            self.assertEqual(index["briefs"][0]["issue_month"], "2026-09")
            self.assertEqual(brief["status"], "published")
            self.assertEqual(brief["schema_version"], 2)
            self.assertEqual(brief["source_packet_sha256"], "a" * 64)
            self.assertEqual(brief["headline"], "New evidence on inflation-adjusted home values")
            self.assertNotIn("permit", brief["summary"].lower())
            self.assertTrue(all(section["trigger_fact_id"] in section["fact_ids"] for section in brief["sections"]))
            permit_section = next(section for section in brief["sections"] if "permitting" in section["question"])
            self.assertIn("not an official BPS metro series", permit_section["coverage"])
            self.assertIn("Merging this draft pull request is the publication approval step", review.read_text())

    def test_supporting_fact_cannot_trigger_a_single_question_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory) / "data"
            shutil.copytree(ROOT / "public" / "data" / "facts", data_root / "facts")
            shutil.copytree(ROOT / "public" / "data" / "briefs", data_root / "briefs")
            packet_path = data_root / "facts" / "latest.json"
            packet = json.loads(packet_path.read_text())
            for fact in packet["facts"]:
                if fact["metric"] in {"real_zhvi", "zhvi", "cpi_la"}:
                    fact["period"] = "2026-08-31"
                if fact["metric"] == "real_zhvi":
                    fact["material"] = False
                if fact["metric"] == "zhvi":
                    fact["material"] = True
            packet["packet_sha256"] = "b" * 64
            packet_path.write_text(json.dumps(packet))
            result = subprocess.run(
                [
                    "python", "pipeline/prepare_market_brief.py",
                    "--data-root", str(data_root),
                    "--issue-month", "2026-09",
                    "--today", "2026-09-24",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            status = json.loads(result.stdout)
            self.assertFalse(status["ready"])
            self.assertEqual(status["advanced_material_questions"], [])

    def test_forced_review_without_new_periods_uses_a_neutral_headline(self):
        from pipeline.prepare_market_brief import brief_headline_and_summary

        headline, summary = brief_headline_and_summary([], [])
        self.assertEqual(headline, "Review of recurring Los Angeles housing indicators")
        self.assertIn("maintainer-requested review", summary)
        self.assertNotIn("New evidence", headline)


if __name__ == "__main__":
    unittest.main()
