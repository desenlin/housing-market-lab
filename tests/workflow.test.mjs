import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("routine refresh checks CPI and building permits throughout the monthly release window", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );

  for (const day of [12, 18, 24, 28]) {
    assert.match(workflow, new RegExp(`cron: "23 13 ${day} \\* \\*"`));
  }
  assert.match(workflow, /python pipeline\/update_data\.py/);
  assert.match(workflow, /python pipeline\/update_realtor\.py/);
  assert.match(workflow, /python pipeline\/update_cpi\.py/);
  assert.match(workflow, /python pipeline\/update_permits\.py/);
  assert.match(workflow, /Realtor\.com refresh failed; retaining its prior validated releases/);
  assert.match(workflow, /BLS CPI refresh failed; retaining its prior validated release/);
  assert.match(workflow, /Census building permits refresh failed; retaining its prior validated releases/);
});
