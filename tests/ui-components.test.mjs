import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

test("permit ranking changes use unit differences and matched calendar periods", async () => {
  const { permitChange, formatPermitChange } = await vite.ssrLoadModule("/lib/permit-change.ts");
  assert.equal(permitChange([0, 240], ["2024", "2025"], 1, "units"), 240);
  assert.equal(permitChange([240, 15], ["2024", "2025"], 1, "units"), -225);
  assert.equal(permitChange([100, 800, 140], ["2025-07", "2026-06", "2026-07"], 2, "units"), 40);
  assert.equal(permitChange([100, 140], ["2025-06", "2026-07"], 1, "units"), null);
  assert.equal(permitChange([null, 140], ["2025-07", "2026-07"], 1, "units"), null);
  assert.equal(permitChange([100, null], ["2025-07", "2026-07"], 1, "units"), null);
  assert.ok(Math.abs(permitChange([0.4, 0.5], ["2024", "2025"], 1, "share") - 10) < 1e-10);
  assert.equal(permitChange([2.5, 4], ["2024", "2025"], 1, "rate"), 1.5);
  assert.equal(formatPermitChange(240, "units"), "+240");
  assert.equal(formatPermitChange(-225, "units"), "-225");
  assert.equal(formatPermitChange(10, "share"), "+10 pp");
  assert.equal(formatPermitChange(1.5, "rate"), "+1.5");
  assert.equal(formatPermitChange(null, "units"), "—");
});

test("rolling permit rankings require complete windows and aggregate shares from units", async () => {
  const { trailingPermitValue, trailingPermitChange } = await vite.ssrLoadModule("/lib/permit-change.ts");
  const dates = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 7));
  const region = { housing_stock: 1000, series: {
    total_units: Array(12).fill(0).concat(Array(11).fill(10), [100]),
    large_multifamily: Array(23).fill(0).concat([100]),
  } };
  assert.equal(trailingPermitValue(region, dates, 23, "total_units"), 210);
  assert.equal(trailingPermitChange(region, dates, 23, "total_units", "units"), 210);
  assert.equal(trailingPermitValue(region, dates, 23, "large_multifamily_share"), 100 / 210);
  assert.equal(trailingPermitValue(region, dates, 23, "units_per_1000_stock"), 210);
  assert.equal(trailingPermitValue(region, dates, 10, "total_units"), null);
  assert.equal(trailingPermitChange(region, dates, 22, "total_units", "units"), null);
  assert.equal(trailingPermitValue(region, dates.map((d, i) => i === 15 ? "2020-01" : d), 23, "total_units"), null);
  region.series.total_units[15] = null;
  assert.equal(trailingPermitValue(region, dates, 23, "total_units"), null);
  assert.equal(trailingPermitChange(region, dates, 23, "total_units", "units"), null);
});

test("forwards progress semantics to the primitive", async () => {
  const { Progress } = await vite.ssrLoadModule("/components/ui/progress.tsx");
  const html = renderToStaticMarkup(React.createElement(Progress, { value: 37 }));

  assert.match(html, /aria-valuenow="37"/);
  assert.match(html, /aria-valuetext="37%"/);
  assert.match(html, /data-state="loading"/);
});

test("emits chart themes for the starter's media dark mode", async () => {
  const { ChartStyle } = await vite.ssrLoadModule("/components/ui/chart.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ChartStyle, {
      id: "contract",
      config: {
        latency: { theme: { light: "#ffffff", dark: "#000000" } },
      },
    }),
  );

  assert.match(html, /\[data-chart=contract\]/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /\.dark/);
});

test("renders sidebar skeletons deterministically", async () => {
  const { SidebarMenuSkeleton } = await vite.ssrLoadModule(
    "/components/ui/sidebar.tsx",
  );
  const first = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));
  const second = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));

  assert.equal(first, second);
  assert.match(first, /--skeleton-width:70%/);
});

test("calculates real growth as an exact CPI ratio", async () => {
  const { applyPriceAdjustment, transformValues } = await vite.ssrLoadModule(
    "/app/market-lab.tsx",
  );
  const dates = [
    "2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30",
    "2024-05-31", "2024-06-30", "2024-07-31", "2024-08-31",
    "2024-09-30", "2024-10-31", "2024-11-30", "2024-12-31",
    "2025-01-31",
  ];
  const cpi = {
    key: "la",
    dates,
    values: Array(12).fill(100).concat(110),
  };
  const series = { dates, values: Array(12).fill(100).concat(120), unit: "usd", changeMode: "percent" };
  const adjusted = applyPriceAdjustment(series, "zhvi", {
    basis: "real",
    cpi,
    baseMonth: "2025-01",
  });
  const realYoy = transformValues(adjusted.values, "yoy", adjusted.dates);

  assert.equal(adjusted.values[0], 110);
  assert.equal(adjusted.values[12], 120);
  assert.ok(Math.abs(realYoy[12] - (1.2 / 1.1 - 1)) < 1e-12);
});

test("real-data coverage stops at the latest matching CPI month", async () => {
  const { latestComparableDate } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const dates = ["2026-06-30", "2026-07-31", "2026-08-31"];
  const adjustment = { basis: "real", cpi: { dates: ["2026-06-30", "2026-07-31"], values: [100, 101] } };
  assert.equal(latestComparableDate(dates, "zhvi", adjustment), "2026-07-31");
  assert.equal(latestComparableDate(dates, "zori", adjustment), "2026-07-31");
  assert.equal(latestComparableDate(dates, "zhvi", { ...adjustment, basis: "nominal" }), "2026-08-31");
  assert.equal(latestComparableDate(dates, "inventory", adjustment), "2026-08-31");
  assert.equal(latestComparableDate([], "zhvi", adjustment), undefined);
});

