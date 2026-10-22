#!/usr/bin/env node
// `npm run e2e:serve -- [--port 8895]`: the site as CI's e2e checks
// test it (#283). A Hugo build, as staging builds it (drafts, expired
// and future posts), served with the functions behind it and fake
// payments: no call leaves the machine, nothing depends on staging or
// on a vendor account.
//
// The server is ours (server.mjs), not `netlify dev`: the Netlify CLI
// brings over a thousand packages, most without provenance, into a run
// that needs none of them (security's review of #283). It does what the
// suite needs of Netlify, from netlify.toml and the functions' own
// config: each function answers on its `config.path` and methods;
// forced redirects, then files, then the other redirects; the
// headers rules; /about to /about/; 404.html. The stores are the
// functions' own memory stores (lib/store.mjs), one set for the run.
//
// The functions read .env.development.sample and nothing else of
// yours; the shell's own variables win. E2E_STAGING_TOKEN must be set,
// to the same value the suite is given: it opens the back office
// (/api/staging/e2e), which answers because SITE_CONTEXT is dev. Run
// the suite with E2E_BASE_URL set to http://localhost:<port>.
//
// The stub payment SDKs are published only by `hugo server`
// (layouts/partials/fake-sdks.html), so this copies them into the
// build; the functions refuse fake payments outside the dev context
// whatever the page loads.

import { spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadEnv } from "../../netlify/functions/lib/env.mjs";
import { devSchedule } from "../dev-schedule.mjs";
import { parseToml } from "./netlify-toml.mjs";
import { startServer } from "./server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const at = args.indexOf("--port");
const port = Number(at === -1 ? 8895 : args[at + 1]);
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

// The same pass over the HTML as the Netlify build (#303).
const kept = spawnSync("node", ["bin/orphans/wrap.mjs", site],
  { cwd: root, stdio: "inherit" });
if (kept.status !== 0) process.exit(kept.status ?? 1);

mkdirSync(join(site, "scripts"), { recursive: true });
for (const name of ["square", "paypal"]) {
  copyFileSync(join(root, "assets/scripts/fake", `${name}.js`),
    join(site, "scripts", `fake-${name}.js`));
}

const toml = parseToml(readFileSync(join(root, "netlify.toml"), "utf8"));
const redirects = toml.redirects || [];
const headerRules = toml.headers || [];

// Every function with a path, as { name, paths, methods, handler }.
const functionsDir = join(root, "netlify", "functions");
const functions = [];

const functionFiles = readdirSync(functionsDir)
  .filter((f) => f.endsWith(".mjs"));

for (const file of functionFiles) {
  const mod = await import(pathToFileURL(join(functionsDir, file)).href);
  const config = mod.config || {};

  if (!config.path || typeof mod.default !== "function") continue;
  functions.push({
    name: file,
    paths: [config.path].flat(),
    methods: config.method ? [config.method].flat() : null,
    handler: mod.default,
  });
}

const server = await startServer({
  site, port, functions, redirects, headerRules,
});

console.log(`e2e:serve: http://localhost:${port}, ${functions.length} ` +
  "functions");

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
