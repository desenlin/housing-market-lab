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
        packet = json.loads((ROOT / "public" / "data" / "facts" / "latest.json").read_text())

        self.assertEqual(entry["status"], "historical_reconstruction")
        self.assertEqual(brief["status"], "historical_reconstruction")
        self.assertEqual(brief["issue_month"], "2026-08")
        self.assertLessEqual(brief["observation_cutoff"], "2026-07-31")
        self.assertEqual(brief["source_packet_sha256"], packet["packet_sha256"])
        self.assertTrue(all(len(source["sha256"]) == 64 for source in brief["source_releases"]))
        self.assertTrue(all(section["observation_period"] for section in brief["sections"]))
        permit_section = next(section for section in brief["sections"] if "permitting" in section["question"])
        self.assertEqual(permit_section["status"], "preliminary")
        self.assertIn("may be revised or imputed", permit_section["caveat"])
        self.assertTrue(all(section["fact_ids"] for section in brief["sections"]))
        self.assertTrue(all(section["period_end"] <= brief["observation_cutoff"] for section in brief["sections"]))

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
            self.assertIn("already represented", status["reason"])
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
            self.assertEqual(brief["source_packet_sha256"], "a" * 64)
            self.assertIn("Merging this draft pull request is the publication approval step", review.read_text())


if __name__ == "__main__":
    unittest.main()
