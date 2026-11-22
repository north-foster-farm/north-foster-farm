// `bin/nff customers rekey` (#758): records stored under a key that
// names another address than their own, as the functions' raw "+" in
// a Blobs path left them, move to the key their address names. A dry
// run by default; each move logged with its keys masked.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rekeyRecords } from "../netlify/functions/lib/rekey.mjs";
import { maskKey, testStores } from "../netlify/functions/lib/store.mjs";

const PLUS = "pat+dog@example.com";
const WRONG = "pat dog@example.com";
const ID = "ord-1";

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

// A plus-address customer under the decoded key, with what that key's
// address also names, and a customer stored where it belongs.
const seeded = () => {
  const stores = testStores();
  const c = stores.customers.data;

  c.set(`customer/${WRONG}`, { email: PLUS, name: "Pat" });
  c.set(`cart/${WRONG}`, { lines: [] });
  c.set(`credit/${WRONG}`, { cents: 500 });
  c.set(`support/${WRONG}/m1`, { body: "hi" });
  c.set("customer/sam@example.com", { email: "sam@example.com" });
  stores.orders.data.set(`order/${ID}`, { id: ID, customer: { email: PLUS } });
  stores.orders.data.set(`by-email/${WRONG}/${ID}`, { id: ID });

  return stores;
};

const EXPECTED = [
  ["customers", `customer/${WRONG}`, `customer/${PLUS}`],
  ["customers", `cart/${WRONG}`, `cart/${PLUS}`],
  ["customers", `credit/${WRONG}`, `credit/${PLUS}`],
  ["customers", `support/${WRONG}/m1`, `support/${PLUS}/m1`],
  ["orders", `by-email/${WRONG}/${ID}`, `by-email/${PLUS}/${ID}`],
].map(([store, from, to]) => ({
  store, from: maskKey(from), to: maskKey(to),
}));

describe("customers rekey", () => {
  it("reports the moves on a dry run and changes nothing", async (t) => {
    const lines = capture(t);
    const stores = seeded();
    const before = [...stores.customers.data.keys()].sort();
    const report = await rekeyRecords(stores);

    assert.equal(report.apply, false);
    assert.deepEqual(report.moved, EXPECTED);
    assert.deepEqual(report.refused, []);
    assert.deepEqual([...stores.customers.data.keys()].sort(), before);
    assert.ok(!lines.some((l) => l.includes("store.rekeyed")),
      "a dry run logs no move");
  });

  it("moves each record with --apply and logs each move, masked",
    async (t) => {
      const lines = capture(t);
      const stores = seeded();
      const report = await rekeyRecords(stores, { apply: true, by: "james" });

      assert.deepEqual(report.moved, EXPECTED);
      assert.deepEqual(await stores.customers.get(`customer/${PLUS}`),
        { email: PLUS, name: "Pat" });
      assert.deepEqual(await stores.customers.get(`credit/${PLUS}`),
        { cents: 500 });
      assert.equal(await stores.customers.get(`customer/${WRONG}`), null);
      assert.equal(await stores.customers.get(`support/${WRONG}/m1`), null);
      assert.deepEqual(await stores.orders.get(`by-email/${PLUS}/${ID}`),
        { id: ID });
      assert.ok(await stores.customers.get("customer/sam@example.com"));

      const logged = lines.filter((l) => l.includes("store.rekeyed"))
        .map((l) => JSON.parse(l));

      assert.equal(logged.length, EXPECTED.length, "one line per move");
      for (const [i, line] of logged.entries()) {
        assert.equal(line.by, "james");
        assert.equal(line.store, EXPECTED[i].store);
        assert.equal(line.before, EXPECTED[i].from);
        assert.equal(line.after, EXPECTED[i].to);
        assert.ok(line._time, "the line carries its time");
      }
      assert.ok(!lines.some((l) => l.includes(PLUS) || l.includes(WRONG)),
        "no full address is logged");

      // Run again: nothing is left to move.
      const again = await rekeyRecords(stores, { apply: true });

      assert.deepEqual(again.moved, []);
    });

  it("refuses a move onto a key that holds a record", async (t) => {
    capture(t);
    const stores = seeded();

    stores.customers.data.set(`customer/${PLUS}`, { email: PLUS });

    const report = await rekeyRecords(stores, { apply: true });

    assert.deepEqual(report.refused.map((r) => r.from),
      [maskKey(`customer/${WRONG}`)]);
    assert.deepEqual(await stores.customers.get(`customer/${WRONG}`),
      { email: PLUS, name: "Pat" }, "the misplaced record is kept");
  });
});
