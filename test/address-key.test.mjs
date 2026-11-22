// No stranded customers at #758's key switch: until `customers rekey`
// has moved every record, a read by address tries the hashed key, then
// the address itself, then the space form of its "+"s; a write always
// goes to the hashed key.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addressHash, addressSegments,
} from "../netlify/functions/lib/address-key.mjs";
import {
  creditBalance, grantCredit,
} from "../netlify/functions/lib/credit.mjs";
import {
  deleteCustomer, getCartOf, getCustomer, ordersFor, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const PLUS = "pat+dog@example.com";
const SPACED = "pat dog@example.com";
const PLAIN = "sam@example.com";
const NOW = new Date("2026-11-21T14:00:00Z");

describe("address keys (#758)", () => {
  it("hashes the normalized address, URL-safe, the issue's example",
    () => {
      assert.equal(addressHash("  Pat+Dog@Example.com "),
        "AMHJL0NpSgypWjP7ZvFu2gI3Hkwk2WSW5957fBpZ6LA");
      assert.deepEqual(addressSegments(PLUS),
        [addressHash(PLUS), PLUS, SPACED]);
      assert.deepEqual(addressSegments(PLAIN), [addressHash(PLAIN), PLAIN]);
    });

  it("finds a customer under its raw address, then the space form",
    async () => {
      const stores = testStores();

      stores.customers.data.set(`customer/${PLAIN}`, { email: PLAIN });
      stores.customers.data.set(`customer/${SPACED}`, { email: PLUS });

      assert.deepEqual(await getCustomer(stores, PLAIN), { email: PLAIN });
      assert.deepEqual(await getCustomer(stores, PLUS), { email: PLUS });
    });

  it("reads the hashed key first", async () => {
    const stores = testStores();

    stores.customers.data.set(`customer/${PLAIN}`, { email: PLAIN, n: 1 });
    stores.customers.data.set(`customer/${addressHash(PLAIN)}`,
      { email: PLAIN, n: 2 });

    assert.equal((await getCustomer(stores, PLAIN)).n, 2);
  });

  it("writes an old record back under its hashed key", async () => {
    const stores = testStores();

    stores.customers.data.set(`customer/${SPACED}`,
      { email: PLUS, consent: [] });
    await saveCustomer(stores, {
      ...(await getCustomer(stores, PLUS)), name: "Pat",
    });

    const hashed = stores.customers.data.get(`customer/${addressHash(PLUS)}`);

    assert.equal(hashed.name, "Pat");
    assert.equal((await getCustomer(stores, PLUS)).name, "Pat");
  });

  it("finds carts, credit and orders under old keys", async () => {
    const stores = testStores();

    stores.customers.data.set(`cart/${SPACED}`, { lines: ["egg"] });
    stores.customers.data.set(`credit/${PLAIN}`, {
      email: PLAIN,
      entries: [{ amount: 500, expiresAt: "2026-12-31T23:59:00Z" }],
    });
    stores.orders.data.set("order/o1", { id: "o1", submittedAt: "a" });
    stores.orders.data.set("order/o2", { id: "o2", submittedAt: "b" });
    stores.orders.data.set(`by-email/${SPACED}/o1`, { id: "o1" });
    stores.orders.data.set(`by-email/${addressHash(PLUS)}/o2`, { id: "o2" });

    assert.deepEqual(await getCartOf(stores, PLUS), { lines: ["egg"] });
    assert.equal(await creditBalance(stores, PLAIN, NOW), 500);
    assert.deepEqual((await ordersFor(stores, PLUS)).map((o) => o.id),
      ["o2", "o1"]);
  });

  it("changes an old ledger at its hashed key, keeping what it held",
    async () => {
      const stores = testStores();

      stores.customers.data.set(`credit/${PLAIN}`, {
        email: PLAIN,
        entries: [{
          id: "g0", amount: 500, at: "2026-11-01T00:00:00Z",
          expiresAt: "2026-12-31T23:59:00Z",
        }],
      });
      await grantCredit(stores, PLAIN, {
        amount: 300, from: { group: "g", round: "r1", kind: "host" },
        now: NOW, timeZone: "America/New_York",
      });

      assert.ok(stores.customers.data.get(`credit/${addressHash(PLAIN)}`));
      assert.equal(await creditBalance(stores, PLAIN, NOW), 800);
    });

  it("deletes a customer under every key", async () => {
    const stores = testStores();

    stores.customers.data.set(`customer/${SPACED}`, { email: PLUS });
    stores.customers.data.set(`cart/${PLUS}`, { lines: [] });
    await saveCustomer(stores, { email: PLUS, consent: [] });
    await deleteCustomer(stores, PLUS);

    assert.deepEqual([...stores.customers.data.keys()], []);
  });
});
