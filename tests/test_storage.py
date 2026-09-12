import tempfile
import unittest
from pathlib import Path

from pipeline.storage import (
    dataset_shards,
    expand_series,
    merge_dataset_history,
    merge_uniform_history,
    prune_releases,
)


def dataset(dates, regions):
    return {
        "geography": "zip",
        "metrics": {"value": {"dates": dates, "label": "Value"}},
        "regions": regions,
    }


class StoragePolicyTest(unittest.TestCase):
    def test_merge_preserves_dates_removed_by_upstream_truncation(self):
        previous = dataset(
            ["2015-01", "2016-01", "2017-01"],
            [{
                "id": "1", "name": "90001", "county": "Los Angeles County",
                "series": {"value": [10, 11, 12]},
            }],
        )
        incoming = dataset(
            ["2017-01", "2018-01"],
            [{
                "id": "1", "name": "90001", "county": "Los Angeles County",
                "series": {"value": [120, 13]},
            }],
        )
        merged, report = merge_dataset_history(previous, incoming)
        self.assertEqual(merged["metrics"]["value"]["dates"], [
            "2015-01", "2016-01", "2017-01", "2018-01"
        ])
        self.assertEqual(expand_series(merged["regions"][0]["series"]["value"], 4), [10, 11, 120, 13])
        self.assertEqual(report["truncated_metrics"]["value"]["retained_dates"], 2)

    def test_merge_respects_current_explicit_null(self):
        previous = dataset(
            ["2025-01", "2025-02"],
            [{"id": "1", "name": "90001", "county": "Los Angeles County", "series": {"value": [10, 11]}}],
        )
        incoming = dataset(
            ["2025-01", "2025-02", "2025-03"],
            [{"id": "1", "name": "90001", "county": "Los Angeles County", "series": {"value": [10, None, 12]}}],
        )
        merged, _ = merge_dataset_history(previous, incoming)
        self.assertEqual(expand_series(merged["regions"][0]["series"]["value"], 3), [10, None, 12])

    def test_merge_preserves_explicit_empty_quality_array(self):
        previous = dataset(
            ["2025-01"],
            [{
                "id": "1", "name": "90001", "county": "Los Angeles County",
                "series": {"value": [10]}, "quality": {"hotness": []},
            }],
        )
        incoming = dataset(["2025-02"], [])

        merged, _ = merge_dataset_history(previous, incoming)

        self.assertEqual(merged["regions"][0]["quality"], {"hotness": []})

    def test_county_shards_keep_generated_objects_small_and_separate(self):
        payload = dataset(
            ["2025-01"],
            [
                {"id": "1", "name": "90001", "county": "Los Angeles County", "series": {"value": [10]}},
                {"id": "2", "name": "92831", "county": "Orange County", "series": {"value": [20]}},
            ],
        )
        files, names = dataset_shards(payload)
        self.assertEqual(names, ["zip-los-angeles.json", "zip-orange.json"])
        self.assertEqual(len(files), 2)

    def test_uniform_history_merge_supports_annual_permit_calendars(self):
        previous = {
            "geography": "permit_jurisdiction",
            "dates": ["1980", "1981"],
            "metrics": {"units": {"label": "Units"}},
            "regions": [{
                "id": "1", "name": "Example", "series": {"units": [1, 2]},
                "quality": {"imputed": [1], "source_codes": {"1": "I"}, "months_reported": [12, 11]},
            }],
        }
        incoming = {
            "geography": "permit_jurisdiction",
            "dates": ["1982"],
            "metrics": {"units": {"label": "Units"}},
            "regions": [{
                "id": "1", "name": "Example", "series": {"units": [3]},
                "quality": {"imputed": [], "source_codes": {}, "months_reported": [12]},
            }],
        }
        merged, report = merge_uniform_history(previous, incoming)
        self.assertEqual(merged["dates"], ["1980", "1981", "1982"])
        self.assertEqual(merged["regions"][0]["series"]["units"], [1, 2, 3])
        self.assertEqual(merged["regions"][0]["quality"]["imputed"], [1])
        self.assertEqual(merged["regions"][0]["quality"]["source_codes"], {"1": "I"})
        self.assertEqual(merged["regions"][0]["quality"]["months_reported"], [12, 11, 12])
        self.assertTrue(report["truncated"])

    def test_release_retention_keeps_current_and_one_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for release in ["2026-01", "2026-02", "2026-03"]:
                (root / "releases" / release).mkdir(parents=True)
            self.assertEqual(prune_releases(root, 2), ["2026-01"])
            self.assertEqual(
                sorted(path.name for path in (root / "releases").iterdir()),
                ["2026-02", "2026-03"],
            )


if __name__ == "__main__":
    unittest.main()
