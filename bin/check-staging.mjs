#!/usr/bin/env node
// Holds a built site to where the staging tools belong (#294): the
// toolbar, its clock and the order page's sandbox card overlay are in
// a staging build and in no file of a production build. CI's build job
// runs it after each of its two builds; test/staging-build.test.mjs
// builds both and runs it too.
//
//   node bin/check-staging.mjs <dir> production|staging

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What staging's pages carry and production's never may.
export const TRACES = [
  /data-staging-card-dialog/, /data-staging-clock/, /id="staging"/,
  /staging\.card-seen/, /\/api\/staging\/clock/, /4111 1111 1111 1111/,
  /Simulate an order in staging/, /data-staging-slips/,
  /\/api\/staging\/slips/,
];

// What the staging order page must carry.
export const ORDER_PAGE = [
  /data-staging-card-dialog/, /data-staging-clock/,
  /Simulate an order in staging/, /4111 1111 1111 1111/,
];

const texts = (dir) => readdirSync(dir, { recursive: true })
  .filter((f) => /\.(html|js|css|json|txt|xml)$/.test(f))
  .map((f) => [f, readFileSync(join(dir, f), "utf8")]);

// -> the problems found, none when the build is as it should be.
export const check = (dir, kind) => {
  if (kind === "production") {
    const found = [];

    for (const [file, text] of texts(dir)) {
      for (const trace of TRACES) {
        if (trace.test(text)) found.push(`${file} has ${trace}`);
      }
    }

    return found;
  }
  if (kind === "staging") {
    const order = readFileSync(join(dir, "order", "index.html"), "utf8");
    const found = ORDER_PAGE.filter((t) => !t.test(order))
      .map((t) => `order/index.html lacks ${t}`);
    // The toolbar's card and the overlay's are one component (#303):
    // the same markup but for their ids' prefixes.
    const cards = [...order.matchAll(/<dl class="?staging-card"?>[\s\S]*?<\/dl>/g)]
      .map((m) => m[0].replace(/\b(toolbar|overlay)-card-/g, "card-"));

    if (cards.length !== 2 || cards[0] !== cards[1]) {
      found.push("order/index.html lacks one card component in both " +
        `places (found ${cards.length}, ${
          cards[0] === cards[1] ? "alike" : "different"})`);
    }

    return found;
  }

  return [`Say production or staging, not ${kind}.`];
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, kind] = process.argv.slice(2);
  const found = check(dir, kind);

  for (const line of found) console.error(line);
  console.log(found.length
    ? `check:staging: ${found.length} problem(s) in the ${kind} build`
    : `check:staging: the ${kind} build is as it should be`);
  process.exitCode = found.length ? 1 : 0;
}
