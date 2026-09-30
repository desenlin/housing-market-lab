import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173/housing-market-lab/",
    browserName: "chromium",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] }
      : undefined,
  },
  webServer: {
    command: "node tests/browser/serve.mjs",
    url: "http://127.0.0.1:4173/housing-market-lab/",
    reuseExistingServer: !process.env.CI,
  },
});
