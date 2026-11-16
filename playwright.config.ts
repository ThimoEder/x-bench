// Browser tests: `npm run test:browser` drives the page of a host that ui/testing/browserHost.ts starts.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "ui",
  testMatch: "**/*.browser.ts",
  outputDir: "node_modules/.cache/x-bench-browser-tests/results",
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
});
