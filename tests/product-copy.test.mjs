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
