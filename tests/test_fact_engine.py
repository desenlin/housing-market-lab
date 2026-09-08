import json
import subprocess
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


if __name__ == "__main__":
    unittest.main()
