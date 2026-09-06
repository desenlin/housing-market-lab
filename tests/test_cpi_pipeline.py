import unittest

from pipeline.update_cpi import (
    complete_months,
    month_end,
    parse_response,
    year_chunks,
    yoy_values,
)


class CpiPipelineTest(unittest.TestCase):
    def test_year_chunks_stay_within_public_api_limit(self):
        self.assertEqual(year_chunks(2000, 2026), [(2000, 2009), (2010, 2019), (2020, 2026)])

    def test_month_end_handles_leap_year(self):
        self.assertEqual(month_end(2024, 2), "2024-02-29")

    def test_parse_response_excludes_annual_average(self):
        payload = {
            "status": "REQUEST_SUCCEEDED",
            "Results": {"series": [{
                "seriesID": "EXAMPLE",
                "data": [
                    {"year": "2024", "period": "M13", "value": "300.0"},
                    {"year": "2024", "period": "M02", "value": "301.5"},
                    {"year": "2024", "period": "M01", "value": "-"},
                ],
            }]},
        }
        self.assertEqual(parse_response(payload, "EXAMPLE"), {"2024-02-29": 301.5})

    def test_missing_official_month_remains_null(self):
        observations = {"2025-09-30": 100.0, "2025-11-30": 102.0}
        dates, values = complete_months(observations, 2025, 2025)
        self.assertEqual(dates, ["2025-09-30", "2025-10-31", "2025-11-30"])
        self.assertEqual(values, [100.0, None, 102.0])

    def test_yoy_is_exact_ratio_and_preserves_missing_values(self):
        values = [100.0] * 12 + [110.0, None]
        result = yoy_values(values)
        self.assertEqual(result[12], 0.1)
        self.assertIsNone(result[13])


if __name__ == "__main__":
    unittest.main()
