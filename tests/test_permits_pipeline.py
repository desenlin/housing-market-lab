import csv
import io
import unittest

from pipeline.update_permits import build_dataset, clean_name, current_reference, parse_bps, reference_from_dataset


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
