import csv
import io
import unittest
from unittest.mock import patch

from pipeline.update_permits import build_dataset, clean_name, current_reference, main, parse_bps, reference_from_dataset


def encoded_bps_row(*, modern=False, name="Alhambra", place_fips="00884"):
    width = 41 if modern else 35
    header_a = [""] * width
    header_b = [""] * width
    name_index = 16 if modern else 10
    header_a[name_index] = "Place"
    header_b[name_index] = "Name"
    if modern:
        header_a[5] = "FIPS Place"
        header_b[5] = "Code"
        header_a[15] = "Number of"
        header_b[15] = "Months Rep"
    else:
        header_a[8] = "Number of"
        header_b[8] = "Months Rep"
    row = [""] * width
    row[0] = "2025" if modern else "8099"
    row[1] = "06" if modern else "6"
    row[2] = "002000"
    row[3] = "037"
    row[5] = place_fips if modern else ""
    row[8 if not modern else 15] = "12"
    row[name_index] = name
    for index, value in zip([name_index + 2, name_index + 5, name_index + 8, name_index + 11], [4, 2, 3, 11]):
        row[index] = str(value)
    if not modern:
        for index, value in zip([name_index + 14, name_index + 17, name_index + 20, name_index + 23], [4, 2, 3, 10]):
            row[index] = str(value)
    stream = io.StringIO()
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerows([header_a, header_b, row])
    return stream.getvalue().encode("latin-1")


class PermitPipelineTest(unittest.TestCase):
    def test_same_year_revision_rebuilds_history_and_open_year_reference_inputs(self):
        config = {
            "annual_directory": "annual", "monthly_directory": "monthly", "annual_start_year": 2025,
            "monthly_start_year": 2025, "acs_year": 2024, "counties": {"037": {}},
            "provider": "Census", "data_page": "url", "socds_page": "url",
            "methodology_page": "url", "documentation_page": "url",
            "keep_history_releases": 2, "keep_provisional_releases": 2,
            "max_history_bytes": 1000000, "max_provisional_bytes": 1000000,
        }
        with patch("sys.argv", ["update_permits.py", "--force-history"]), \
             patch("pipeline.update_permits.load_config", return_value=config), \
             patch("pipeline.update_permits.discover_annual_files", return_value={2025: (12, "annual-2025")}), \
             patch("pipeline.update_permits.discover_monthly_files", return_value={2025: (12, "monthly-2025"), 2026: (7, "monthly-2026")}), \
             patch("pipeline.update_permits.load_manifest", return_value={"release": "old", "latest_final_year": 2025, "sources": []}), \
             patch("pipeline.update_permits.fetch_bytes", return_value=(b"", {})), \
             patch("pipeline.update_permits.current_reference", return_value=[{"jurisdiction_type": "incorporated_city"}]), \
             patch("pipeline.update_permits.acs_housing_stock", return_value=({}, [])), \
             patch("pipeline.update_permits.download_many", side_effect=lambda urls, cache: {url: (b"", {}) for url in urls}) as download, \
             patch("pipeline.update_permits.parse_bps", return_value=[]), \
             patch("pipeline.update_permits.build_dataset", return_value={"dates": ["2025-12"], "regions": []}), \
             patch("pipeline.update_permits.sources_unchanged", return_value=True) as unchanged, \
             patch("pipeline.update_permits.publish") as publish:
            main()
            self.assertEqual(download.call_args_list[0].args[0], ["annual-2025", "monthly-2025"])
            self.assertEqual(download.call_args_list[1].args[0], ["monthly-2026"])
            self.assertEqual([call.args[0] for call in publish.call_args_list], ["history", "provisional"])
            unchanged.assert_not_called()

    def test_legacy_parser_combines_structure_types_and_flags_imputation(self):
        rows = parse_bps(encoded_bps_row(), 1980, {"037"})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Alhambra")
        self.assertEqual(rows[0]["total_units"], 20)
        self.assertEqual(rows[0]["small_multifamily"], 5)
        self.assertEqual(rows[0]["reported_units"], 19)
        self.assertEqual(rows[0]["months_reported"], 12)

    def test_current_reference_uses_census_place_fips_and_name_alias(self):
        config = {"counties": {"037": {"name": "Los Angeles County", "expected_jurisdictions": 1}}}
        reference = current_reference(encoded_bps_row(modern=True), 2025, config)
        self.assertEqual(reference[0]["id"], "place:0600884")
        self.assertEqual(reference[0]["match_keys"], ["place:00884", "name:037:alhambra"])

    def test_historical_name_alias_avoids_reused_bps_identifier(self):
        reference = [{
            "id": "place:0600884",
            "bps_id": "999999",
            "name": "Alhambra",
            "county": "Los Angeles County",
            "county_fips": "037",
            "fips_place": "00884",
            "jurisdiction_type": "incorporated_city",
            "match_keys": ["place:00884", "name:037:alhambra"],
        }]
        row = parse_bps(encoded_bps_row(), 1980, {"037"})[0]
        dataset = build_dataset([row], reference, "Annual", "Final", {"place:0600884": 1000}, 2024)
        self.assertEqual(dataset["regions"][0]["series"]["total_units"], [20])
        self.assertEqual(dataset["regions"][0]["series"]["units_per_1000_stock"], [20.0])
        self.assertEqual(dataset["regions"][0]["quality"]["imputed"], [0])

    def test_unincorporated_legacy_labels_are_canonicalized(self):
        self.assertEqual(clean_name("LOS ANGELES COUNTY UNINC"), "Los Angeles County Unincorporated Area")
        self.assertEqual(clean_name("ORANGE BAL OF CO"), "Orange County Unincorporated Area")

    def test_validated_release_reconstructs_reference_without_source_download(self):
        dataset = {"regions": [{
            "id": "place:0600884",
            "bps_id": "002000",
            "name": "Alhambra",
            "county": "Los Angeles County",
            "county_fips": "037",
            "fips_place": "00884",
            "jurisdiction_type": "incorporated_city",
        }]}
        reference = reference_from_dataset(dataset)
        self.assertEqual(reference[0]["match_keys"], ["place:00884", "name:037:alhambra"])


if __name__ == "__main__":
    unittest.main()
