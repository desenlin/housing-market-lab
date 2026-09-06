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

test("does not fill a housing month without an official CPI observation", async () => {
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
