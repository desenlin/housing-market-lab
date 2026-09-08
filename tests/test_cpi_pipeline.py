import unittest

from pipeline.update_cpi import (
    complete_months,
    month_end,
    parse_bulk_data,
    parse_response,
    merge_cpi_history,
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

    def test_parse_bulk_data_filters_series_years_and_annual_average(self):
        payload = "\n".join([
            "series_id\tyear\tperiod\tvalue\tfootnote_codes",
            "CUUR0000SA0      \t2023\tM12\t300.0\t",
            "CUUR0000SA0      \t2024\tM01\t301.0\t",
            "CUUR0000SA0      \t2024\tM13\t302.0\t",
            "CUURS49ASA0      \t2024\tM01\t320.0\t",
            "CUURS49ASA0      \t2024\tM02\t-\t",
            "UNUSED           \t2024\tM01\t999.0\t",
        ])
        self.assertEqual(
            parse_bulk_data(payload, {"CUUR0000SA0", "CUURS49ASA0"}, 2024, 2024),
            {
                "CUUR0000SA0": {"2024-01-31": 301.0},
                "CUURS49ASA0": {"2024-01-31": 320.0},
            },
        )

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

    def test_merge_preserves_truncated_history_but_keeps_current_null(self):
        previous = {
            "series": {
                "us": {
                    "id": "US",
                    "dates": ["2024-01-31", "2025-01-31", "2025-02-28"],
                    "values": [100.0, 110.0, 111.0],
                }
            }
        }
        incoming = {
            "series": {
                "us": {
                    "id": "US",
                    "dates": ["2025-01-31", "2025-02-28", "2025-03-31"],
                    "values": [112.0, None, 113.0],
                }
            }
        }
        merged, report = merge_cpi_history(previous, incoming)
        self.assertEqual(merged["series"]["us"]["values"], [100.0, 112.0, None, 113.0])
        self.assertEqual(report["truncated_series"]["us"]["preserved_start"], "2024-01-31")


if __name__ == "__main__":
    unittest.main()
