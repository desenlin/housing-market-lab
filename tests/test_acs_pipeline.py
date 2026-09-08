import math
import unittest

from pipeline.update_acs import build_dataset, derive, parse_api, share


class AcsPipelineTests(unittest.TestCase):
    def test_subset_share_uses_published_margins(self):
        estimate, margin = share((40, 4), (100, 5))
        self.assertEqual(estimate, 40.0)
        self.assertAlmostEqual(margin, math.sqrt(16 - 4) / 100 * 100, places=3)

    def test_derives_curated_metrics_and_excludes_uncomputed_burden(self):
        row = {
            "B01002_001E": "38.5", "B01002_001M": "0.4",
            "B19013_001E": "90000", "B19013_001M": "2000",
            "B25003_001E": "100", "B25003_001M": "5",
            "B25003_003E": "40", "B25003_003M": "4",
            "B25010_001E": "2.75", "B25010_001M": "0.08",
            "B25024_001E": "120", "B25024_001M": "6",
        }
        for index in range(6, 10):
            row[f"B25024_{index:03d}E"] = "10"
            row[f"B25024_{index:03d}M"] = "1"
        for index in range(2, 12):
            row[f"B25070_{index:03d}E"] = "10"
            row[f"B25070_{index:03d}M"] = "1"
        metrics = derive(row)
        self.assertEqual(metrics["renter_share"][0], 40.0)
        self.assertEqual(metrics["rent_burden_share"][0], 44.444)
        self.assertEqual(metrics["multifamily_share"][0], 33.333)

    def test_build_dataset_adjusts_prior_income_to_current_dollars(self):
        reference = {"place:0600001": {"id": "place:0600001", "name": "Example", "county": "Orange County"}}
        base = {
            "B01002_001E": "40", "B01002_001M": "1",
            "B19013_001E": "100", "B19013_001M": "10",
            "B25003_001E": "100", "B25003_001M": "1", "B25003_003E": "50", "B25003_003M": "1",
            "B25010_001E": "2.5", "B25010_001M": ".1",
            "B25024_001E": "100", "B25024_001M": "1",
        }
        for index in range(6, 10):
            base[f"B25024_{index:03d}E"], base[f"B25024_{index:03d}M"] = "5", "1"
        for index in range(2, 12):
            base[f"B25070_{index:03d}E"], base[f"B25070_{index:03d}M"] = "10", "1"
        dataset = build_dataset("city", reference, {"1600000US0600001": base}, {"1600000US0600001": base}, "2015–2019", "2020–2024", 1.25)
        self.assertEqual(dataset["regions"][0]["series"]["median_household_income"], [125, 100.0])
        self.assertEqual(dataset["regions"][0]["moe"]["median_household_income"], [12, 10.0])

    def test_api_parser_requires_ucgid(self):
        payload = b'[["NAME","B19013_001E","ucgid"],["Example","1","1600000US0600001"]]'
        rows, info = parse_api(payload)
        self.assertEqual(rows["1600000US0600001"]["B19013_001E"], "1")
        self.assertEqual(info["rows_returned"], 1)


if __name__ == "__main__":
    unittest.main()
