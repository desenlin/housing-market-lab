import copy
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.update_hcd import INCOMES, STAGES, build, publish, query, retrieve


def config():
    return {"start_year": 2018, "resource_id": "test", "counties": ["Orange"],
            "max_result_rows": 20000, "max_release_bytes": 1000000, "data_page": "https://www.hcd.ca.gov/apr"}


def region():
    return {"id": "place:1", "name": "Fullerton", "county": "Orange County", "jurisdiction_type": "incorporated_city", "housing_stock": 10000, "housing_stock_vintage": 2024}


def row(year=2018, unit_type="ADU"):
    result = {"CNTY_NAME": "Orange", "JURIS_NAME": "FULLERTON", "YEAR": str(year), "UNIT_CAT": unit_type, "records": 1}
    for stage in STAGES:
        result[stage] = 2
        for q in ["invalid", "missing_total", "undated", "outside_year", "mismatch"]:
            result[f"{stage}_{q}"] = 0
        for i in range(len(INCOMES)):
            result[f"{stage}_i{i}"] = 2 if i == 10 else 0
    return result


class HcdTests(unittest.TestCase):
    def test_date_groups_exclude_prior_stages_and_flag_missing_dates(self):
        fields = ['CNTY_NAME', 'JURIS_NAME', 'YEAR', 'UNIT_CAT']
        for prefix, total, date in STAGES.values():
            fields += [total, date] + [prefix+'_'+i for i in INCOMES]
        source = row(); source.update(bpyear='2017', coyear=None)
        def fetch(*args, **kwargs):
            return {'records': [copy.deepcopy(source)]}
        normalized = retrieve(config(), fields, fetch=fetch)[0]
        self.assertEqual(normalized['permits'], 0)
        self.assertEqual(normalized['permits_outside_year'], 1)
        self.assertEqual(normalized['completions'], 2)
        self.assertEqual(normalized['completions_undated'], 1)
        self.assertEqual(normalized['completions_mismatch'], 0)

    def test_truncated_aggregate_never_publishes(self):
        fields = ['CNTY_NAME', 'JURIS_NAME', 'YEAR', 'UNIT_CAT']
        for prefix, total, date in STAGES.values():
            fields += [total, date] + [prefix+'_'+i for i in INCOMES]
        with self.assertRaisesRegex(ValueError, 'truncated'):
            retrieve(config(), fields, fetch=lambda *a, **kw: {'records': [], 'records_truncated': True})

    def test_cross_batch_coverage_must_match(self):
        fields = ['CNTY_NAME', 'JURIS_NAME', 'YEAR', 'UNIT_CAT']
        for prefix, total, date in STAGES.values():
            fields += [total, date] + [prefix+'_'+i for i in INCOMES]
        source = row(); source.update(bpyear='2018', coyear='2018')
        calls = []
        def fetch(*args, **kwargs):
            calls.append(1)
            return {'records': [copy.deepcopy(source)] if len(calls) == 1 else []}
        with self.assertRaisesRegex(ValueError, 'different coverage'):
            retrieve(config(), fields, fetch=fetch)

    def test_absent_year_not_zero_and_types_sum(self):
        dataset = build([row(), row(unit_type="5+")], [region()], config(), 2019)
        cells = dataset['regions'][0]['annual']
        self.assertIsNone(cells[1])
        self.assertEqual(cells[0]['completions']['total'], 4)
        self.assertEqual(cells[0]['completions']['types']['ADU'], 2)
        self.assertEqual(sum(cells[0]['completions']['income']), 4)

    def test_unmapped_jurisdiction_rejected(self):
        source = row(); source['JURIS_NAME'] = 'UNKNOWN'
        with self.assertRaisesRegex(ValueError, 'Unmapped'):
            build([source], [region()], config(), 2018)

    def test_inconsistent_income_withheld_but_total_retained(self):
        source = row(); source['completions_mismatch'] = 1
        cell = build([source], [region()], config(), 2018)['regions'][0]['annual'][0]
        self.assertEqual(cell['completions']['total'], 2)
        self.assertIsNone(cell['completions']['income'])

    def test_invalid_total_withheld(self):
        source = row(); source['completions_invalid'] = 1
        cell = build([source], [region()], config(), 2018)['regions'][0]['annual'][0]
        self.assertIsNone(cell['completions']['total'])

    def test_schema_guard(self):
        with self.assertRaisesRegex(ValueError, 'schema changed'):
            query(config(), [])

    def test_publication_noop_revision_rollback_and_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'config').mkdir()
            (root/'config/storage_policy.json').write_text(json.dumps({'max_public_data_bytes': 25000000}))
            dataset = build([row()], [region()], config(), 2018)
            self.assertTrue(publish(root, dataset, config(), {'last_modified': 'v1'}))
            pointer = root/'public/data/hcd/latest.json'
            original = pointer.read_bytes()
            self.assertFalse(publish(root, dataset, config(), {'last_modified': 'v2'}))
            self.assertEqual(pointer.read_bytes(), original)
            broken = copy.deepcopy(dataset); broken['regions'][0]['annual'][0] = None
            with self.assertRaisesRegex(ValueError, 'disappeared'):
                publish(root, broken, config(), {})
            self.assertEqual(pointer.read_bytes(), original)
            for n in [3, 4, 5]:
                updated = row(); updated['completions'] = n; updated['completions_i10'] = n
                publish(root, build([updated], [region()], config(), 2018), config(), {})
            self.assertEqual(len(list((root/'public/data/hcd/releases').iterdir())), 2)
            tiny = config(); tiny['max_release_bytes'] = 10
            with self.assertRaisesRegex(ValueError, 'budget'):
                publish(root, dataset, tiny, {})


if __name__ == '__main__':
    unittest.main()
