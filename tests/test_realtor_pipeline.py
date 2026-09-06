import tempfile
import unittest
from pathlib import Path

from pipeline.update_realtor import (
    compact_series,
    month_date,
    parse_value,
    prune_releases,
    source_is_unchanged,
    stream_selected_rows,
)


METRICS = {
    "active_listing_count": {
        "field": "active_listing_count",
        "decimals": 0,
    },
    "pending_ratio": {
        "field": "pending_ratio",
        "decimals": 5,
    },
}


class RealtorPipelineTest(unittest.TestCase):
    def test_values_dates_and_compaction(self):
        self.assertEqual(parse_value("24.6", 0), 25)
        self.assertIsNone(parse_value("NA", 1))
        self.assertEqual(month_date("202608"), "2026-08-01")
        self.assertEqual(
            compact_series([None, 12, None, 14, None]),
            {"o": 1, "v": [12, None, 14]},
        )

    def test_stream_keeps_local_rows_and_marks_provider_flags(self):
        rows = [
            {
                "month_date_yyyymm": "202608",
                "postal_code": "92831",
                "active_listing_count": "24",
                "pending_ratio": "0.5",
                "quality_flag": "0",
            },
            {
                "month_date_yyyymm": "202607",
                "postal_code": "92831",
                "active_listing_count": "999",
                "pending_ratio": "0.9",
                "quality_flag": "1",
            },
            {
                "month_date_yyyymm": "202608",
                "postal_code": "10001",
                "active_listing_count": "400",
                "pending_ratio": "0.3",
                "quality_flag": "0",
            },
            {
                "month_date_yyyymm": "201712",
                "postal_code": "92831",
                "active_listing_count": "30",
                "pending_ratio": "0.4",
                "quality_flag": "0",
            },
        ]
        product = {"key": "inventory", "metrics": list(METRICS)}
        reference = {
            "92831": {
                "id": "zcta:92831",
                "name": "92831",
                "county": "Orange County",
                "context": None,
            }
        }
        selected, dates, scanned, flagged = stream_selected_rows(
            rows, product, METRICS, reference, "2018-01"
        )
        self.assertEqual(scanned, 4)
        self.assertEqual(flagged, 1)
        self.assertEqual(dates, {"2026-07-01", "2026-08-01"})
        self.assertEqual(
            selected["zcta:92831"]["2026-08-01"]["active_listing_count"],
            24,
        )
        self.assertEqual(
            selected["zcta:92831"]["2026-07-01"]["active_listing_count"],
            999,
        )
        self.assertEqual(
            selected["zcta:92831"]["2026-07-01"]["__quality_flag"],
            1,
        )
        self.assertEqual(
            selected["zcta:92831"]["2026-08-01"]["__quality_flag"],
            0,
        )

    def test_source_fingerprint_avoids_repeat_download(self):
        existing = {"schema_version": 3, "source": {"etag": '"abc"', "bytes": 10}}
        current = {"etag": '"abc"', "bytes": 12, "last_modified": "later"}
        self.assertTrue(source_is_unchanged(existing, current))
        self.assertFalse(source_is_unchanged(existing, {**current, "etag": '"def"'}))
        self.assertFalse(source_is_unchanged({"source": existing["source"]}, current))

    def test_retains_three_release_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            releases = root / "releases"
            for release in ["2026-01", "2026-02", "2026-03", "2026-04"]:
                (releases / release).mkdir(parents=True)
            removed = prune_releases(root, 3)
            self.assertEqual(removed, ["2026-01"])
            self.assertEqual(
                sorted(path.name for path in releases.iterdir()),
                ["2026-02", "2026-03", "2026-04"],
            )


if __name__ == "__main__":
    unittest.main()
