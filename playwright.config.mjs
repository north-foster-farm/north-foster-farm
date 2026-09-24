// Browser tests against a deployed, non-production site: the staging
// branch deploy by default, or E2E_BASE_URL. docs/qa-launch.md is the
// plan these automate.

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL
  || "https://staging--north-foster-farm.netlify.app";
const host = new URL(baseURL).hostname;

// Production is www.northfosterfarm.com and the bare Netlify name.
// Only a branch or preview deploy (a "--" in the name) or a local
// server may be tested: these specs pay, sign up and send mail.
if (!(host.includes("--") || host === "localhost" || host === "127.0.0.1")) {
  throw new Error(`Refusing to run against ${host}: not a staging deploy.`);
}

// What only the wide layout needs, or what must not run twice against
// the sandbox: the phone project skips these.
const desktopOnly = [
  "**/cart-layout.spec.mjs",
  "**/pricing.spec.mjs",
  "**/payment.spec.mjs",
  "**/recovery.spec.mjs",
  "**/orders-api.spec.mjs",
  "**/account.spec.mjs",
  "**/news.spec.mjs",
  "**/staging-toolbar.spec.mjs",
];

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.mjs",
  outputDir: "test-results/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : 3,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1500, height: 900 },
      },
    },
    {
      name: "phone",
      testIgnore: desktopOnly,
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 664 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
