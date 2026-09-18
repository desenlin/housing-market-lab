import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../public/data/", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));
const normalizedName = (name) => name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const readDataset = async (prefix, manifest, geography) => {
  const names = manifest.files?.[geography] ?? [`${geography}.json`];
  const shards = await Promise.all(names.map((name) => readJson(`${prefix}${name}`)));
  return { ...shards[0], regions: shards.flatMap((shard) => shard.regions) };
};
const readMap = async (prefix, manifest, geography) => {
  const shards = await Promise.all(manifest.files[geography].map((name) => readJson(`${prefix}${name}`)));
  return {
    geography,
    counties: Object.assign({}, ...shards.map((shard) => shard.counties)),
  };
};

test("latest pointer resolves to a complete release", async () => {
  const latest = await readJson("latest.json");
  const prefix = `releases/${latest.release}/`;
  const manifest = await readJson(`${prefix}manifest.json`);
  const [city, zip, metro] = await Promise.all([
    readDataset(prefix, manifest, "city"),
    readDataset(prefix, manifest, "zip"),
    readDataset(prefix, manifest, "metro"),
  ]);
  const mapPointer = await readJson("maps/latest.json");
  const mapPrefix = `maps/releases/${mapPointer.release}/`;
  const mapManifest = await readJson(`${mapPrefix}manifest.json`);
  const [cityMap, zipMap] = await Promise.all([
    readMap(mapPrefix, mapManifest, "city"),
    readMap(mapPrefix, mapManifest, "zip"),
  ]);
  assert.equal(manifest.release, latest.release);
  assert.equal(manifest.storage_schema_version, 2);
  assert.equal(city.regions.length, manifest.counts.city);
  assert.equal(zip.regions.length, manifest.counts.zip);
  assert.equal(metro.regions.length, manifest.counts.metro);
  // Coverage can grow or shrink between provider releases. Keep the pipeline's
  // minimum coverage safeguards, but do not freeze counts to a past snapshot.
  assert.ok(city.regions.length >= 140);
  assert.ok(zip.regions.length >= 340);
  assert.ok(city.metrics.zhvi.dates.length > 250);
  assert.ok(zip.metrics.zori.dates.length > 100);
  assert.equal(mapManifest.release, mapPointer.release);
  assert.equal(manifest.map_release, mapPointer.release);
  const counties = ["Los Angeles County", "Orange County"];
  for (const [geography, dataset, map] of [["city", city, cityMap], ["zip", zip, zipMap]]) {
    assert.equal(new Set(dataset.regions.map((region) => region.id)).size, dataset.regions.length,
      `${geography}: duplicate data region IDs`);
    assert.deepEqual([...new Set(dataset.regions.map((region) => region.county))].sort(), counties);
    assert.deepEqual(Object.keys(map.counties).sort(), counties);
    for (const county of counties) {
      const label = `${geography}, ${county}`;
      const coverage = map.counties[county];
      const dataRegions = dataset.regions.filter((region) => region.county === county);
      // Zillow and Census use different city IDs; join their county-scoped names.
      const names = new Set(dataRegions.map((region) => normalizedName(region.name)));
      assert.equal(names.size, dataRegions.length, `${label}: duplicate data region names`);
      assert.equal(new Set(coverage.regions.map((region) => region.id)).size, coverage.regions.length,
        `${label}: duplicate map region IDs`);
      assert.equal(new Set(coverage.regions.map((region) => normalizedName(region.name))).size,
        coverage.regions.length, `${label}: duplicate map region names`);
      assert.ok(coverage.regions.every((region) => region.county === county
        && ["Polygon", "MultiPolygon"].includes(region.geometry?.type)
        && region.geometry.coordinates.length > 0), `${label}: invalid map boundary`);
      const mapped = coverage.regions.filter((region) => names.has(normalizedName(region.name))).length;
      assert.ok(mapped > 0, `${label}: no data regions matched the map`);
      assert.equal(coverage.available, dataRegions.length, `${label}: available count`);
      assert.equal(coverage.boundaries, coverage.regions.length, `${label}: boundary count`);
      assert.equal(coverage.mapped, mapped, `${label}: mapped count`);
      assert.deepEqual(manifest.map_coverage[geography][county], {
        available: dataRegions.length, boundaries: coverage.regions.length, mapped,
      }, `${label}: manifest coverage`);
      // City maps also retain Census places without Zillow data. ZIP maps contain
      // only covered ZCTAs, so every ZIP observation must have a boundary.
      if (geography === "zip") {
        assert.equal(mapped, dataRegions.length, `${label}: missing ZIP boundaries`);
        assert.equal(coverage.regions.length, mapped, `${label}: unexpected ZIP boundaries`);
      }
    }
  }
  assert.ok(cityMap.counties["Orange County"].regions.some((region) =>
    region.name === "Rossmoor" && region.id === "place:0663050"
  ));
  const [[minLat, minLon], [maxLat, maxLon]] = cityMap.counties["Los Angeles County"].bounds;
  assert.ok(maxLat - minLat < 2);
  assert.ok(maxLon - minLon < 2);
});

