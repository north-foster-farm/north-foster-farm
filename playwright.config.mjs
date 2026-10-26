// Browser tests against a deployed, non-production site: the staging
// branch deploy by default, or E2E_BASE_URL. docs/qa-launch.md is the
// plan these automate.

import { defineConfig, devices } from "@playwright/test";

import { stagingEnv } from "./e2e/support/staging.mjs";
import { MACHINE_COOKIE } from "./netlify/functions/lib/gate.mjs";

const baseURL = process.env.E2E_BASE_URL
  || "https://staging--north-foster-farm.netlify.app";
const host = new URL(baseURL).hostname;

// Production is www.northfosterfarm.com and the bare Netlify name.
// Only a branch or preview deploy (a "--" in the name) or a local
// server may be tested: these specs pay, sign up and send mail.
if (!(host.includes("--") || host === "localhost" || host === "127.0.0.1")) {
  throw new Error(`Refusing to run against ${host}: not a staging deploy.`);
}

// A non-production deploy is behind the access gate (docs/staging.md).
// The suite passes it with E2E_STAGING_TOKEN, as a cookie for the
// deploy's own host: a header would reach every site the page calls,
// the payment SDKs among them. Pages and the request fixture share it.
const token = stagingEnv("E2E_STAGING_TOKEN");
const gate = token && host.includes("--") ? {
  cookies: [{
    name: MACHINE_COOKIE, value: token, domain: host, path: "/",
    httpOnly: true, secure: true, sameSite: "Lax", expires: -1,
  }],
  origins: [],
} : undefined;

// What only the wide layout needs, or what must not run twice against
// the sandbox: the phone project skips these.
const desktopOnly = [
  "**/pricing.spec.mjs",
  "**/payment.spec.mjs",
  "**/recovery.spec.mjs",
  "**/orders-api.spec.mjs",
  "**/pickup-horizon.spec.mjs",
  "**/rate-limit.spec.mjs",
  "**/maintenance.spec.mjs",
  "**/account.spec.mjs",
  "**/email-change.spec.mjs",
  "**/news.spec.mjs",
  "**/staging-toolbar.spec.mjs",
  "**/gate.spec.mjs",
  "**/wording.spec.mjs",
  "**/favicon.spec.mjs",
  "**/contact-send.spec.mjs",
  "**/policies.spec.mjs",
  "**/skip-link.spec.mjs",
  // They set their own widths.
  "**/overflow.spec.mjs",
  "**/keyboard.spec.mjs",
  "**/order-layout.spec.mjs",
  "**/cart-lines.spec.mjs",
  "**/cart-money.spec.mjs",
  "**/cart-way.spec.mjs",
  "**/cart-fold.spec.mjs",
  "**/cart-float.spec.mjs",
  "**/cart-keyboard.spec.mjs",
];

// What only a deployed non-production site can show: the access gate
// is an edge function a local server never runs. CI's e2e checks run
// against a local build (bin/e2e/serve.mjs) and leave these to the
// separate run against staging, behind E2E_STAGING_TOKEN.
const local = host === "localhost" || host === "127.0.0.1";
const stagingOnly = local ? ["**/gate.spec.mjs"] : [];

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
    storageState: gate,
    screenshot: { mode: "only-on-failure", fullPage: true },
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "desktop",
      testIgnore: stagingOnly,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1500, height: 900 },
      },
    },
    {
      name: "phone",
      testIgnore: [...desktopOnly, ...stagingOnly],
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 664 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    // Safari on an iPhone, which is how James tests: only the checks
    // of layout and accessibility, where a WebKit-only fault shows.
    {
      name: "iphone",
      testMatch: [
        "**/overflow.spec.mjs", "**/a11y.spec.mjs", "**/keyboard.spec.mjs",
        "**/payment-stacking.spec.mjs", "**/cart-keyboard.spec.mjs",
        "**/cart-a11y.spec.mjs",
      ],
      use: { ...devices["iPhone 15"] },
    },
  ],
});
