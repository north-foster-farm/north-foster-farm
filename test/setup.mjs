// Loaded before every test file (package.json: node --import). The
// suite runs on Netlify at build time with the production variables
// in the environment, and on 2026-09-22 that sent the fixtures' order
// notices through Resend on every deploy. Nothing under test may reach
// a real service, so the keys are stripped before a module can read
// them and the mail driver is pinned to the log.

for (const name of [
  "RESEND_API_KEY", "RESEND_READ_KEY", "MAIL_FROM", "MAIL_REPLY_TO",
  "ADMIN_EMAILS", "SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY", "NETLIFY_AUTH_TOKEN", "ACCOUNTS_ENABLED",
  "ADMIN_URL", "CONTACT_URL", "SITE_URL", "URL", "DEPLOY_PRIME_URL",
]) {
  delete process.env[name];
}

process.env.MAIL_DRIVER = "log";
process.env.SQUARE_ENV = "sandbox";