test("metro comparison contains the intended unique markets", async () => {
  const latest = await readJson("latest.json");
  const prefix = `releases/${latest.release}/`;
  const manifest = await readJson(`${prefix}manifest.json`);
  const metro = await readDataset(prefix, manifest, "metro");
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
  const manifest = await readJson(`${prefix}manifest.json`);
  const [city, zip] = await Promise.all([
    readDataset(prefix, manifest, "city"),
    readDataset(prefix, manifest, "zip"),
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
    const manifest = await readJson(`${prefix}manifest.json`);
    const zip = await readDataset(prefix, manifest, "zip");
    assert.equal(manifest.provider, "Realtor.com® Economic Research");
    assert.equal(manifest.schema_version, 3);
    assert.equal(manifest.product, product);
    assert.equal(manifest.retained_releases, 2);
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
  assert.deepEqual(cpi.real_value_interpolation.map(({ month, method }) => ({ month, method })), [
    { month: "2025-10", method: "log_linear" },
  ]);
  assert.deepEqual(manifest.real_value_interpolation, cpi.real_value_interpolation);
  for (const series of Object.values(cpi.series)) {
    const october = series.dates.findIndex((date) => date.startsWith("2025-10"));
    assert.equal(series.values[october], null);
    assert.ok(series.missing_observations.includes(series.dates[october]));
  }
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

test("ACS pointer resolves to compact current and non-overlapping context data", async () => {
  const pointer = await readJson("acs/latest.json");
  const prefix = `acs/releases/${pointer.release}/`;
  const [manifest, city, zip] = await Promise.all([
    readJson(`${prefix}manifest.json`),
    readJson(`${prefix}city.json`),
    readJson(`${prefix}zip.json`),
  ]);
  assert.equal(manifest.provider, "U.S. Census Bureau American Community Survey");
  assert.equal(manifest.release, pointer.release);
  assert.ok(Number.isInteger(manifest.latest_year) && Number.isInteger(manifest.comparison_year));
  assert.equal(manifest.latest_year - manifest.comparison_year, 5);
  assert.deepEqual(manifest.periods, [manifest.comparison_year, manifest.latest_year]
    .map((year) => `${year - 4}–${year}`));
  for (const [geography, dataset, minimum] of [["city", city, 170], ["zip", zip, 330]]) {
    assert.deepEqual(dataset.periods, manifest.periods);
    assert.equal(dataset.regions.length, manifest.counts[geography]);
    assert.equal(new Set(dataset.regions.map((region) => region.id)).size, dataset.regions.length,
      `${geography}: duplicate ACS region IDs`);
    const covered = dataset.regions.filter((region) => Object.values(region.series)
      .some((values) => values.some(Number.isFinite))).length;
    assert.ok(covered >= minimum, `${geography}: ACS coverage fell below the pipeline floor`);
  }
  assert.equal(city.comparison_available, true);
  assert.equal(zip.comparison_available, false);
  assert.deepEqual(Object.keys(city.metrics).sort(), [
    "average_household_size",
    "median_age",
    "median_household_income",
    "multifamily_share",
    "rent_burden_share",
    "renter_share",
  ]);
  const fullerton = city.regions.find((region) => region.name === "Fullerton");
  assert.ok(fullerton);
  assert.ok(fullerton.series.median_household_income.every(Number.isFinite));
  assert.ok(fullerton.moe.renter_share.every(Number.isFinite));
  const zip92831 = zip.regions.find((region) => region.name === "92831");
  assert.ok(zip92831);
  assert.equal(zip92831.series.median_household_income[0], null);
  assert.ok(Number.isFinite(zip92831.series.median_household_income[1]));
});

test("HCD pointer resolves to a complete, internally consistent annual release", async () => {
  const pointer = await readJson("hcd/latest.json");
  const prefix = `hcd/releases/${pointer.release}/`;
  const payload = await readFile(new URL(`${prefix}annual.json`, root));
  const [manifest, annual] = await Promise.all([
    readJson(`${prefix}manifest.json`),
    JSON.parse(payload.toString("utf8")),
  ]);
  const digest = createHash("sha256").update(payload).digest("hex");

  assert.equal(manifest.provider, "California HCD");
  assert.equal(manifest.release, pointer.release);
  assert.equal(digest, pointer.bundle_sha256);
  assert.equal(digest, manifest.bundle_sha256);
  assert.deepEqual(manifest.files.annual, ["annual.json"]);
  assert.ok(payload.byteLength < 1_000_000);
  assert.equal(annual.schema_version, 1);
  assert.equal(annual.years.at(-1), manifest.latest_year);
  assert.deepEqual(
    annual.years,
    Array.from({ length: manifest.latest_year - 2017 }, (_, index) => 2018 + index),
  );
  assert.equal(annual.regions.length, 124);
  assert.equal(new Set(annual.regions.map((region) => region.id)).size, 124);
  assert.deepEqual([...new Set(annual.regions.map((region) => region.county))].sort(), [
    "Los Angeles County",
    "Orange County",
  ]);
  assert.deepEqual([...new Set(annual.regions.map((region) => region.jurisdiction_type))].sort(), [
    "county_unincorporated",
    "incorporated_city",
  ]);
  assert.deepEqual(Object.keys(annual.types).sort(), ["2-4", "5+", "ADU", "MH", "Other", "SFA", "SFD"]);
  assert.equal(annual.income_fields.length, 11);
  assert.deepEqual(annual.audit, manifest.audit);

  for (const region of annual.regions) {
    assert.equal(region.annual.length, annual.years.length);
    assert.ok(Number.isFinite(region.housing_stock) && region.housing_stock > 0);
    for (const cell of region.annual) {
      if (cell == null) continue;
      assert.ok(Number.isInteger(cell.records) && cell.records >= 0);
      for (const stage of [cell.permits, cell.completions]) {
        assert.ok(stage.total == null || (Number.isInteger(stage.total) && stage.total >= 0));
        assert.deepEqual(Object.keys(stage.types).sort(), Object.keys(annual.types).sort());
        assert.ok(Object.values(stage.types).every((value) => Number.isInteger(value) && value >= 0));
        assert.ok(stage.income == null || (
          stage.income.length === annual.income_fields.length
          && stage.income.every((value) => Number.isInteger(value) && value >= 0)
        ));
      }
    }
  }
});
