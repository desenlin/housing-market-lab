import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pipeline import update_redfin
from pipeline.update_redfin import (
    compact_series,
    parse_value,
    publish_release,
    stream_selected_rows,
)


METRICS = {
    "months_supply": {
        "field": "MONTHS OF SUPPLY",
        "decimals": 1,
    },
    "sold_above_original_share": {
        "field": "SHARE SOLD ABOVE ORIGINAL LIST (%)",
        "decimals": 5,
        "scale": 0.01,
    },
}


class RedfinPipelineTest(unittest.TestCase):
    def test_percentage_scaling_and_missing_values(self):
        self.assertEqual(parse_value("25.5", 5, 0.01), 0.255)
        self.assertIsNone(parse_value("NA", 1))

    def test_compact_series_trims_outer_missing_values(self):
        self.assertEqual(compact_series([None, 2.1, None, 3.2, None]), {"o": 1, "v": [2.1, None, 3.2]})

    def test_stream_filters_regions_dates_and_uses_larger_duplicate(self):
        rows = [
            {
                "FREQUENCY": "Rolling 3 Months",
                "PERIOD END": "2024-03-31",
                "REGION NAME": "Fullerton, CA",
                "HOMES SOLD": "10",
                "MONTHS OF SUPPLY": "2.5",
                "SHARE SOLD ABOVE ORIGINAL LIST (%)": "30",
            },
            {
                "FREQUENCY": "Rolling 3 Months",
                "PERIOD END": "2024-03-31",
                "REGION NAME": "Fullerton, CA",
                "HOMES SOLD": "100",
                "MONTHS OF SUPPLY": "3.5",
                "SHARE SOLD ABOVE ORIGINAL LIST (%)": "40",
            },
            {
                "FREQUENCY": "Rolling 3 Months",
                "PERIOD END": "2024-03-31",
                "REGION NAME": "Irvine, CA",
                "HOMES SOLD": "200",
                "MONTHS OF SUPPLY": "1.8",
                "SHARE SOLD ABOVE ORIGINAL LIST (%)": "50",
            },
            {
                "FREQUENCY": "Rolling 3 Months",
                "PERIOD END": "2017-12-31",
                "REGION NAME": "Fullerton, CA",
                "HOMES SOLD": "100",
                "MONTHS OF SUPPLY": "9.9",
                "SHARE SOLD ABOVE ORIGINAL LIST (%)": "5",
            },
        ]
        source = {
            "key": "housing_city",
            "metrics": list(METRICS),
            "selection_weight": "HOMES SOLD",
        }
        reference = {
            "Fullerton, CA": {"id": "1"},
        }
        selected, latest, scanned = stream_selected_rows(
            rows, source, METRICS, reference, "2018-01-01"
        )
        self.assertEqual(latest, "2024-03-31")
        self.assertEqual(scanned, 4)
        self.assertEqual(selected["1"]["2024-03-31"]["months_supply"], 3.5)
        self.assertEqual(selected["1"]["2024-03-31"]["sold_above_original_share"], 0.4)

    def test_publish_release_writes_digest_pointer_and_prunes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "redfin"
            for name in ("2026-09-01-r000000", "2026-09-02-r000000"):
                (root / "releases" / name).mkdir(parents=True)
            digest = "a" * 64
            removed = publish_release(
                root,
                "2026-09-03-r000000",
                digest,
                {"city.json": b"{}", "manifest.json": b"{}"},
                2,
            )

            self.assertEqual(removed, ["2026-09-01-r000000"])
            self.assertEqual(
                json.loads((root / "latest.json").read_text()),
                {"release": "2026-09-03-r000000", "bundle_sha256": digest},
            )
            self.assertTrue(
                (root / "releases" / "2026-09-03-r000000" / "city.json").is_file()
            )

    def test_publish_release_removes_new_directory_when_pointer_write_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "redfin"
            release = "2026-09-03-r000000"
            with patch.object(update_redfin, "atomic_write", side_effect=OSError("failed")):
                with self.assertRaises(OSError):
                    publish_release(
                        root,
                        release,
                        "a" * 64,
                        {"city.json": b"{}", "manifest.json": b"{}"},
                        2,
                    )

            self.assertFalse((root / "releases" / release).exists())

    def test_publish_release_rejects_non_digest_before_creating_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "redfin"
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                publish_release(
                    root,
                    "2026-09-03-r000000",
                    update_redfin.bundle_sha,  # type: ignore[arg-type]
                    {"manifest.json": b"{}"},
                    2,
                )

            self.assertFalse((root / "releases").exists())


if __name__ == "__main__":
    unittest.main()
