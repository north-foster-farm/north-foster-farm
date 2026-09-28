#!/usr/bin/env node
// Every fact the site repeats has one source, in data/, and every page,
// email and script reads it from there (Q21b, #233). This check derives
// the known values from those files and finds any literal copy of one
// elsewhere, so a fee, a day or an address can't change in one place
// and not another. test/facts.test.mjs runs it with the suite, which
// the Netlify build runs. `node bin/facts/check.mjs` prints what it
// finds.
//
// Comments may name a value to explain the code; only what a reader
// could see is checked. Dated news posts keep the facts of their day
// and are not checked.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dayName } from "../../assets/scripts/order/lib/zoned.mjs";
import { TTL as sessionCacheTtl } from "../../assets/scripts/session/cache.js";
import { span } from "../../netlify/functions/lib/launch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

// The files that show a customer something.
const SCOPE = [
  /^content\/(?!news\/).*\.md$/,
  /^layouts\/.*\.(html|md|txt|xml|json)$/,
  /^assets\/scripts\/.*\.m?js$/,
  /^netlify\/.*\.mjs$/,
  /^data\/emails\/.*\.json$/,
];

// Where a known value belongs, with the reason: a whole file, or only
// its lines that hold `text`.
const ALLOWED = [
  { file: "layouts/partials/weekday.html",
    why: "the weekday names themselves" },
  { file: "netlify/functions/lib/review.mjs",
    why: "a pattern that matches any weekday a farmer types" },
  { file: "netlify/functions/lib/library.mjs",
    why: "sample records for the email previews, not facts" },
  { file: "content/privacy.md", text: "deletes log lines",
    why: "Axiom's own retention, not ours" },
  { file: "netlify/functions/lib/templates.mjs", text: "Jobs runs",
    why: "the jobs schedule in netlify.toml, not a customer fact" },
  { file: "content/about.md", text: "giant chicken suit",
    why: "where a photo was taken" },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s) => new RegExp(`(?<![\\w$])${escape(s)}(?![\\w])`);
// A weekday, "Thursday" or "Thursdays".
const days = (s) => new RegExp(`(?<!\\w)${s}s?(?!\\w)`);

// What to look for, derived from the sources, each with where it
// belongs.
export const knownFacts = () => {
  const company = json("data/company.json");
  const terms = json("data/delivery.json");
  const { markets } = json("data/markets.json");
  const facts = [];
  const add = (fact, source, value, pattern = word(value)) =>
    facts.push({ fact, source, value: String(value), pattern });

  const c = "data/company.json";
  const [area, exchange, line] =
    company.phone.plain.replace(/^\+1/, "").match(/(\d{3})(\d{3})(\d{4})/)
      .slice(1);
  add("phone", c, company.phone.display,
    new RegExp(`\\(?${area}\\)?[-. ]?${exchange}[-. ]${line}`));
  add("phone", c, company.phone.plain);
  add("email", c, company.email);
  const domain = company.email.split("@")[1];
  add("email", c, `@${domain}`, new RegExp(`\\w@${escape(domain)}`));
  add("farm address", c, company.address.street);
  add("farm address", c, company.address.short);
  add("Venmo", c, `venmo.com/u/${company.venmo}`);

  const d = "data/delivery.json";
  const { money } = terms;
  const dollars = new Set([
    money.deliveryMinimum, money.deliveryFee, money.outsideAreaFee,
    money.feeWaivedAt,
    ...money.bulkTiers.flatMap((t) => [t.threshold, t.off]),
  ]);
  for (const n of dollars) add("money", d, `$${n}`);
  for (const g of Object.values(money.discountGroups)) {
    add("discount", d, `${g.percent}% off`);
  }
  for (const key of ["delivery", "scituate"]) {
    const t = terms[key];
    add(`${key} day`, d, dayName(t.weekday), days(dayName(t.weekday)));
    add(`${key} cutoff`, d, dayName(t.cutoffWeekday),
      days(dayName(t.cutoffWeekday)));
    add(`${key} window`, d, t.window);
    add(`${key} window`, d, t.window.replace(" – ", " to "));
  }
  const hold = terms.delivery.holdDays;
  add("hold", d, `${hold} days`);
  add("hold", d, `${hold}-day`);
  const [site, street] = terms.scituate.location.split(", ");
  add("drop site", d, site);
  add("drop site", d, street);
  add("drop site", d, terms.scituate.short);
  const start = new Date(`${terms.scituate.start}T12:00:00Z`);
  add("drop site start", d, terms.scituate.start);
  add("drop site start", d, start.toLocaleDateString("en-US",
    { month: "long", day: "numeric", timeZone: "UTC" }));

  const a = "data/accounts.json";
  const accounts = json(a);
  add("sign-in link", a, `${accounts.signInLinkMinutes} minutes`);
  add("order link", a, `${accounts.orderLinkDays} days`);
  add("session", a, `${accounts.sessionDays} days`);
  add("session cache", a, `${accounts.sessionCacheMinutes} minutes`);
  add("news invite", a, `${accounts.newsInviteDays} days`);
  add("news invite", a, `within ${span(accounts.newsInviteDays)}`);

  const m = "data/markets.json";
  for (const market of markets) {
    add("market", m, market.name);
    add("market hours", m, market.when);
    add("market place", m, market.where.split(", ").slice(0, 2).join(", "));
  }

  return facts;
};

