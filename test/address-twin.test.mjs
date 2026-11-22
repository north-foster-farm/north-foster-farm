// No stale twin after the switch to hashed keys (#758, qa on #787): a
// write to a customer's, cart's or credit ledger's hashed key deletes
// the record its old key held, and a list returns one record per
// address, the hashed one when both are there.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { saveCart } from "../netlify/functions/lib/account.mjs";
import { listLatest } from "../netlify/functions/lib/address-key.mjs";
import {
  getLedger, grantCredit, sweepStrandedCredit,
} from "../netlify/functions/lib/credit.mjs";
import {
  allCustomers, getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { rekeyRecords } from "../netlify/functions/lib/rekey.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const PLUS = "pat+dog@example.com";
const SPACED = "pat dog@example.com";

const hashed = (email) => createHash("sha256").update(email)
  .digest("base64url");

const quiet = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

// A customer stored, before the switch, under the space the
// functions' route made of the "+".
const before = () => {
  const stores = testStores();

  stores.customers.data.set(`customer/${SPACED}`, {
    email: PLUS, name: "Pat", marketing: true,
    marketingAt: "2026-11-01T12:00:00.000Z", marketingSource: "signup",
  });

  return stores;
};

describe("no stale twin after a hashed write", () => {
  it("lists a customer once, with the saved value, after one save",
    async (t) => {
      quiet(t);
      const stores = before();
      const stored = await getCustomer(stores, PLUS);

      await saveCustomer(stores, { ...stored, name: "Pat Dog" });

      const all = await allCustomers(stores);

      assert.equal(all.length, 1);
      assert.equal(all[0].name, "Pat Dog");
      assert.equal(stores.customers.data.has(`customer/${SPACED}`), false);
    });

  it("shows every reader only the marketing change made after the switch",
    async (t) => {
      quiet(t);
      const stores = before();
      const stored = await getCustomer(stores, PLUS);

      await saveCustomer(stores, {
        ...stored, marketing: false,
        marketingAt: "2026-11-22T12:00:00.000Z",
        marketingSource: "unsubscribe",
      });

      assert.equal((await getCustomer(stores, PLUS)).marketing, false);
      assert.deepEqual((await allCustomers(stores)).map((c) => c.marketing),
        [false]);
    });

  it("lists the hashed record when an old twin is still there",
    async (t) => {
      const lines = quiet(t);
      const stores = before();

      stores.customers.data.set(`customer/${hashed(PLUS)}`, {
        email: PLUS, name: "Pat", marketing: false,
      });

      assert.deepEqual((await allCustomers(stores)).map((c) => c.marketing),
        [false]);
      assert.equal(stores.customers.data.has(`customer/${SPACED}`), false,
        "the old twin is cleaned");
      assert.ok(lines.some((l) => l.includes("store.leftover-deleted")));
      assert.ok(!lines.some((l) => l.includes(PLUS) || l.includes(SPACED)),
        "no full address is logged");
    });

  it("keeps one cart, at the hashed key, after a save", async (t) => {
    quiet(t);
    const stores = testStores();

    stores.customers.data.set(`cart/${SPACED}`, { payload: null, savedAt: 1 });

    const saved = await saveCart(stores, { email: PLUS }, {
      payload: null, savedAt: 2,
    }, { now: new Date(10) });

    assert.equal(saved.kept, true);
    assert.equal(stores.customers.data.has(`cart/${SPACED}`), false);
    assert.deepEqual(await stores.customers.get(`cart/${hashed(PLUS)}`),
      { payload: null, savedAt: 2 });
    assert.equal((await listLatest(stores.customers, "cart")).length, 1);
  });

  it("keeps one credit ledger, at the hashed key, after a grant",
    async (t) => {
      quiet(t);
      const stores = testStores();

      stores.customers.data.set(`credit/${SPACED}`, {
        email: PLUS, entries: [],
      });
      await grantCredit(stores, PLUS, {
        amount: 500, from: { group: "g", round: "r1", kind: "host" },
        now: new Date("2026-11-22T12:00:00Z"), timeZone: "America/New_York",
      });

      assert.equal(stores.customers.data.has(`credit/${SPACED}`), false);
      assert.equal((await getLedger(stores, PLUS)).entries.length, 1);
      assert.equal((await listLatest(stores.customers, "credit")).length, 1);
      assert.deepEqual(await sweepStrandedCredit(stores), []);
    });

  // A copy at the hashed key (member codes make one, lib/member-id.mjs)
  // and an older cart are leftovers: deleted, not refused.
  it("cleans a leftover in rekey rather than refusing it", async (t) => {
    const lines = quiet(t);
    const stores = before();
    const c = stores.customers.data;
    const copy = structuredClone(c.get(`customer/${SPACED}`));

    c.set(`customer/${hashed(PLUS)}`, copy);
    c.set(`cart/${SPACED}`, { payload: null, savedAt: 3 });
    c.set(`cart/${hashed(PLUS)}`, { payload: null, savedAt: 7 });

    const old = [`customer/${SPACED}`, `cart/${SPACED}`];
    const dry = await rekeyRecords(stores);

    assert.deepEqual(dry.cleaned.map((m) => m.from), old);
    assert.deepEqual(dry.refused, []);
    assert.ok(old.every((k) => c.has(k)), "a dry run deletes nothing");

    const report = await rekeyRecords(stores, { apply: true });

    assert.deepEqual(report.cleaned.map((m) => m.from), old);
    assert.ok(!old.some((k) => c.has(k)), "both leftovers are gone");
    assert.deepEqual(c.get(`customer/${hashed(PLUS)}`), copy);
    assert.deepEqual(c.get(`cart/${hashed(PLUS)}`),
      { payload: null, savedAt: 7 });
    assert.equal(lines.filter((l) => l.includes("store.leftover-deleted"))
      .length, 2, "one line per leftover");
  });

  it("refuses in rekey an old record newer than its hashed twin",
    async (t) => {
      quiet(t);
      const stores = testStores();

      stores.customers.data.set(`cart/${SPACED}`, { savedAt: 9 });
      stores.customers.data.set(`cart/${hashed(PLUS)}`, { savedAt: 5 });

      const report = await rekeyRecords(stores, { apply: true });

      assert.deepEqual(report.refused.map((m) => m.from), [`cart/${SPACED}`]);
      assert.deepEqual(report.cleaned, []);
      assert.equal(stores.customers.data.has(`cart/${SPACED}`), true);
    });
});
