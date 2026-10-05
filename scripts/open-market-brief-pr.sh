#!/usr/bin/env bash
# The caller must save the candidate branch and review artifact before this step.
set -euo pipefail

: "${ISSUE_MONTH:?ISSUE_MONTH is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
if ! [[ "$ISSUE_MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  echo "Invalid market brief issue month: $ISSUE_MONTH" >&2
  exit 1
fi

branch="automation/market-brief-${ISSUE_MONTH}"
review_note="$RUNNER_TEMP/market-brief-review.md"
test -f "$review_note"
export GH_PROMPT_DISABLED=1

pr_number="$(gh pr list --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -n "$pr_number" ]; then
  [[ "$pr_number" =~ ^[0-9]+$ ]]
  gh pr edit "$pr_number" --repo "$GITHUB_REPOSITORY" --title "Market brief: ${ISSUE_MONTH}" --body-file "$review_note"
  review_url="https://github.com/${GITHUB_REPOSITORY}/pull/${pr_number}"
  review_status="updated"
else
  error_file="$(mktemp "$RUNNER_TEMP/market-brief-pr-error.XXXXXX")"
  trap 'rm -f "$error_file"' EXIT
  if review_url="$(gh pr create --repo "$GITHUB_REPOSITORY" --draft --base main --head "$branch" --title "Market brief: ${ISSUE_MONTH}" --body-file "$review_note" 2>"$error_file")"; then
    review_status="opened"
  else
    create_status=$?
    cat "$error_file" >&2
    # Only this specific repository policy has a successful manual-review fallback.
    # Authentication, network, validation and all other errors must still fail.
    if [[ "$(<"$error_file")" != *"GitHub Actions is not permitted to create or approve pull requests"* ]]; then
      exit "$create_status"
    fi
    review_url="https://github.com/${GITHUB_REPOSITORY}/compare/main...${branch}?expand=1"
    review_status="manual_required"
    echo "::warning::Draft saved, but this repository disables pull request creation by GitHub Actions. Open the review link in the job summary to create a draft pull request."
    {
      printf '\n### Manual review required\n\n'
      printf 'The candidate is saved on `%s` and in the `market-brief-review-%s` artifact.\n\n' "$branch" "$ISSUE_MONTH"
      printf '[Review the changes and create a draft pull request](%s). No brief has been published.\n\n' "$review_url"
      printf 'Automatic PR creation is disabled by repository policy. A maintainer can enable **Allow GitHub Actions to create and approve pull requests** under [Settings → Actions → General](https://github.com/%s/settings/actions).\n' "$GITHUB_REPOSITORY"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
fi

if [ "$review_status" != "manual_required" ]; then
  printf '\n[Review the market brief pull request](%s). Publication still requires maintainer review and merge.\n' "$review_url" >> "$GITHUB_STEP_SUMMARY"
fi
printf 'review_status=%s\nreview_url=%s\n' "$review_status" "$review_url" >> "$GITHUB_OUTPUT"
