"""Exercise the review handoff without making real GitHub requests."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "open-market-brief-pr.sh"
POLICY_ERROR = (
    "pull request create failed: GraphQL: GitHub Actions is not permitted "
    "to create or approve pull requests (createPullRequest)"
)

MOCK_GH = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
with open(os.environ['MOCK_CALLS'], 'a') as out:
    out.write(json.dumps(args) + '\\n')
command = args[1]
if command == os.environ.get('MOCK_FAIL_COMMAND'):
    print(os.environ['MOCK_ERROR'], file=sys.stderr)
    sys.exit(7)
if command == 'list':
    print(os.environ.get('MOCK_PR_NUMBER', ''))
elif command == 'create':
    print('https://github.com/example/housing-market-lab/pull/42')
elif command != 'edit':
    sys.exit(9)
"""


class MarketBriefPRTests(unittest.TestCase):
    def run_handoff(self, *, fail_command="", error="", number="", month="2026-10"):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            mock = temp / "gh"
            mock.write_text(MOCK_GH)
            mock.chmod(0o755)
            (temp / "market-brief-review.md").write_text("Candidate for review\n")
            summary = temp / "summary.md"
            output = temp / "output.txt"
            calls = temp / "calls.jsonl"
            env = {
                **os.environ,
                "PATH": f"{temp}{os.pathsep}{os.environ['PATH']}",
                "ISSUE_MONTH": month,
                "GITHUB_REPOSITORY": "example/housing-market-lab",
                "RUNNER_TEMP": str(temp),
                "GITHUB_STEP_SUMMARY": str(summary),
                "GITHUB_OUTPUT": str(output),
                "MOCK_CALLS": str(calls),
                "MOCK_FAIL_COMMAND": fail_command,
                "MOCK_ERROR": error,
                "MOCK_PR_NUMBER": number,
            }
            result = subprocess.run(
                ["bash", str(SCRIPT)], env=env, text=True, capture_output=True
            )
            return (
                result,
                summary.read_text() if summary.exists() else "",
                output.read_text() if output.exists() else "",
                [json.loads(line) for line in calls.read_text().splitlines()]
                if calls.exists() else [],
            )

    def test_creates_draft_when_allowed(self):
        result, summary, output, calls = self.run_handoff()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("review_status=opened", output)
        self.assertIn("/pull/42", summary)
        self.assertEqual([call[1] for call in calls], ["list", "create"])
        self.assertIn("--draft", calls[1])
        self.assertIn("automation/market-brief-2026-10", calls[1])
        self.assertIn("--body-file", calls[1])

    def test_updates_existing_pr_without_creating_another(self):
        result, summary, output, calls = self.run_handoff(number="21")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("review_status=updated", output)
        self.assertIn("/pull/21", summary)
        self.assertEqual([call[1] for call in calls], ["list", "edit"])

    def test_repository_policy_provides_manual_review_fallback(self):
        result, summary, output, calls = self.run_handoff(
            fail_command="create", error=POLICY_ERROR
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stdout)
        self.assertIn("review_status=manual_required", output)
        self.assertIn("compare/main...automation/market-brief-2026-10?expand=1", summary)
        self.assertIn("market-brief-review-2026-10", summary)
        self.assertIn("No brief has been published", summary)
        self.assertIn("/settings/actions", summary)
        self.assertEqual(len(calls), 2)

    def test_other_create_errors_still_fail(self):
        for error in ("HTTP 401: Bad credentials", "HTTP 502: Bad gateway", "No commits between main and branch"):
            with self.subTest(error=error):
                result, summary, output, _ = self.run_handoff(
                    fail_command="create", error=error
                )
                self.assertEqual(result.returncode, 7)
                self.assertIn(error, result.stderr)
                self.assertNotIn("::warning::", result.stdout)
                self.assertEqual(summary, "")
                self.assertEqual(output, "")

    def test_listing_failure_does_not_attempt_creation(self):
        result, _, output, calls = self.run_handoff(
            fail_command="list", error="HTTP 403: Resource not accessible"
        )
        self.assertEqual(result.returncode, 7)
        self.assertEqual([call[1] for call in calls], ["list"])
        self.assertEqual(output, "")

    def test_edit_failure_is_not_hidden(self):
        result, _, output, calls = self.run_handoff(
            number="21", fail_command="edit", error=POLICY_ERROR
        )
        self.assertEqual(result.returncode, 7)
        self.assertEqual([call[1] for call in calls], ["list", "edit"])
        self.assertEqual(output, "")

    def test_invalid_month_does_not_call_github(self):
        result, _, output, calls = self.run_handoff(month="2026-13")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
