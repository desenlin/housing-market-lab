import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routine release checks exclude Zillow and keep provider results in the run summary", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  for (const day of [12, 18, 24, 28]) {
    assert.match(workflow, new RegExp(`cron: "23 13 ${day} \\* \\*"`));
  }
  assert.doesNotMatch(workflow, /python pipeline\/update_data\.py/);
  assert.match(workflow, /python pipeline\/update_realtor\.py/);
  assert.match(workflow, /python pipeline\/update_cpi\.py/);
  assert.match(workflow, /python pipeline\/update_permits\.py/);
  assert.match(workflow, /python scripts\/check_storage\.py/);
  assert.match(workflow, /Realtor\.com refresh failed; retaining its prior validated releases/);
  assert.match(workflow, /BLS CPI refresh failed; retaining its prior validated release/);
  assert.match(workflow, /Census building permits refresh failed; retaining its prior validated releases/);
  assert.match(workflow, /zillow=not_checked/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /DATA_REPORT_ISSUE/);
  assert.match(workflow, /python scripts\/data_update_report\.py snapshot/);
  assert.match(workflow, /--summary "\$GITHUB_STEP_SUMMARY"/);
  assert.doesNotMatch(workflow, /gh issue comment/);
  assert.doesNotMatch(workflow, /data_report_ready|data_report_b64|report_b64/);
});

test("ACS uses a separate low-frequency change-detecting workflow", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/update-acs.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /cron: "41 14 15 12,1,2 \*"/);
  assert.match(workflow, /python pipeline\/update_acs\.py/);
  assert.match(workflow, /CENSUS_API_KEY/);
  assert.match(workflow, /public\/data\/acs config\/acs_sources\.json/);
  assert.doesNotMatch(workflow, /update_data\.py/);
  assert.doesNotMatch(workflow, /update_redfin\.py/);
});
