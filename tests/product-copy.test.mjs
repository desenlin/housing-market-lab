import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readProjectFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("publishes the requested authorship, controls, and map attribution", async () => {
  const source = await readProjectFile("app/market-lab.tsx");
  assert.match(source, /Created by Desen Lin, California State University, Fullerton\./);
  assert.match(source, /Index starting month/);
  assert.match(source, /12-month growth/);
  assert.match(source, /Change from one year earlier/);
  assert.match(source, /https:\/\/tile\.openstreetmap\.org/);
  assert.match(source, /Map color gradient/);
  assert.match(source, /useState<MapPaletteKey>\("orange"\)/);
  assert.match(source, /Orange and Los Angeles Counties/);
  assert.match(source, /Local market activity/);
  assert.match(source, /Source: \{provider\}/);
  assert.match(source, /Definition of \$\{label\}/);
  assert.match(source, /rolling three-month window/i);
  assert.match(source, /View Redfin Data Center/);
  assert.match(source, /Inventory &amp; buyer interest — Realtor\.com/);
  assert.match(source, /View Realtor\.com Data Library/);
  assert.match(source, /Flagged observations remain visible but should be reviewed before reporting/);
  assert.match(source, /Hollow points identify flagged observations/);
  assert.match(source, /Market Hotness quadrant/);
  assert.match(source, /three Realtor\.com releases retained per product for rollback/);
  assert.match(source, /Gray boundaries have no data/);
  assert.match(source, /Outside city\/CDP geography/);
  assert.match(source, /Reading the maps/);
  assert.match(source, /Laguna Coast Wilderness Park/);
  assert.match(source, /No \$\{provider\} data for this/);
  assert.match(source, /Constant-dollar month/);
  assert.match(source, /Real \(inflation-adjusted\)/);
  assert.match(source, /LA-area CPI-U/);
  assert.match(source, /U\.S\. CPI-U/);
  assert.match(source, /Real rent is a purchasing-power measure, not an affordability measure/);
  assert.match(source, /className="footer-emphasis" href="https:\/\/desenlin\.com\/"/);
  assert.match(source, /className="footer-emphasis" href="https:\/\/business\.fullerton\.edu\/academics\/finance"/);
  assert.match(source, /Citation:<\/strong> Lin, D\. \(2026\)\. <cite>Housing Market Lab<\/cite> \[Computer software\]/);
});

test("repository front page includes citation and academic-use limits", async () => {
  const readme = await readProjectFile("README.md");
  assert.match(readme, /## Citation/);
  assert.match(readme, /## Academic-use disclaimer/);
  assert.match(readme, /not financial, investment, legal, valuation, or real-estate advice/i);
  assert.match(readme, /noncommercial academic-research use/i);
  assert.match(readme, /\[Desen Lin\]\(https:\/\/desenlin\.com\/\)/);
});

test("uses the academic website Google Analytics property", async () => {
  const layout = await readProjectFile("app/layout.tsx");
  assert.match(layout, /G-MDGMSFPEH2/);
});
