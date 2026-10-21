#!/usr/bin/env node
// `npm run e2e:serve -- [--port 8895]`: the site as CI's e2e checks
// test it (#283). A Hugo build, as staging builds it (drafts, expired
// and future posts), served with the functions behind it and fake
// payments: no call leaves the machine, nothing depends on staging or
// on a vendor account.
//
// The server is this file, not `netlify dev`: the Netlify CLI brings
// over a thousand packages, most without provenance, into a run that
// needs none of them (security's review of #283). It does what the
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
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadEnv } from "../../netlify/functions/lib/env.mjs";
import { devSchedule } from "../dev-schedule.mjs";
import {
  findRedirect, headersFor, matchPath, parseToml,
} from "./netlify-toml.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const at = args.indexOf("--port");
const port = Number(at === -1 ? 8895 : args[at + 1]);
const site = join(root, "test-results", "e2e-site");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

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

const functionFor = (path, method) => functions.find((fn) =>
  fn.paths.some((p) => matchPath(p, path) !== null)
  && (!fn.methods || fn.methods.includes(method)));

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];

  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};

const callFunction = async (fn, req, res, url) => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of [value].flat()) headers.append(name, v);
  }

  const body = ["GET", "HEAD"].includes(req.method)
    ? undefined : await readBody(req);
  const request = new Request(url, { method: req.method, headers, body });
  const context = {
    ip: String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
    waitUntil: (promise) => Promise.resolve(promise).catch(() => {}),
  };
  const answer = await fn.handler(request, context);
  const out = { ...headersFor(headerRules, url.pathname) };

  answer.headers.forEach((value, name) => {
    if (name !== "set-cookie") out[name] = value;
  });

  const cookies = answer.headers.getSetCookie();

  if (cookies.length) out["set-cookie"] = cookies;
  const payload = req.method === "HEAD"
    ? undefined : Buffer.from(await answer.arrayBuffer());

  send(res, answer.status, out, payload);
};

// -> the file a path names in the build, or what to do about it.
const lookup = (path) => {
  const file = normalize(join(site, decodeURIComponent(path)));

  if (!file.startsWith(site)) return null;
  if (path.endsWith("/")) {
    const index = join(file, "index.html");

    return existsSync(index) ? { file: index } : null;
  }
  if (existsSync(file) && statSync(file).isFile()) return { file };
  if (existsSync(join(file, "index.html"))) return { slash: `${path}/` };

  return null;
};

const serveFile = (res, req, path, file, status = 200) => {
  const headers = {
    ...headersFor(headerRules, path),
    "content-type": TYPES[extname(file)] || "application/octet-stream",
  };
  const body = readFileSync(file);

  headers["content-length"] = body.length;
  send(res, status, headers, req.method === "HEAD" ? undefined : body);
};

const redirect = (res, to, status, search) => send(res, status, {
  location: to.startsWith("http") ? to : `${to}${search}`,
}, "");

// Netlify's order: a function on its path; a forced redirect; a file;
// any other redirect; 404. A 200 redirect is a rewrite: the target is
// served under the asked-for path, once.
const handle = async (req, res, url, rewritten = false) => {
  const path = url.pathname;
  const fn = functionFor(path, req.method);

  if (fn) return callFunction(fn, req, res, url);

  const forced = findRedirect(redirects, path, { forced: true });
  const found = lookup(path);
  const rule = forced
    || (found ? null : findRedirect(redirects, path, { forced: false }));

  if (rule && rule.status === 200 && !rewritten) {
    return handle(req, res, new URL(rule.to, url), true);
  }
  if (rule && rule.status !== 200) {
    return redirect(res, rule.to, rule.status, url.search);
  }
  if (found && found.file) return serveFile(res, req, path, found.file);
  if (found && found.slash) {
    return redirect(res, found.slash, 301, url.search);
  }

  const missing = join(site, "404.html");

  if (existsSync(missing)) return serveFile(res, req, path, missing, 404);

  return send(res, 404, { "content-type": "text/plain" }, "Not found\n");
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  handle(req, res, url).catch((error) => {
    console.error(`e2e:serve: ${req.method} ${url.pathname}:`, error);
    if (!res.headersSent) send(res, 500, {}, "Server error\n");
    else res.end();
  });
});

server.listen(port, () => {
  console.log(`e2e:serve: http://localhost:${port}, ${functions.length} ` +
    "functions");
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
