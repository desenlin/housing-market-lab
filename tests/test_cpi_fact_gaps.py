import json
import tempfile
import unittest
from pathlib import Path

from pipeline.build_fact_engine import cpi_and_real_fact
from pipeline.prepare_market_brief import build_current_snapshot
from pipeline.update_cpi import month_end, yoy_values


ROOT = Path(__file__).resolve().parents[1]


class CpiFactGapTests(unittest.TestCase):
    def series(self):
        dates = [month_end(2025, month) for month in range(9, 13)]
        dates += [month_end(2026, month) for month in range(1, 11)]
        values = [100.0, None, 100.0, 100.0] + [100.0] * 8 + [103.0, 104.0]
        return {"dates": dates, "values": values, "yoy": yoy_values(values)}

    def build_facts(self, series, price_period="2026-09-30"):
        with tempfile.TemporaryDirectory() as directory:
            release_dir = Path(directory)
            (release_dir / "cpi.json").write_text(json.dumps({"series": {"la": series}}))
            return cpi_and_real_fact(
                "cpi-fixture", release_dir, "zillow-fixture",
                {"zhvi": {"period": price_period, "value": 210.0, "prior": 200.0}},
            )

    def test_missing_prior_year_uses_latest_calculable_cpi_period(self):
        results = self.build_facts(self.series())
        inflation = next(item for item in results if item["metric"] == "cpi_la")
        self.assertEqual(inflation["period"], "2026-09-30")
        self.assertEqual(inflation["value"], 103.0)
        self.assertAlmostEqual(inflation["change"], 0.03)
        self.assertIn("2026-10-31", inflation["caveat"])
        real = next(item for item in results if item["metric"] == "real_zhvi")
        self.assertEqual(real["period"], "2026-09-30")
        self.assertAlmostEqual(real["change"], 1.05 / 1.03 - 1)

    def test_missing_common_month_comparison_omits_real_price_fact(self):
        for current, prior in [(104.0, None), (None, 100.0), (104.0, 0.0),
                               (float("nan"), 100.0), (104.0, float("inf"))]:
            with self.subTest(current=current, prior=prior):
                series = self.series()
                series["values"][-1] = current
                series["values"][1] = prior
                series["yoy"] = yoy_values(series["values"])
                results = self.build_facts(series, "2026-10-31")
                self.assertFalse(any(item["metric"] == "real_zhvi" for item in results))
                inflation = next(item for item in results if item["metric"] == "cpi_la")
                self.assertEqual(inflation["period"], "2026-09-30")
                json.dumps(results, allow_nan=False)

    def test_no_calculable_inflation_does_not_create_a_fact(self):
        series = self.series()
        series["values"] = [None] * len(series["values"])
        series["yoy"] = [None] * len(series["yoy"])
        self.assertEqual(self.build_facts(series), [])

    def test_zero_inflation_is_a_valid_observation(self):
        series = self.series()
        series["values"][1] = series["values"][-1]
        series["yoy"] = yoy_values(series["values"])
        inflation = next(item for item in self.build_facts(series)
                         if item["metric"] == "cpi_la")
        self.assertEqual(inflation["period"], "2026-10-31")
        self.assertEqual(inflation["change"], 0.0)

    def test_brief_continues_without_unavailable_inflation_facts(self):
        for omitted in [{"real_zhvi"}, {"real_zhvi", "cpi_la"}]:
            with self.subTest(omitted=omitted):
                packet = json.loads((ROOT / "tests/fixtures/fact-packet-2026-09-17.json").read_text())
                packet["facts"] = [item for item in packet["facts"] if item["metric"] not in omitted]
                snapshot, pool = build_current_snapshot(packet)
                ids = {item["question_id"] for item in pool}
                self.assertNotIn("real_zhvi-los-angeles-metro", ids)
                self.assertIn("inventory-los-angeles-metro", ids)
                self.assertIn("permits_metro_ytd-los-angeles-metro", ids)
                self.assertTrue(snapshot["sections"])


if __name__ == "__main__":
    unittest.main()
