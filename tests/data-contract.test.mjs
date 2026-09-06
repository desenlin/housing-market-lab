import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../public/data/", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));

test("latest pointer resolves to a complete release", async () => {
  const latest = await readJson("latest.json");
  const prefix = `releases/${latest.release}/`;
  const [manifest, city, zip, metro, cityMap, zipMap] = await Promise.all([
    readJson(`${prefix}manifest.json`),
    readJson(`${prefix}city.json`),
    readJson(`${prefix}zip.json`),
    readJson(`${prefix}metro.json`),
    readJson(`${prefix}map-city.json`),
    readJson(`${prefix}map-zip.json`),
  ]);
  assert.equal(manifest.release, latest.release);
  assert.equal(city.regions.length, manifest.counts.city);
  assert.equal(zip.regions.length, manifest.counts.zip);
  assert.equal(metro.regions.length, manifest.counts.metro);
  assert.ok(city.metrics.zhvi.dates.length > 250);
  assert.ok(zip.metrics.zori.dates.length > 100);
  assert.equal(cityMap.counties["Orange County"].mapped, 39);
  assert.equal(cityMap.counties["Orange County"].boundaries, 47);
  assert.ok(cityMap.counties["Orange County"].regions.some((region) =>
    region.name === "Rossmoor" && region.id === "place:0663050"
  ));
  assert.equal(zipMap.counties["Los Angeles County"].mapped, 274);
  assert.ok(cityMap.counties["Orange County"].regions.every((region) => region.geometry));
  assert.ok(zipMap.counties["Los Angeles County"].regions.every((region) => region.geometry));
  const [[minLat, minLon], [maxLat, maxLon]] = cityMap.counties["Los Angeles County"].bounds;
  assert.ok(maxLat - minLat < 2);
  assert.ok(maxLon - minLon < 2);
});

test("metro comparison contains the intended unique markets", async () => {
  const latest = await readJson("latest.json");
  const metro = await readJson(`releases/${latest.release}/metro.json`);
  const names = metro.regions.map((region) => region.name);
  assert.deepEqual([...new Set(names)].sort(), [
    "Austin",
    "Los Angeles",
    "Phoenix",
    "Riverside",
    "San Diego",
    "San Francisco",
    "San Jose",
  ]);
});

test("Redfin pointer resolves to an independent local activity release", async () => {
  const latest = await readJson("redfin/latest.json");
  const prefix = `redfin/releases/${latest.release}/`;
  const [manifest, city, zip] = await Promise.all([
    readJson(`${prefix}manifest.json`),
    readJson(`${prefix}city.json`),
    readJson(`${prefix}zip.json`),
  ]);
  assert.equal(manifest.provider, "Redfin");
  assert.equal(manifest.frequency, "Rolling 3 Months");
  assert.equal(city.regions.length, manifest.counts.city);
  assert.equal(zip.regions.length, manifest.counts.zip);
  assert.ok(city.regions.length >= 45);
  assert.ok(zip.regions.length >= 160);
  assert.deepEqual(Object.keys(city.metrics).sort(), [
    "median_dom",
    "median_sale_ppsf",
    "months_supply",
    "price_drop_share",
    "sold_above_original_share",
  ]);
  assert.ok(Object.values(city.metrics).every((metric) => metric.provider === "Redfin"));
  assert.ok(Object.values(city.metrics).every((metric) => metric.dates.length >= 60));
  assert.ok(city.regions.some((region) =>
    region.name === "Rossmoor" &&
    region.county === "Orange County" &&
    region.id === "place:0663050"
  ));
});

test("Realtor.com pointers resolve independently to compact ZIP releases", async () => {
  const products = {
    inventory: ["active_listing_count", "new_listing_count", "pending_ratio"],
    hotness: ["demand_score", "hotness_score", "realtor_median_dom", "supply_score", "viewer_ratio"],
  };
  for (const [product, expectedMetrics] of Object.entries(products)) {
    const latest = await readJson(`realtor/${product}/latest.json`);
    const prefix = `realtor/${product}/releases/${latest.release}/`;
    const [manifest, zip] = await Promise.all([
      readJson(`${prefix}manifest.json`),
      readJson(`${prefix}zip.json`),
    ]);
    assert.equal(manifest.provider, "Realtor.com® Economic Research");
    assert.equal(manifest.product, product);
    assert.equal(manifest.retained_releases, 3);
    assert.equal(zip.regions.length, manifest.counts.zip);
    assert.ok(zip.regions.length >= 150);
    assert.deepEqual(Object.keys(zip.metrics).sort(), expectedMetrics);
    assert.ok(Object.values(zip.metrics).every((metric) => metric.frequency === "Monthly"));
    assert.ok(Object.values(zip.metrics).every((metric) => metric.dates.length >= 60));
    assert.ok(zip.regions.every((region) => region.id.startsWith("zcta:")));
  }
});

test("BLS CPI pointer resolves to complete LA-area and U.S. series", async () => {
  const latest = await readJson("cpi/latest.json");
  const prefix = `cpi/releases/${latest.release}/`;
  const [manifest, cpi] = await Promise.all([
    readJson(`${prefix}manifest.json`),
    readJson(`${prefix}cpi.json`),
  ]);
  assert.equal(manifest.provider, "U.S. Bureau of Labor Statistics");
  assert.equal(cpi.series.la.id, "CUURS49ASA0");
  assert.equal(cpi.series.us.id, "CUUR0000SA0");
  assert.ok(cpi.series.la.dates.length >= 300);
  assert.equal(cpi.series.la.dates.length, cpi.series.la.values.length);
  assert.equal(cpi.series.us.dates.length, cpi.series.us.yoy.length);
  assert.equal(cpi.series.la.seasonal_adjustment, "Not seasonally adjusted");
  assert.ok(cpi.series.la.values.some((value) => value === null));
});
