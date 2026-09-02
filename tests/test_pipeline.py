import unittest

from pipeline.update_data import combine_geography, compact_json, normalized_geography_name, parse_value


class PipelineHelpersTest(unittest.TestCase):
    def test_parse_value_handles_missing_and_rounding(self):
        self.assertIsNone(parse_value("", 0))
        self.assertIsNone(parse_value("NA", 2))
        self.assertEqual(parse_value("123.7", 0), 124)
        self.assertEqual(parse_value("0.123456", 5), 0.12346)

    def test_compact_json_is_deterministic_and_compact(self):
        self.assertEqual(compact_json({"a": [1, 2]}), b'{"a":[1,2]}')

    def test_geography_normalization_matches_census_accents(self):
        self.assertEqual(
            normalized_geography_name("La Cañada Flintridge"),
            normalized_geography_name("La Canada Flintridge"),
        )

    def test_zip_series_trim_outer_missing_values(self):
        payload = combine_geography(
            "zip",
            [{
                "geography": "zip",
                "metric": "zhvi",
                "dates": ["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30"],
                "regions": [{
                    "id": "1",
                    "name": "90001",
                    "county": "Los Angeles County",
                    "context": "Florence-Graham",
                    "values": [None, 100, 101, None],
                }],
            }],
        )
        self.assertEqual(payload["regions"][0]["series"]["zhvi"], {"o": 1, "v": [100, 101]})


if __name__ == "__main__":
    unittest.main()
