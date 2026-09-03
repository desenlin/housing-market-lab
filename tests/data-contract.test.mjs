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
});
