#!/usr/bin/env node
// Sweeps the end-to-end suite's leftovers off staging: orders the
// suite placed (its own qa-e2e-… addresses, never anyone else's) that
// a failed run left paid or unpaid more than an hour ago. Each is
// cancelled with its refund, or without one when the refund is refused
// (said so in the summary), then deleted with its customer record and
// its mail in the outbox. It runs at the start of e2e-staging.yml and
// on demand, with E2E_STAGING_TOKEN, through the deploy's own back
// office (POST /api/staging/e2e), so it holds no other credential and
// cannot reach production.
//
//   E2E_STAGING_TOKEN=… node bin/e2e/sweep.mjs [--dry-run] [--hours 1]
//
// The summary goes to stdout and, in Actions, to the step summary.
// Order ids and qa-e2e addresses only: nothing a customer wrote.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  BACK_OFFICE_MISSING, BASE_URL, backOffice, op,
} from "../../e2e/support/staging.mjs";

// The suite's own addresses (e2e/support/order.mjs uniqueEmail, and
// the canned customer): nothing else is ever touched.
export const SUITE_EMAIL = /^qa-e2e-[a-z0-9-]+@example\.com$/i;

export const isSuiteEmail = (email) => SUITE_EMAIL.test(String(email || ""));

// An order still open: paid and waiting, or submitted and never paid.
export const OPEN = ["submitted", "paid"];

export const HOUR = 60 * 60_000;

// The orders a sweep takes: the suite's, still open, placed more than
// `maxAge` ago. An order with no time is left alone, as is one with
// an address the suite would not have used.
export const stale = (orders, { now = new Date(), maxAge = HOUR } = {}) =>
  orders.filter((o) => isSuiteEmail(o.email)
    && OPEN.includes(o.status)
    && o.submittedAt
    && now.getTime() - Date.parse(o.submittedAt) > maxAge);

// A record already gone counts as done: a run whose order cleanup
// failed has often deleted the customer already, and two stale orders
// at one address share one. The deploy answers 404 for it, and `op`
// throws `e2e <op>: 404 {"error":"No such customer."}` (security
// re-review).
export const gone = (error) =>
  /: 404 |no such|not found/i.test(String(error && error.message));

// Cancels one order, refund first, then without when the refund is
// refused, then deletes it, its customer record and its mail (to the
// address, and about the order by its id), each as its own step with
// its own note, so one step that fails never hides the others
// (security review). -> { id, removed, notes }; `removed` is true only
// when every step went through.
export const sweepOne = async (order, { dryRun = false, ops = op } = {}) => {
  const notes = [];

  if (dryRun) return { id: order.id, removed: false, notes: ["would sweep"] };

  try {
    await ops("orderCancel", { id: order.id, reasonText: "e2e sweep" });
    notes.push("cancelled with refund");
  } catch (error) {
    try {
      await ops("orderCancel", {
        id: order.id, reasonText: "e2e sweep", refund: false,
      });
      notes.push(`refund refused (${error.message}); cancelled without`);
    } catch (again) {
      notes.push(`cancel failed (${again.message}); left in place`);

      return { id: order.id, removed: false, notes };
    }
  }

  let removed = true;
  const step = async (what, name, args) => {
    try {
      await ops(name, args);
      notes.push(what);
    } catch (error) {
      if (gone(error)) {
        notes.push(`${what} (already gone)`);
      } else {
        removed = false;
        notes.push(`${what} failed (${error.message})`);
      }
    }
  };

  await step("order deleted", "orderDelete", { id: order.id });
  await step("customer deleted", "customerDelete", { email: order.email });
  await step("mail to the address cleared", "outboxClear", {
    to: order.email,
  });
  await step("mail about the order cleared", "outboxClear", {
    subject: order.id,
  });

  return { id: order.id, removed, notes };
};

export const summarize = (results, { dryRun = false, checked = 0 } = {}) => {
  const lines = [
    `## e2e sweep${dryRun ? " (dry run)" : ""}`,
    "",
    `${checked} open orders read, ${results.length} of the suite's ` +
      `older than an hour, ${results.filter((r) => r.removed).length} ` +
      "removed.",
  ];

  for (const r of results) lines.push(`- ${r.id}: ${r.notes.join("; ")}`);

  return `${lines.join("\n")}\n`;
};

// The sweep runs against one of this site's branch deploys only,
// which Netlify names <branch>--north-foster-farm.netlify.app: the
// token goes to no other host (security re-review).
export const stagingHost = (base) =>
  /^[a-z0-9-]+--north-foster-farm\.netlify\.app$/.test(new URL(base).hostname);

// -> { results, clean }: `clean` is false when any of the suite's
// stale orders was not wholly removed. The summary is always written.
export const main = async (argv = process.argv.slice(2), {
  ops = op, now = new Date(), out = process.stdout, base = BASE_URL,
  ready = backOffice().ready,
} = {}) => {
  const dryRun = argv.includes("--dry-run");
  const at = argv.indexOf("--hours");
  const maxAge = (at === -1 ? 1 : Number(argv[at + 1])) * HOUR;

  if (!ready) throw new Error(BACK_OFFICE_MISSING);
  if (!stagingHost(base)) {
    throw new Error(`${base} is not a staging deploy; nothing swept.`);
  }

  const { orders } = await ops("ordersList", {});
  const open = orders.filter((o) => OPEN.includes(o.status));
  const results = [];

  // One order's trouble never stops the next: each is caught here.
  for (const order of stale(open, { now, maxAge })) {
    try {
      results.push(await sweepOne(order, { dryRun, ops }));
    } catch (error) {
      results.push({
        id: order.id, removed: false,
        notes: [`failed (${error.message}); left in place`],
      });
    }
  }

  const text = summarize(results, { dryRun, checked: open.length });

  out.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }

  return {
    results, clean: dryRun || results.every((r) => r.removed),
  };
};

if (process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(({ clean }) => {
    if (!clean) {
      console.error("e2e sweep: not every order was removed; see above.");
      process.exit(1);
    }
  }).catch((error) => {
    console.error(`e2e sweep: ${error.message}`);
    process.exit(1);
  });
}
