import { test, expect } from "@playwright/test";

test("charts recover from tab, lens, and viewport changes without dimension warnings", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (/width\(-?\d+\).*height\(-?\d+\).*chart should be greater/i.test(message.text())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  // Browser checks must not send analytics events or depend on remote map tiles.
  await page.route(/google-analytics\.com|googletagmanager\.com|tile\.openstreetmap\.org/, (route) => route.abort());
  await page.goto("./");

  async function chartIsVisible() {
    await expect(page.locator('[role="tabpanel"]:visible svg.recharts-surface[role="application"]').first()).toBeVisible();
    const charts = page.locator('[role="tabpanel"]:visible [data-measured-chart]');
    await expect.poll(() => charts.count()).toBeGreaterThan(0);
    for (const chart of await charts.all()) {
      await expect(chart.locator('svg.recharts-surface[role="application"]')).toBeVisible();
      const bounds = await chart.boundingBox();
      expect(bounds?.width).toBeGreaterThan(0);
      expect(bounds?.height).toBeGreaterThan(0);
    }
  }

  for (const width of [1280, 640, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of ["Prices & Rents", "Market Conditions", "Housing Supply", "Housing Context", "Metro Comparisons"]) {
      await page.getByRole("tab", { name: section, exact: true }).click();
      await chartIsVisible();
      if (section === "Housing Supply") {
        await page.getByLabel("Supply data lens").selectOption("delivery");
        await chartIsVisible();
        await page.getByLabel("Housing delivery figure").selectOption("type");
        await chartIsVisible();
        await page.getByLabel("Housing delivery figure").selectOption("trend");
        await chartIsVisible();
        await page.getByLabel("Supply data lens").selectOption("activity");
        await chartIsVisible();
      }
      if (section === "Prices & Rents") {
        await page.getByLabel("Prices and rents data lens").selectOption("inflation");
        await chartIsVisible();
        await page.getByLabel("Prices and rents data lens").selectOption("housing");
        await chartIsVisible();
      }
    }
  }
  expect(problems).toEqual([]);
});