// Comments out, strings and markup kept, line numbers kept.
const blank = (s) => s.replace(/[^\n]/g, " ");
const visible = (file, text) => {
  let s = text
    .replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
  if (/\.m?js$/.test(file)) {
    s = s.replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|\s)\/\/.*$/gm, (all, lead) => lead + blank(all.slice(1)));
  }

  return s;
};

const trackedFiles = () => execFileSync("git", ["ls-files"],
  { cwd: ROOT, encoding: "utf8" }).split("\n")
  .filter((f) => SCOPE.some((r) => r.test(f)))
  .filter((f) => !ALLOWED.some((a) => a.file === f && !a.text));

const allowed = (file, text) =>
  ALLOWED.some((a) => a.file === file && a.text && text.includes(a.text));

// The known values in one file's text.
// -> [{ file, line, fact, source, value, text }]
export const scan = (file, source, facts = knownFacts()) => {
  const found = [];
  visible(file, source).split("\n").forEach((text, i) => {
    if (allowed(file, text)) return;
    for (const f of facts) {
      if (f.pattern.test(text)) {
        found.push({ file, line: i + 1, fact: f.fact, source: f.source,
          value: f.value, text: text.trim() });
      }
    }
  });

  return found;
};

export const findCopies = (files = trackedFiles()) => {
  const facts = knownFacts();

  return files.flatMap((file) =>
    scan(file, readFileSync(join(ROOT, file), "utf8"), facts));
};

// Two copies can't read data/, so they are held to it: the Netlify
// config and the browser bundle.
export const configDrift = () => {
  const company = json("data/company.json");
  const accounts = json("data/accounts.json");
  const toml = readFileSync(join(ROOT, "netlify.toml"), "utf8");
  const drift = [];
  if (!toml.includes(`venmo.com/u/${company.venmo}"`)) {
    drift.push("netlify.toml: the /venmo redirect isn't company.venmo");
  }
  if (sessionCacheTtl !== accounts.sessionCacheMinutes * 60_000) {
    drift.push("assets/scripts/session/cache.js: TTL isn't " +
      "accounts.sessionCacheMinutes");
  }

  return drift;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findCopies();
  for (const f of found) {
    console.log(`${f.file}:${f.line}: ${f.fact} "${f.value}" (${f.source})` +
      `\n    ${f.text.slice(0, 120)}`);
  }
  for (const d of configDrift()) console.log(d);
  process.exitCode = found.length || configDrift().length ? 1 : 0;
}
