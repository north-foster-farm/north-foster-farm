// Shared setup for the tests of a customers merge run again after a
// crash (#793): test/merge-perk-rerun.test.mjs, the criteria, and
// test/merge-perk-rerun-removed.test.mjs; test/merge-edges.test.mjs
// takes `pair` too. No outside service is configured, so Square and
// Resend are not reached.

import { mergeCustomer } from "../netlify/functions/lib/admin.mjs";
import {
  customerKey, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

export const now = new Date("2026-11-21T15:00:00Z");
export const later = new Date("2026-11-23T15:00:00Z");
export const FROM = "pat+old@example.com";
export const INTO = "pat@example.com";
export const BY = "tester";

const failing = async () => {
  throw new Error("no network in this test");
};

// One applied merge of FROM into INTO, two days after the perks start.
export const run = (stores) => mergeCustomer(stores, FROM, INTO, {
  env: {}, by: BY, now: later, apply: true, fetchImpl: failing,
});

// Every console line, joined; the console itself stays quiet.
export const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

// Fresh stores holding both customer records and nothing else.
export const pair = async () => {
  const stores = testStores();

  await saveCustomer(stores, { email: FROM, name: "Old" });
  await saveCustomer(stores, { email: INTO, name: "Kept" });

  return stores;
};

// The next write to the source's customer record throws, once: the
// run stops after the target is saved and before the source's perks
// are cleared.
export const crashOnSource = (stores) => {
  const key = customerKey(FROM);
  let armed = true;

  for (const method of ["set", "swap", "create"]) {
    const write = stores.customers[method].bind(stores.customers);

    stores.customers[method] = async (k, ...rest) => {
      if (armed && k === key) {
        armed = false;
        throw new Error("blobs down");
      }

      return write(k, ...rest);
    };
  }
};
