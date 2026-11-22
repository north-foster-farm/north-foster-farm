// Criteria tests for #793 (A crashed customers merge can copy ended
// perk history twice), one per box of its "Done when", written before
// the code. Held out of `npm test` (*.criteria.mjs) until the
// implementer renames it to merge-perk-rerun.test.mjs.
//
// The crash: `mergeCustomer` (lib/admin.mjs) saves the target with the
// source's perks, then clears the source's. Blobs has no transactions,
// so a run can stop between the two writes. Here the first write to
// the source's customer record after the merge starts throws once, as
// a store that fails there would, and the merge is run again.
//
// The seam these tests assume, as test/merge.test.mjs and
// test/merge-edges.test.mjs use it: `mergeCustomer(stores, from, into,
// { apply, by, env, fetchImpl, now })`, with no outside service
// configured, and one "customer.merged" line per merge applied, `by`
// and both addresses masked, whose `perks` counts the perks that run
// moved onto the target, as its `credit` counts the grants that run
// moved (a rerun may move fewer).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { perksOf } from "../assets/scripts/order/lib/perks.mjs";
import { mergeCustomer } from "../netlify/functions/lib/admin.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import { addPerk, removePerk } from "../netlify/functions/lib/perks.mjs";
import {
  customerKey, getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-11-21T15:00:00Z");
const later = new Date("2026-11-23T15:00:00Z");
const FROM = "pat+old@example.com";
const INTO = "pat@example.com";
const BY = "tester";
const failing = async () => {
  throw new Error("no network in this test");
};
const run = (stores) => mergeCustomer(stores, FROM, INTO, {
  env: {}, by: BY, now: later, apply: true, fetchImpl: failing,
});

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

// The source holds an ended perk, a removed one and an open one; the
// target holds none.
const seeded = async () => {
  const stores = testStores();

  await saveCustomer(stores, { email: FROM, name: "Old" });
  await saveCustomer(stores, { email: INTO, name: "Kept" });
  await addPerk(stores, FROM, "free-delivery", { by: "cli", end:
    "2026-11-21", now });
  await addPerk(stores, FROM, "minimum-waived", { by: "cli", now });
  await removePerk(stores, FROM, "minimum-waived", { by: "cli", now });
  await addPerk(stores, FROM, "friends", { by: "cli", now });

  return stores;
};

// The next write to the source's customer record throws, once: the
// run stops after the target is saved and before the source's perks
// are cleared.
const crashOnSource = (stores) => {
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

// A crashed run, then the rerun. -> the target's perks before the
// rerun.
const crashThenRerun = async (stores, { beforeRerun = () => {} } = {}) => {
  crashOnSource(stores);
  await assert.rejects(run(stores), /blobs down/);

  const before = perksOf(await getCustomer(stores, INTO));

  beforeRerun();

  return { before, report: await run(stores) };
};

describe("customers merge, rerun after a crash between its two writes",
  () => {
    it("1. leaves each ended or removed perk on the target once",
      async (t) => {
        capture(t);
        const stores = await seeded();
        const source = perksOf(await getCustomer(stores, FROM));

        await crashThenRerun(stores);

        const kept = perksOf(await getCustomer(stores, INTO));
        const copies = (p) => kept.filter((k) => k.type === p.type
          && k.start === p.start && k.end === p.end
          && (k.removedAt || null) === (p.removedAt || null)).length;

        assert.equal(source.length, 3, "the source held three perks");
        for (const p of source) {
          assert.equal(copies(p), 1,
            `${p.type} (${p.removedAt ? "removed" : p.end ? "ended"
              : "open"}) is on the target once`);
        }
        assert.equal(kept.length, 3, "the target holds nothing else");
        assert.equal(await getCustomer(stores, FROM), null,
          "the rerun finishes the merge");
      });

    it("2. the rerun logs the change as the merge's other writes are",
      async (t) => {
        const lines = capture(t);
        const stores = await seeded();
        const { before, report } = await crashThenRerun(stores, {
          beforeRerun: () => {
            lines.length = 0;
          },
        });
        const added = perksOf(await getCustomer(stores, INTO)).length
          - before.length;
        const merged = lines.filter((l) => l.includes("customer.merged"))
          .map((l) => JSON.parse(l));

        assert.equal(merged.length, 1, "one customer.merged line");

        const [line] = merged;

        assert.equal(line.by, BY);
        assert.equal(line.record, maskEmail(FROM));
        assert.equal(line.target, maskEmail(INTO));
        assert.ok(line._time, "the line carries its time");
        assert.equal(line.perks, report.perks,
          "the line and the report agree");
        assert.equal(line.perks, added,
          "it counts the perks this run moved onto the target");
        assert.equal(line.perks, 0,
          "the first run moved them all, so the rerun moves none");
        assert.ok(!lines.some((l) => l.includes(FROM) || l.includes(INTO)),
          "no full address is logged");
      });
  });