test("does not fill a missing CPI observation without an approved rule", async () => {
  const { applyPriceAdjustment } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const dates = ["2025-09-30", "2025-10-31", "2025-11-30"];
  const adjusted = applyPriceAdjustment(
    { dates, values: [100, 101, 102], unit: "usd", changeMode: "percent" },
    "zhvi",
    {
      basis: "real",
      cpi: { key: "la", dates, values: [100, null, 102] },
      baseMonth: "2025-11",
    },
  );
  assert.deepEqual(adjusted.values, [102, null, 102]);
});

test("log-linearly interpolates only the approved October 2025 real-value deflator", async () => {
  const { applyPriceAdjustment } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const dates = ["2025-09-30", "2025-10-31", "2025-11-30"];
  const cpiValues = [100, null, 104];
  const adjusted = applyPriceAdjustment(
    { dates, values: [100, 101, 102], unit: "usd", changeMode: "percent" },
    "zori",
    {
      basis: "real",
      cpi: { key: "us", dates, values: cpiValues },
      baseMonth: "2025-11",
      interpolationRules: [{
        month: "2025-10",
        method: "log_linear",
        reason: "Administrative collection gap",
      }],
    },
  );

  assert.ok(Math.abs(adjusted.values[1] - 101 * 104 / Math.sqrt(100 * 104)) < 1e-12);
  assert.equal(cpiValues[1], null);
});

test("leaves a newer Zillow month null until its CPI observation arrives", async () => {
  const { applyPriceAdjustment } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const adjusted = applyPriceAdjustment(
    {
      dates: ["2025-01-31", "2025-02-28", "2025-03-31"],
      values: [100, 102, 104],
      unit: "usd",
      changeMode: "percent",
    },
    "zhvi",
    {
      basis: "real",
      cpi: {
        key: "la",
        dates: ["2025-01-31", "2025-02-28"],
        values: [100, 101],
      },
      baseMonth: "2025-02",
    },
  );

  assert.deepEqual(adjusted.values, [101, 102, null]);
});

test("ignores a newer CPI month when Zillow has not published it", async () => {
  const { normalizedRealBaseMonth } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const cpi = {
    key: "la",
    dates: ["2025-01-31", "2025-02-28", "2025-03-31"],
    values: [100, 101, 102],
  };

  assert.equal(
    normalizedRealBaseMonth(cpi, ["2025-01-31", "2025-02-28"], ""),
    "2025-02",
  );
});

test("uses distinct, evenly spaced time-axis labels", async () => {
  const { timeAxisTicks } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const dates = Array.from({ length: 132 }, (_, index) => {
    const date = new Date(Date.UTC(2015, index, 28));
    return date.toISOString().slice(0, 10);
  });
  const ticks = timeAxisTicks(dates);

  assert.equal(ticks.length, 6);
  assert.equal(new Set(ticks.map((date) => date.slice(0, 4))).size, ticks.length);
  assert.equal(ticks[0].slice(0, 4), "2015");
  assert.equal(ticks.at(-1).slice(0, 4), "2025");
});

test("uses a focused y-axis while preserving meaningful change baselines", async () => {
  const { valueAxisDomain } = await vite.ssrLoadModule("/app/market-lab.tsx");
  const rows = [
    { date: "2025-01-31", metro: 0.985 },
    { date: "2025-02-28", metro: 1.015 },
  ];

  const levelDomain = valueAxisDomain(rows, ["metro"], "level");
  const changeDomain = valueAxisDomain([{ metro: 0.012 }, { metro: 0.019 }], ["metro"], "yoy");

  assert.ok(levelDomain[0] > 0.9);
  assert.ok(levelDomain[1] < 1.1);
  assert.ok(changeDomain[0] < 0);
  assert.ok(changeDomain[1] > 0.019);
});


test("inflation rates use calendar months and preserve missing bases", async () => {
  const { inflationValues } = await vite.ssrLoadModule("/lib/inflation.ts");
  const series = { dates: ["2024-01-31", "2024-02-29", "2025-01-31", "2025-02-28"], values: [100, null, 110, 112] };
  const yoy = inflationValues(series, "yoy", "2024-01");
  assert.equal(yoy[0], null);
  assert.ok(Math.abs(yoy[2] - 0.1) < 1e-12);
  assert.equal(yoy[3], null);
  assert.deepEqual(inflationValues(series, "cumulative", "2024-02"), [null, null, null, null]);
  assert.ok(Math.abs(inflationValues(series, "cumulative", "2024-01")[3] - 0.12) < 1e-12);
});

test("inflation snapshots use a common observed month and selection can be emptied", async () => {
  const { commonInflationMonths, toggleInflationCategory } = await vite.ssrLoadModule("/lib/inflation.ts");
  const first = { dates: ["2025-09-30", "2025-10-31", "2025-11-30"], values: [100, null, 102] };
  const lagging = { dates: ["2025-09-30", "2025-10-31"], values: [101, 102] };
  assert.deepEqual(commonInflationMonths([first, lagging]), ["2025-09"]);
  assert.deepEqual(toggleInflationCategory(["food"], "food"), []);
  assert.deepEqual(toggleInflationCategory([], "energy"), ["energy"]);
  const full = ["all", "core", "food", "energy", "shelter"];
  assert.deepEqual(toggleInflationCategory(full, "rent"), full);
  assert.deepEqual(toggleInflationCategory(full, "food"), ["all", "core", "energy", "shelter"]);
});
