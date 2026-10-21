#!/usr/bin/env node
// `npm run e2e:serve -- [--port 8895]`: the site as CI's e2e checks
// test it (#283). A Hugo build, as staging builds it (drafts, expired
// and future posts), served by `netlify dev --offline` with the
// functions behind it and fake payments: no call leaves the machine,
// nothing depends on staging or on a vendor account.
//
// The functions read .env.development.sample and nothing else of
// yours, so a run here is the run CI makes; the shell's own variables
// win. E2E_STAGING_TOKEN must be set, to the same value the suite is
// given: it opens the back office (/api/staging/e2e), which answers
// because SITE_CONTEXT is dev. Run the suite with E2E_BASE_URL set to
// http://localhost:<port>.
//
// The stub payment SDKs are published only by `hugo server`
// (layouts/partials/fake-sdks.html), so this copies them into the
// build; the functions refuse fake payments outside the dev context
// whatever the page loads.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../../netlify/functions/lib/env.mjs";
import { devSchedule } from "../dev-schedule.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const at = args.indexOf("--port");
const port = at === -1 ? "8895" : args[at + 1];
const site = join(root, "test-results", "e2e-site");

if (!process.env.E2E_STAGING_TOKEN) {
  console.error("e2e:serve: set E2E_STAGING_TOKEN, here and for the suite.");
  process.exit(2);
}

loadEnv(join(root, ".env.development.sample"));
// The outbox is where the specs read the mail the site would have sent
// (support/staging.mjs, waitForMail), as they do on staging.
Object.assign(process.env, {
  SITE_CONTEXT: "dev", SQUARE_ENV: "fake", PAYPAL_ENV: "fake",
  MAIL_DRIVER: "outbox", SITE_URL: `http://localhost:${port}`,
});
if (!process.env.PICKUP_SCHEDULE) process.env.PICKUP_SCHEDULE = devSchedule();

rmSync(site, { recursive: true, force: true });
const built = spawnSync("hugo", [
  "--gc", "--quiet", "--environment", "production",
  "--buildDrafts", "--buildExpired", "--buildFuture",
  "-b", `http://localhost:${port}/`, "-d", site,
], { cwd: root, stdio: "inherit" });

if (built.status !== 0) process.exit(built.status ?? 1);

mkdirSync(join(site, "scripts"), { recursive: true });
for (const name of ["square", "paypal"]) {
  copyFileSync(join(root, "assets/scripts/fake", `${name}.js`),
    join(site, "scripts", `fake-${name}.js`));
}

// The Netlify CLI on PATH: CI installs a pinned version (e2e.yml), not
// whatever npx would fetch. Run from bin/ with --cwd, as
// bin/dev-functions.mjs does, so a worktree nested in another checkout
// still reads its own netlify.toml.
const child = spawn("netlify", ["dev", "--cwd", root, "--offline",
  "--framework", "#static", "--dir", site, "--port", port, "--no-open"], {
  cwd: join(root, "bin"),
  detached: true,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});

const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
};

let stopping = false;

const stop = (code) => {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  const started = Date.now();
  const timer = setInterval(() => {
    if (!signalGroup(0)) {
      clearInterval(timer);
      process.exit(code);
    }
    if (Date.now() - started > 5000) signalGroup("SIGKILL");
  }, 100);
};

for (const [signal, code] of Object.entries({
  SIGHUP: 129, SIGINT: 130, SIGTERM: 143,
})) {
  process.on(signal, () => stop(code));
}

child.on("close", (code) => stop(code ?? 1));
