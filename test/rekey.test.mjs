// `bin/nff customers rekey` (#758): address-keyed records still under
// the address itself, or the space the functions' raw "+" in a Blobs
// path made of it, move to the hash of their address
// (lib/address-key.mjs). A dry run by default; each move logged with
// its keys masked.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { rekeyRecords } from "../netlify/functions/lib/rekey.mjs";
import { maskKey, testStores } from "../netlify/functions/lib/store.mjs";

const PLUS = "pat+dog@example.com";
const WRONG = "pat dog@example.com";
const SAM = "sam@example.com";
const ID = "ord-1";

const hashed = (email) => createHash("sha256").update(email)
  .digest("base64url");

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

// A plus-address customer under the space its "+" became, with what
// that key's address also names; a customer under its raw address; and
// one already under its hashed key.
const seeded = () => {
  const stores = testStores();
  const c = stores.customers.data;

  c.set(`customer/${WRONG}`, { email: PLUS, name: "Pat" });
  c.set(`cart/${WRONG}`, { lines: [] });
  c.set(`credit/${WRONG}`, { email: PLUS, entries: [] });
  c.set(`support/${WRONG}/m1`, { body: "hi" });
  c.set(`customer/${SAM}`, { email: SAM });
  c.set(`customer/${hashed("kim@example.com")}`, { email: "kim@example.com" });
  stores.orders.data.set(`order/${ID}`, { id: ID, customer: { email: PLUS } });
  stores.orders.data.set(`by-email/${WRONG}/${ID}`, { id: ID });

  return stores;
};

const EXPECTED = [
  ["customers", `customer/${WRONG}`, `customer/${hashed(PLUS)}`],
  ["customers", `customer/${SAM}`, `customer/${hashed(SAM)}`],
  ["customers", `cart/${WRONG}`, `cart/${hashed(PLUS)}`],
  ["customers", `credit/${WRONG}`, `credit/${hashed(PLUS)}`],
  ["customers", `support/${WRONG}/m1`, `support/${hashed(PLUS)}/m1`],
  ["orders", `by-email/${WRONG}/${ID}`, `by-email/${hashed(PLUS)}/${ID}`],
].map(([store, from, to]) => ({ store, from, to }));

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
      assert.deepEqual(
        await stores.customers.get(`customer/${hashed(PLUS)}`),
        { email: PLUS, name: "Pat" }
      );
      assert.equal(await stores.customers.get(`customer/${WRONG}`), null);
      assert.equal(await stores.customers.get(`support/${WRONG}/m1`), null);
      assert.deepEqual(
        await stores.orders.get(`by-email/${hashed(PLUS)}/${ID}`), { id: ID }
      );

      const logged = lines.filter((l) => l.includes("store.rekeyed"))
        .map((l) => JSON.parse(l));

      assert.equal(logged.length, EXPECTED.length, "one line per move");
      for (const [i, line] of logged.entries()) {
        assert.equal(line.by, "james");
        assert.equal(line.store, EXPECTED[i].store);
        assert.equal(line.before, maskKey(EXPECTED[i].from));
        assert.equal(line.after, maskKey(EXPECTED[i].to));
        assert.ok(line._time, "the line carries its time");
      }
      assert.ok(!lines.some((l) => [PLUS, WRONG, SAM].some((a) =>
        l.includes(a))), "no full address is logged");

      // Run again: nothing is left to move.
      const again = await rekeyRecords(stores, { apply: true });

      assert.deepEqual(again.moved, []);
    });

  // The client hands back the server's listed key verbatim (Store
  // formatListResultBlob, @netlify/blobs 11.1.0), and staging listed
  // the record stored as "james dog@..." as "james+dog@..." (the
  // coordinator's read-only check, 2026-11-21, #758). Each store here
  // lists that way: a stored space shows as a "+".
  it("finds a record the list names with a \"+\" for its stored space",
    async (t) => {
      const lines = capture(t);
      const stores = seeded();

      for (const name of ["customers", "orders"]) {
        const store = stores[name];
        const list = store.list;

        store.list = async (prefix) => (await list(prefix))
          .map(({ key }) => ({ key: key.replaceAll(" ", "+") }));
      }

      const report = await rekeyRecords(stores, { apply: true });

      assert.deepEqual(report.moved, EXPECTED);
      assert.equal(await stores.customers.get(`customer/${WRONG}`), null);
      assert.equal(await stores.orders.get(`by-email/${WRONG}/${ID}`), null);
      assert.equal(lines.filter((l) => l.includes("store.rekeyed")).length,
        EXPECTED.length, "one line per move");
    });

  it("refuses a move onto a key that holds a record", async (t) => {
    capture(t);
    const stores = seeded();

    stores.customers.data.set(`customer/${hashed(PLUS)}`, { email: PLUS });

    const report = await rekeyRecords(stores, { apply: true });

    assert.deepEqual(report.refused.map((r) => r.from),
      [`customer/${WRONG}`]);
    assert.deepEqual(await stores.customers.get(`customer/${WRONG}`),
      { email: PLUS, name: "Pat" }, "the old record is kept");
  });
});
