import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.prepare_market_brief import housing_supply_review, supply_review_markdown


class HousingSupplyReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dataset = {'years': [2025], 'regions': [
            {'county': 'Orange County', 'jurisdiction_type': 'incorporated_city', 'annual': [{'completions': {'total': 0}}]},
            {'county': 'Orange County', 'jurisdiction_type': 'incorporated_city', 'annual': [None]},
            {'county': 'Orange County', 'jurisdiction_type': 'county_unincorporated', 'annual': [{'completions': {'total': 10}}]},
        ]}
        self.write_snapshot()

    def write_snapshot(self, year=2025, validated='2026-09-14T00:00:00Z'):
        folder = self.root / 'hcd' / 'releases' / 'test-release'
        folder.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self.dataset).encode()
        digest = hashlib.sha256(payload).hexdigest()
        (folder / 'annual.json').write_bytes(payload)
        (folder / 'manifest.json').write_text(json.dumps({'release': 'test-release', 'bundle_sha256': digest, 'latest_year': year, 'created_at': validated}))
        (self.root / 'hcd' / 'latest.json').write_text(json.dumps({'release': 'test-release', 'bundle_sha256': digest}))

    def test_first_review_counts_zero_but_not_missing_or_unincorporated(self):
        result = housing_supply_review(self.root, None, '2026-09')
        self.assertEqual(result['status'], 'first_review')
        self.assertEqual(result['coverage'][1], {'county': 'Orange County', 'reporting_cities': 1, 'reference_cities': 2})
        self.assertIn('separate annual check', supply_review_markdown(result))

    def test_unchanged_and_revision_are_distinct(self):
        prior = housing_supply_review(self.root, None, '2026-09')
        self.assertEqual(housing_supply_review(self.root, {'housing_supply_review': prior}, '2026-09')['status'], 'unchanged')
        self.dataset['regions'][0]['annual'][0]['completions']['total'] = 3
        self.write_snapshot()
        revised = housing_supply_review(self.root, {'housing_supply_review': prior}, '2026-09')
        self.assertEqual(revised['status'], 'revised_annual_snapshot')
        self.assertTrue(revised['review_required'])

    def test_new_year_is_annual_not_monthly_advancement(self):
        prior = housing_supply_review(self.root, None, '2026-09')
        self.dataset['years'] = [2026]
        self.write_snapshot(year=2026, validated='2027-04-01T00:00:00Z')
        current = housing_supply_review(self.root, {'housing_supply_review': prior}, '2027-04')
        self.assertEqual(current['status'], 'new_annual_year')
        self.assertIn('does not advance a monthly question', current['reason'])

    def test_later_vintage_cannot_support_earlier_issue(self):
        self.assertEqual(housing_supply_review(self.root, None, '2026-08')['status'], 'outside_issue')

    def test_corruption_is_ineligible(self):
        (self.root / 'hcd/releases/test-release/annual.json').write_text('{}')
        result = housing_supply_review(self.root, None, '2026-09')
        self.assertEqual(result['status'], 'invalid')
        self.assertTrue(result['review_required'])

    def test_missing_hcd_does_not_become_bps_delivery(self):
        (self.root / 'hcd/latest.json').unlink()
        result = housing_supply_review(self.root, None, '2026-09')
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('do not infer annual delivery from BPS', result['reason'])


class BpsQuestionGuardTests(unittest.TestCase):
    def test_hcd_cannot_replace_monthly_bps_evidence(self):
        from pipeline.prepare_market_brief import question_sections
        root = Path(__file__).resolve().parents[1]
        packet = json.loads((root / "public/data/facts/latest.json").read_text())
        item = next(f for f in packet["facts"] if f["metric"] == "permits_ytd")
        item["provider"] = "California HCD"
        with self.assertRaisesRegex(ValueError, "requires preliminary Census BPS"):
            question_sections(packet)

    def test_counties_must_share_the_comparison_window(self):
        from pipeline.prepare_market_brief import question_sections
        root = Path(__file__).resolve().parents[1]
        packet = json.loads((root / "public/data/facts/latest.json").read_text())
        item = next(f for f in packet["facts"] if f["metric"] == "permits_ytd")
        item["period"] += " (mismatched test window)"
        with self.assertRaisesRegex(ValueError, "same year-to-date window"):
            question_sections(packet)

    def test_metro_answer_uses_combined_counts(self):
        from pipeline.prepare_market_brief import question_sections
        root = Path(__file__).resolve().parents[1]
        packet = json.loads((root / "public/data/facts/latest.json").read_text())
        counties = [f for f in packet["facts"] if f["metric"] == "permits_ytd"]
        metro = next(f for f in packet["facts"] if f["metric"] == "permits_metro_ytd")
        self.assertEqual(metro["value"], sum(f["value"] for f in counties))
        self.assertEqual(metro["prior_value"], sum(f["prior_value"] for f in counties))
        self.assertAlmostEqual(metro["change"], metro["value"] / metro["prior_value"] - 1)
        section = question_sections(packet)[1]
        self.assertIn(f"{abs(metro['change']):.1%}", section["answer"])
        self.assertEqual(len(section["evidence"]), 1)
        self.assertNotIn("%", section["evidence"][0])
        for change, expected in [(0.1, "Yes. Los Angeles metro YTD permits rose 10.0%."), (-0.1, "No. Los Angeles metro YTD permits fell 10.0%."), (0, "No. Los Angeles metro YTD permits were unchanged at 0.0%.")]:
            metro["change"] = change
            self.assertEqual(question_sections(packet)[1]["answer"], expected)
