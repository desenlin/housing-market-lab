from datetime import date
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.data_health import assess, expected_period, record_attempts, render_report
from tests import test_data_update_report as reports


ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / "config/data_health_policy.json").read_text())


class DataHealthTests(unittest.TestCase):
    def test_local_permits_wait_for_revised_release_and_grace(self):
        rule = POLICY["sources"]["permits_provisional"]
        self.assertEqual(expected_period(rule, date(2026, 9, 20)), "2026-07")
        self.assertEqual(expected_period(rule, date(2026, 9, 24)), "2026-07")
        self.assertEqual(expected_period(rule, date(2026, 9, 25)), "2026-08")
        self.assertEqual(expected_period(rule, date(2026, 10, 28)), "2026-09")

    def test_delayed_release_override_crosses_month_boundary(self):
        rule = {**POLICY["sources"]["cpi"], "release_dates": {"2026-08": "2026-10-05"}}
        self.assertEqual(expected_period(rule, date(2026, 10, 1)), "2026-07")
        self.assertEqual(expected_period(rule, date(2026, 10, 6)), "2026-08")

    def test_fallback_handles_year_rollover_and_short_months(self):
        rule = POLICY["sources"]["permits_provisional"]
        self.assertEqual(expected_period(rule, date(2027, 1, 12)), "2026-11")
        self.assertEqual(expected_period(rule, date(2027, 2, 28)), "2027-01")

    def test_zillow_closed_sales_get_an_extra_month(self):
        rule = POLICY["sources"]["zillow"]
        self.assertEqual(expected_period(rule, date(2026, 9, 28), "metro_zhvi"), "2026-08")
        self.assertEqual(expected_period(rule, date(2026, 9, 28), "metro_sale_to_list"), "2026-07")

    def test_annual_sources_use_annual_windows(self):
        for key, before, after, old, new in [
            ("acs", date(2027, 2, 28), date(2027, 3, 1), "2024", "2025"),
            ("permits_history", date(2026, 6, 27), date(2026, 6, 28), "2024", "2025"),
            ("hcd", date(2026, 10, 31), date(2026, 11, 1), "2024", "2025"),
        ]:
            self.assertEqual(expected_period(POLICY["sources"][key], before), old)
            self.assertEqual(expected_period(POLICY["sources"][key], after), new)

    def test_failure_streak_survives_deploy_only_and_resets_on_unchanged_success(self):
        state = {"schema_version": 1, "providers": {}}
        once = record_attempts(state, {"cpi": 1}, "1", "first")
        self.assertEqual(state["providers"], {})
        self.assertEqual(record_attempts(once, {}, "2", "deploy"), once)
        rerun = record_attempts(once, {"cpi": 1}, "1", "rerun")
        self.assertEqual(rerun["providers"]["cpi"]["consecutive_failures"], 1)
        twice = record_attempts(rerun, {"cpi": 1, "acs": None}, "3", "second")
        self.assertEqual(twice["providers"]["cpi"]["consecutive_failures"], 2)
        recovered = record_attempts(twice, {"cpi": 0}, "4", "success")
        self.assertEqual(recovered["providers"]["cpi"]["consecutive_failures"], 0)
        self.assertEqual(recovered["providers"]["cpi"]["last_success_at"], "success")
        self.assertNotIn("acs", recovered["providers"])

    def test_one_stale_component_is_not_hidden_by_current_headline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reports.DataUpdateReportTests().write_release(root, "public/data/cpi/latest.json", "test", {
                "series": {"us": {"latest_observation": "2026-08-31"}, "la_food": {"latest_observation": "2026-06-30"}},
            })
            state = {"providers": {"cpi": {"consecutive_failures": 2}}}
            rows = assess(root, POLICY, state, date(2026, 9, 20), {"cpi"})
            self.assertEqual(len(rows), 1)
            self.assertIn("la_food: through 2026-06, expected at least 2026-08", rows[0]["issues"])
            self.assertIn("2 consecutive update failures", rows[0]["issues"])

    def test_missing_manifest_is_actionable(self):
        with tempfile.TemporaryDirectory() as temporary:
            rows = assess(Path(temporary), POLICY, {"providers": {}}, date(2026, 9, 20), {"cpi"})
            self.assertEqual(rows[0]["issues"], ["Missing observation coverage"])

    def test_reference_review_reminder_does_not_rebase_data(self):
        report = render_report([], POLICY, date(2027, 1, 15))
        self.assertIn("Maintainer reference review is due", report)
        self.assertIn("Fixed vintages do not advance automatically", report)

    def test_cli_persists_all_failed_attempts_and_outputs_separate_gate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            (root / ".github").mkdir()
            (root / "config/data_health_policy.json").write_text(json.dumps(POLICY))
            state = root / ".github/data-update-state.json"
            state.write_text('{"schema_version":1,"providers":{}}')
            reports.DataUpdateReportTests().write_release(root, "public/data/cpi/latest.json", "current", {
                "series": {"us": {"latest_observation": "2026-08-31"}},
            })
            statuses = root / "statuses.json"
            statuses.write_text('{"cpi":1}')
            output = root / "output"
            subprocess.run([
                "python", str(ROOT / "scripts/data_health.py"), "--root", str(root),
                "--groups", "cpi", "--statuses", str(statuses), "--run-id", "1",
                "--output", str(output), "--today", "2026-09-20",
            ], check=True, capture_output=True)
            self.assertEqual(output.read_text(), "attention=true\n")
            self.assertEqual(json.loads(state.read_text())["providers"]["cpi"]["consecutive_failures"], 1)


if __name__ == "__main__":
    unittest.main()
