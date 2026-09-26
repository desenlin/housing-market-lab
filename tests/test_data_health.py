from datetime import date
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.data_health import PAGES_PROVIDERS, assess, expected_period, record_attempts, refresh_plan, render_report
from scripts.data_update_report import DATA_SOURCES
from tests import test_data_update_report as reports


ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / "config/data_health_policy.json").read_text())


class DataHealthTests(unittest.TestCase):
    def write_current_sources(self, root):
        for source in DATA_SOURCES:
            reports.DataUpdateReportTests().write_release(root, source.pointer, "current", {
                "latest_observations": {"test": "2026-08-31"},
                "series": {"us": {"latest_observation": "2026-08-31"}},
                "latest_observation": "2026-08-31",
                "latest_final_year": 2025,
                "latest_year": 2024,
            })

    def test_push_catches_up_only_overdue_permits_after_grace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_current_sources(root)
            reports.DataUpdateReportTests().write_release(root, "public/data/permits/provisional/latest.json", "old", {
                "latest_observation": "2026-07-31",
            })
            state = {"providers": {}}
            self.assertFalse(any(refresh_plan(root, POLICY, state, date(2026, 9, 24)).values()))
            plan = refresh_plan(root, POLICY, state, date(2026, 9, 26))
            self.assertEqual([group for group, needed in plan.items() if needed], ["permits"])
            self.assertEqual(state, {"providers": {}})

    def test_push_recovers_missing_release_and_repeated_failure_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_current_sources(root)
            (root / "public/data/redfin/releases/current/manifest.json").unlink()
            state = {"providers": {"cpi": {"consecutive_failures": 2}, "zillow": {"consecutive_failures": 1}}}
            plan = refresh_plan(root, POLICY, state, date(2026, 9, 26))
            self.assertEqual([group for group, needed in plan.items() if needed], ["redfin", "cpi"])

    def test_full_refresh_checks_all_routine_providers_but_keeps_annual_workflows_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_current_sources(root)
            state = {"providers": {"acs": {"consecutive_failures": 2}, "hcd": {"consecutive_failures": 2}}}
            self.assertFalse(any(refresh_plan(root, POLICY, state, date(2026, 9, 26)).values()))
            self.assertEqual(refresh_plan(root, POLICY, state, date(2026, 9, 26), full=True),
                             dict.fromkeys(PAGES_PROVIDERS, True))

    def test_refresh_plan_cli_is_read_only_and_emits_action_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_current_sources(root)
            (root / "config").mkdir()
            (root / "config/data_health_policy.json").write_text(json.dumps(POLICY))
            (root / ".github").mkdir()
            state = root / ".github/data-update-state.json"
            original = '{"schema_version":1,"providers":{"cpi":{"consecutive_failures":2}}}'
            state.write_text(original)
            output = root / "output"
            subprocess.run([
                "python", str(ROOT / "scripts/data_health.py"), "--root", str(root),
                "--plan-refresh", "--output", str(output), "--today", "2026-09-26",
            ], check=True, capture_output=True)
            self.assertEqual(output.read_text(), "needed=true\nzillow=false\nredfin=false\nrealtor=false\ncpi=true\npermits=false\n")
            self.assertEqual(state.read_text(), original)

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
