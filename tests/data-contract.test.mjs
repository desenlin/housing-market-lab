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
    "Atlanta, GA",
    "Boston, MA",
    "Chicago, IL",
    "Dallas, TX",
    "Denver, CO",
    "Detroit, MI",
    "Houston, TX",
    "Los Angeles, CA",
    "Miami, FL",
    "Minneapolis, MN",
    "New York, NY",
    "Orlando, FL",
    "Philadelphia, PA",
    "Phoenix, AZ",
    "Riverside, CA",
    "San Diego, CA",
    "San Francisco, CA",
    "San Jose, CA",
    "Seattle, WA",
    "Tampa, FL",
    "Washington, DC",
  ]);
  assert.deepEqual([...new Set(metro.regions.map((region) => region.division))].sort(), [
    "East North Central",
    "Middle Atlantic",
    "Mountain",
    "New England",
    "Pacific",
    "South Atlantic",
    "West North Central",
    "West South Central",
  ]);
  assert.deepEqual(
    metro.regions.flatMap((region) => region.population_rank ?? []).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal(metro.regions.find((region) => region.name === "San Jose, CA")?.selection_note, "Selected California comparator");
  assert.equal(metro.regions.find((region) => region.name === "Riverside, CA")?.role, "nearby");
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
    assert.equal(manifest.schema_version, 3);
    assert.equal(manifest.product, product);
    assert.equal(manifest.retained_releases, 3);
    assert.equal(zip.regions.length, manifest.counts.zip);
    assert.ok(zip.regions.length >= 150);
    assert.deepEqual(Object.keys(zip.metrics).sort(), expectedMetrics);
    assert.ok(Object.values(zip.metrics).every((metric) => metric.frequency === "Monthly"));
    assert.ok(Object.values(zip.metrics).every((metric) => metric.dates.length >= 60));
    assert.ok(zip.regions.every((region) => region.id.startsWith("zcta:")));
    assert.ok(zip.regions.some((region) => region.name === "92831" && region.context === "Fullerton"));
    assert.ok(zip.regions.every((region) => Array.isArray(region.quality?.[product])));
    assert.equal(typeof manifest.source.flagged_local_rows_retained, "number");
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

test("building permit pointers separate final history from the open preliminary year", async () => {
  const [historyPointer, provisionalPointer] = await Promise.all([
    readJson("permits/history/latest.json"),
    readJson("permits/provisional/latest.json"),
  ]);
  const historyPrefix = `permits/history/releases/${historyPointer.release}/`;
  const provisionalPrefix = `permits/provisional/releases/${provisionalPointer.release}/`;
  const [historyManifest, annual, finalMonthly, provisionalManifest, openMonthly] = await Promise.all([
    readJson(`${historyPrefix}manifest.json`),
    readJson(`${historyPrefix}annual.json`),
    readJson(`${historyPrefix}monthly.json`),
    readJson(`${provisionalPrefix}manifest.json`),
    readJson(`${provisionalPrefix}monthly.json`),
  ]);
  assert.equal(historyManifest.provider, "U.S. Census Bureau Building Permits Survey");
  assert.equal(historyManifest.counts.jurisdictions, 124);
  assert.equal(historyManifest.counts.cities, 122);
  assert.equal(annual.dates[0], "1980");
  assert.equal(annual.dates.at(-1), String(historyManifest.latest_final_year));
  assert.equal(annual.dates.length, historyManifest.latest_final_year - 1979);
  assert.equal(finalMonthly.dates[0], "2022-01");
  assert.ok(openMonthly.dates.every((date) => Number(date.slice(0, 4)) > historyManifest.latest_final_year));
  assert.equal(openMonthly.dates.at(-1), provisionalManifest.latest_observation);
  assert.equal(annual.regions.length, 124);
  assert.equal(openMonthly.regions.length, 124);
  assert.ok(annual.regions.every((region) => region.series.total_units.length === annual.dates.length));
  assert.ok(openMonthly.regions.every((region) => region.quality.imputed.every((index) => index < openMonthly.dates.length)));
  assert.ok(annual.regions.some((region) => region.name === "Orange County Unincorporated Area"));
  assert.ok(!annual.regions.some((region) => region.name === "Rossmoor"));
});
