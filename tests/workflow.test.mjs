import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routine release checks include Zillow and keep provider results in the run summary", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  for (const day of [12, 18, 24, 28]) {
    assert.match(workflow, new RegExp(`cron: "23 13 ${day} \\* \\*"`));
  }
  assert.match(workflow, /python pipeline\/update_data\.py/);
  assert.match(workflow, /python scripts\/data_health\.py --plan-refresh/);
  assert.match(workflow, /if: \$\{\{ !inputs\.deploy_only \}\}/);
  assert.match(workflow, /if: steps\.refresh_plan\.outputs\.needed == 'true'/);
  assert.match(workflow, /python pipeline\/update_redfin\.py/);
  assert.match(workflow, /python pipeline\/update_realtor\.py/);
  assert.match(workflow, /python pipeline\/update_cpi\.py/);
  assert.match(workflow, /python pipeline\/update_permits\.py/);
  assert.match(workflow, /python scripts\/check_storage\.py/);
  assert.match(workflow, /Zillow refresh failed; retaining its prior validated release/);
  assert.match(workflow, /Realtor\.com refresh failed; retaining its prior validated releases/);
  assert.match(workflow, /BLS CPI refresh failed; retaining its prior validated release/);
  assert.match(workflow, /Census building permits refresh failed; retaining its prior validated releases/);
  assert.match(workflow, /zillow="\$zillow_status"/);
  assert.doesNotMatch(workflow, /zillow=not_checked/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /DATA_REPORT_ISSUE/);
  assert.match(workflow, /python scripts\/data_update_report\.py snapshot/);
  assert.match(workflow, /--summary "\$GITHUB_STEP_SUMMARY"/);
  assert.doesNotMatch(workflow, /gh issue comment/);
  assert.doesNotMatch(workflow, /data_report_ready|data_report_b64|report_b64/);
  assert.match(workflow, /name: validated-site-ref/);
  assert.match(workflow, /git rev-parse HEAD > "\$RUNNER_TEMP\/validated-site-sha\.txt"/);
  assert.match(workflow, /actions\/configure-pages@v6/);
  assert.match(workflow, /--site-url "https:\/\/desenlin\.com\/housing-market-lab\/"/);
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
  assert.match(workflow, /group: pages/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /gh workflow run pages\.yml --ref main -f deploy_only=true/);
  assert.doesNotMatch(workflow, /update_data\.py/);
  assert.doesNotMatch(workflow, /update_redfin\.py/);
  assert.match(workflow, /--check-revisions/);
  assert.match(workflow, /Record ACS update health/);
  assert.match(workflow, /Enforce ACS update health/);
});

test("annual data workflows serialize commits and explicitly deploy changed releases", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/update-hcd.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /group: pages/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /gh workflow run pages\.yml --ref main -f deploy_only=true/);
  assert.match(workflow, /Record HCD update health/);
  assert.match(workflow, /Enforce HCD update health/);
});

test("health failures preserve deployment independence and durable attempt state", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const deploy = workflow.split("\n  deploy:\n")[1].split("\n  data-health:\n")[0];
  assert.match(deploy, /needs: build/);
  assert.doesNotMatch(deploy, /needs:.*data-health/);
  assert.match(workflow, /health_attention: \$\{\{ steps\.health\.outputs\.attention \}\}/);
  assert.match(workflow, /git add \.github\/data-update-state\.json/);
  assert.match(workflow, /!cancelled\(\).*steps\.health\.outcome == 'success'/);
  assert.match(workflow, /if \[ "\$STORAGE_OUTCOME" = "success" \]; then\s+git add public\/data/);
  assert.match(workflow, /--force-history/);
  assert.match(workflow, /01\|04\|07\|10/);
});

test("market brief automation evaluates the exact successful Pages revision", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/prepare-market-brief.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /actions\/download-artifact@v8/);
  assert.match(workflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflow, /git checkout --detach "\$validated_sha"/);
});
