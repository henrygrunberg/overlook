import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  // The design-review screenshots assert nothing, and CI keeps test-results/ only on failure.
  ...(process.env.CI ? { grepInvert: /@visual/ } : {}),
  use: {
    locale: "en-GB",
    timezoneId: "Europe/Tallinn",
    trace: "retain-on-failure",
  },
});
