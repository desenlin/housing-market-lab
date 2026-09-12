import json
from pathlib import Path
import tempfile
import unittest

from scripts.data_update_report import (
    current_pointers,
    markdown_report,
    report_rows,
)


class DataUpdateReportTests(unittest.TestCase):
    def write_release(self, root: Path, pointer_path: str, release: str, manifest: dict) -> None:
        pointer = root / pointer_path
        release_root = pointer.parent / "releases" / release
        release_root.mkdir(parents=True, exist_ok=True)
        pointer.write_text(json.dumps({"release": release}), encoding="utf-8")
        (release_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def test_reports_changed_unchanged_and_retained_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_release(
                root,
                "public/data/redfin/latest.json",
                "old-redfin",
                {"latest_observations": {"activity": "2026-07-31"}},
            )
            self.write_release(
                root,
                "public/data/cpi/latest.json",
                "current-cpi",
                {"series": {"us": {"latest_observation": "2026-07-31"}}},
            )
            before = current_pointers(root)
            self.write_release(
                root,
                "public/data/redfin/latest.json",
                "new-redfin",
                {"latest_observations": {
                    "price_drops": "2026-07-31",
                    "activity": "2026-08-31",
                }},
            )

            rows = report_rows(root, before, {"redfin": 0, "cpi": 1})

            self.assertEqual(rows[0], {
                "source": "Redfin market activity",
                "result": "Published",
                "coverage": "July–August 2026",
                "release": "new-redfin",
            })
            self.assertEqual(rows[1]["source"], "BLS CPI")
            self.assertEqual(rows[1]["result"], "Retained — refresh error")

    def test_markdown_mentions_only_the_github_recipient(self) -> None:
        report = markdown_report(
            [{
                "source": "Redfin market activity",
                "result": "Published",
                "coverage": "August 2026",
                "release": "release-1",
            }],
            "desenlin",
            "https://github.com/desenlin/housing-market-lab/actions/runs/1",
            "https://desenlin.github.io/housing-market-lab/",
        )
        self.assertIn("@desenlin", report)
        self.assertIn("Redfin market activity", report)
        self.assertNotIn("@fullerton.edu", report)


if __name__ == "__main__":
    unittest.main()
