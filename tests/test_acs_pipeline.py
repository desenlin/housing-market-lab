import math
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from pipeline.update_acs import build_dataset, derive, main, parse_api, share, vintage_available


class AcsPipelineTests(unittest.TestCase):
    def test_absent_vintage_is_distinct_from_failed_availability_check(self):
        config = {"summary_file_base": "https://example.test/acs"}
        for code in (404, 410):
            with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("url", code, "missing", {}, None)):
                self.assertFalse(vintage_available(config, 2025))
        with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("url", 403, "denied", {}, None)):
            with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                vintage_available(config, 2025)

    def test_transient_availability_errors_retry_then_recover_or_fail(self):
        config = {"summary_file_base": "https://example.test/acs"}
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch("time.sleep"), patch("urllib.request.urlopen", side_effect=[TimeoutError(), response]) as fetch:
            self.assertTrue(vintage_available(config, 2025))
            self.assertEqual(fetch.call_count, 2)
        for error in (TimeoutError(), urllib.error.HTTPError("url", 503, "busy", {}, None)):
            with patch("time.sleep"), patch("urllib.request.urlopen", side_effect=error) as fetch:
                with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
                    vintage_available(config, 2025)
                self.assertEqual(fetch.call_count, 3)

    def test_revision_check_queries_existing_vintage_and_still_discovers_new_vintage(self):
        config = {"latest_year": 2024, "comparison_year": 2019, "provider": "Census", "data_page": "url",
                  "comparison_guidance": "url", "geography_guidance": "url"}
        for available, years in [(False, [2019, 2024, 2024]), (True, [2020, 2025, 2025])]:
            dataset = {"regions": [{"series": {"metric": [1]}} for _ in range(350)]}
            with patch("sys.argv", ["update_acs.py", "--check-revisions"]), \
                 patch("pipeline.update_acs.load_config", return_value=config), \
                 patch("pipeline.update_acs.current_release", return_value=({"latest_year": 2024}, None)), \
                 patch("pipeline.update_acs.vintage_available", return_value=available), \
                 patch("pipeline.update_acs.map_reference", return_value={"city": {}, "zip": {}}), \
                 patch.dict("os.environ", {"CENSUS_API_KEY": "test-key"}), \
                 patch("pipeline.update_acs.fetch_api", return_value=({}, {})) as fetch, \
                 patch("pipeline.update_acs.cpi_factor", return_value=1.0), \
                 patch("pipeline.update_acs.build_dataset", return_value=dataset), \
                 patch("pipeline.update_acs.publish") as publish, \
                 patch("pipeline.update_acs.atomic_write") as write:
                main()
                self.assertEqual([call.args[1] for call in fetch.call_args_list], years)
                self.assertEqual(publish.call_args.args[2]["latest_year"], years[-1])
                self.assertEqual(write.called, available)

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
