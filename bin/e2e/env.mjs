// What the e2e build's functions run with over .env.development.sample
// (bin/e2e/serve.mjs), whatever the shell says. Fake payments, the
// outbox for mail, and stock read from the fakes and STOCK_OVERRIDES
// alone: development reads production's /api/stock (STOCK_SOURCE in the
// sample, #453), but a CI run never does, so its counts are the suite's
// own and no run depends on production or spends its rate limit.
export const e2eEnv = (port) => ({
  SITE_CONTEXT: "dev", SQUARE_ENV: "fake", PAYPAL_ENV: "fake",
  MAIL_DRIVER: "outbox", SITE_URL: `http://localhost:${port}`,
  STOCK_SOURCE: "",
});
