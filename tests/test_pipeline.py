import unittest
from pathlib import Path
import tempfile
from types import SimpleNamespace

from pipeline.update_data import (
    combine_geography,
    compact_json,
    manual_source_files,
    manual_source_path,
    normalized_geography_name,
    parse_value,
    place_county,
    point_in_shape,
)


class PipelineHelpersTest(unittest.TestCase):
    def test_manual_zillow_source_uses_provider_or_configured_filename(self):
        source = {
            "id": "city_zhvi",
            "last_url": "https://files.example/City_zhvi.csv",
        }
        with tempfile.TemporaryDirectory() as temporary:
            source_dir = Path(temporary)
            provider_file = source_dir / "City_zhvi.csv"
            provider_file.write_text("RegionID,RegionName\n", encoding="utf-8")
            self.assertEqual(manual_source_path(source_dir, source), provider_file)

            configured_file = source_dir / "city_zhvi.csv"
            configured_file.write_text("RegionID,RegionName\n", encoding="utf-8")
            self.assertEqual(manual_source_path(source_dir, source), configured_file)

    def test_manual_zillow_source_requires_every_configured_file(self):
        sources = [
            {"id": "city_zhvi", "last_url": "https://files.example/City_zhvi.csv"},
            {"id": "zip_zhvi", "last_url": "https://files.example/Zip_zhvi.csv"},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            source_dir = Path(temporary)
            (source_dir / "city_zhvi.csv").write_text(
                "RegionID,RegionName\n" + ("1,Example\n" * 100),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "Missing Zillow source zip_zhvi"):
                manual_source_files(source_dir, sources)

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

    def test_point_in_shape_uses_polygon_rings(self):
        square = SimpleNamespace(
            parts=[0],
            points=[(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)],
        )
        self.assertTrue(point_in_shape(1, 1, square))
        self.assertFalse(point_in_shape(3, 1, square))

    def test_place_county_falls_back_to_sampled_place_points(self):
        county = SimpleNamespace(
            parts=[0],
            points=[(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)],
        )
        coastal_place = SimpleNamespace(
            points=[(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)],
        )
        self.assertEqual(
            place_county((-0.01, 1), coastal_place, {"Example County": county}),
            "Example County",
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

    def test_metro_metadata_is_preserved(self):
        payload = combine_geography(
            "metro",
            [{
                "geography": "metro",
                "metric": "zhvi",
                "dates": ["2024-01-31"],
                "regions": [{
                    "id": "2",
                    "name": "Riverside, CA",
                    "county": None,
                    "context": "Riverside, CA",
                    "census_region": "West",
                    "division": "Pacific",
                    "population_rank": 12,
                    "selection_note": None,
                    "role": "nearby",
                    "values": [500000],
                }],
            }],
        )
        region = payload["regions"][0]
        self.assertEqual(region["census_region"], "West")
        self.assertEqual(region["division"], "Pacific")
        self.assertEqual(region["population_rank"], 12)
        self.assertIsNone(region["selection_note"])
        self.assertEqual(region["role"], "nearby")


if __name__ == "__main__":
    unittest.main()
