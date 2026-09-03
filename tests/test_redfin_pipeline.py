import unittest

from pipeline.update_redfin import compact_series, parse_value, stream_selected_rows


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


if __name__ == "__main__":
    unittest.main()
