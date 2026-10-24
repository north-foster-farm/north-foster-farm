import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle } from "../netlify/functions/account.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  DELETED_HOUSEHOLD, deleteOldMessages, forgetCustomer, scrubOldOrders,
  scrubOrder,
} from "../netlify/functions/lib/forget.mjs";
import { SquareError } from "../netlify/functions/lib/square.mjs";
import { forgottenKey, syncAudience } from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, getOrder, ordersFor, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-16T13:00:00Z");
const PAT = "pat@example.com";

const order = (id, {
  email = PAT, status = "fulfilled", at = "2026-09-01T12:00:00Z",
} = {}) => ({
  id,
  status,
  submittedAt: at,
  customer: { firstName: "Pat", lastName: "Example", name: "Pat Example",
    email, phone: "4015550100", contact: "text" },
  lines: [{ sku: "EGG", label: "Eggs", qty: 2, unitPrice: 700,
    lineTotal: 1400 }],
  totals: { subtotal: 1400, discountAmount: 0, deliveryFee: 500,
    total: 1900 },
  fulfilment: { method: "delivery", date: "2026-09-03", onfarm: null,
    delivery: { address1: "1 Main St", address2: "Apt 2", town: "Foster",
      state: "RI", zip: "02825", cooler: "Porch", gate: "1234",
      notes: "Dog", zipStatus: "approved" } },
  notes: "Ring twice",
  returns: [{ id: "R1", reason: "Cracked, Pat", skus: ["EGG"],
    status: "refunded" }],
  payments: [{ via: "venmo", amount: 1900, paypalCaptureId: `CAP-${id}`,
    payer: { name: "Pat E", email }, receiptUrl: "https://r/x" }],
  history: [{ at, event: status }],
});

const customer = (email = PAT) => ({
  email, name: "Pat Example", firstName: "Pat", lastName: "Example",
  phone: "4015550100", address: { address1: "1 Main St" },
});

const news = () => {
  const calls = [];

  return {
    calls,
    removeContact: async (email, { apply = false } = {}) => {
      calls.push([email, apply]);

      return "removed";
    },
  };
};

describe("scrubOrder", () => {
  it("keeps a scheduled pickup's occurrence and its moves", () => {
    const o = order("S");

    o.fulfilment = { method: "scheduled", occurrence: "K4Q7-261101",
      date: "2026-11-01" };
    o.history = [{ at: "2026-09-01T12:00:00Z", event: "moved",
      from: "K4Q7-261025", to: "K4Q7-261101", by: "customer" }];

    const s = scrubOrder(o, now);

    assert.equal(s.fulfilment.occurrence, "K4Q7-261101");
    assert.deepEqual(s.history, o.history);
  });

  it("keeps the facts and loses the person", () => {
    const s = scrubOrder(order("A"), now);

    assert.deepEqual(s.customer, { ...DELETED_HOUSEHOLD });
    assert.deepEqual(s.fulfilment.delivery, {
      town: "Foster", state: "RI", zip: "02825", zipStatus: "approved",
    });
    assert.equal(s.notes, "");
    assert.equal(s.returns[0].reason, "");
    assert.deepEqual(s.returns[0].skus, ["EGG"]);
    assert.equal(s.payments[0].payer, undefined);
    assert.equal(s.payments[0].receiptUrl, undefined);
    assert.equal(s.payments[0].amount, 1900);
    assert.deepEqual(s.lines, order("A").lines);
    assert.deepEqual(s.totals, order("A").totals);
    assert.equal(s.submittedAt, order("A").submittedAt);
    assert.equal(s.scrubbedAt, now.toISOString());

    const text = JSON.stringify(s);

    for (const gone of ["Pat", PAT, "4015550100", "Main St", "1234"]) {
      assert.ok(!text.includes(gone), gone);
    }
  });
});

describe("forgetCustomer", () => {
  const seed = async () => {
    const stores = testStores();

    await saveCustomer(stores, customer());
    await saveCustomer(stores, customer("sam@example.com"));
    await saveOrder(stores, order("A"));
    await saveOrder(stores, order("B", { email: "sam@example.com" }));
    await stores.customers.set(`support/${PAT}/s1`, { message: "hi" });
    await stores.customers.set("messages/m1", { email: PAT, text: "hi" });
    await stores.customers.set("messages/m2", { email: "sam@example.com" });
    await stores.auth.set("unsub/t1", { email: PAT });
    await stores.auth.set(`rate/${PAT}`, { times: [1] });
    await stores.auth.set(`change-rate/${PAT}`, { times: [1] });
    await createSession(stores, PAT, { now });

    return stores;
  };

  it("reports and changes nothing on a dry run", async () => {
    const stores = await seed();
    const n = news();
    const r = await forgetCustomer(stores, PAT, { news: n, now });

    assert.deepEqual(r.orders, ["A"]);
    assert.equal(r.contactMessages, 1);
    assert.ok(await getCustomer(stores, PAT));
    assert.equal((await getOrder(stores, "A")).customer.email, PAT);
    assert.deepEqual(n.calls, [[PAT, false]]);
  });

  it("deletes everything that names them and keeps the orders", async () => {
    const stores = await seed();
    const n = news();
    const r = await forgetCustomer(stores, "Pat@Example.com", {
      apply: true, news: n, now,
    });

    assert.equal(r.ok, true);
    assert.equal(await getCustomer(stores, PAT), null);
    assert.deepEqual(await ordersFor(stores, PAT), []);

    const a = await getOrder(stores, "A");

    assert.equal(a.customer.deleted, true);
    assert.equal(a.history.at(-1).event, "details.deleted");
    assert.equal((await stores.orders.list(`by-email/${PAT}/`)).length, 0);
    assert.equal((await stores.orders.list("by-email//")).length, 0);
    assert.equal((await stores.customers.list("support/")).length, 0);
    assert.equal(await stores.customers.get("messages/m1"), null);
    assert.ok(await stores.customers.get("messages/m2"));
    assert.equal((await stores.auth.list("session/")).length, 0);
    assert.equal(await stores.auth.get("unsub/t1"), null);
    assert.equal(await stores.auth.get(`rate/${PAT}`), null);
    assert.equal(await stores.auth.get(`change-rate/${PAT}`), null);
    assert.ok(await getCustomer(stores, "sam@example.com"));
    assert.equal((await getOrder(stores, "B")).customer.email,
      "sam@example.com");
    assert.deepEqual(n.calls, [[PAT, true]]);
  });

  it("waits while an order is still to come", async () => {
    const stores = await seed();

    await saveOrder(stores, order("C", { status: "paid" }));

    const r = await forgetCustomer(stores, PAT, {
      apply: true, news: news(), now,
    });

    assert.equal(r.ok, false);
    assert.equal(r.wait, "open");
    assert.ok(await getCustomer(stores, PAT));
  });

  it("leaves a marker the sync acts on when Resend is down", async () => {
    const stores = await seed();
    const down = {
      removeContact: async () => {
        throw new Error("503");
      },
    };
    const r = await forgetCustomer(stores, PAT, {
      apply: true, news: down, now,
    });

    assert.match(r.resend, /not reached/);
    assert.ok(await stores.customers.get(forgottenKey(PAT)));

    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(`${init.method} ${url}`);

      return {
        ok: true,
        json: async () => (init.method === "GET"
          ? { data: [{ email: PAT, unsubscribed: false }] } : {}),
      };
    };
    const report = await syncAudience(stores, {
      env: { RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k" },
      fetchImpl, now, pace: 0,
    });

    assert.deepEqual(report.forgotten, [PAT]);
    assert.deepEqual(report.imported, []);
    assert.ok(calls.some((c) => c.startsWith("DELETE")));
    assert.equal(await getCustomer(stores, PAT), null);
    assert.equal(await stores.customers.get(forgottenKey(PAT)), null);
  });
});

// D-189 (#267): "Delete my details" also deletes the Square customer
// profile, found only through the customerId the customer's own orders
// recorded, never by name or email.
describe("forgetCustomer and the Square profile", () => {
  const withSquare = (id, customerId, extra) => ({
    ...order(id, extra),
    square: { squareOrderId: `SQ-${id}`, customerId },
  });
  const squareSpy = ({ fail = false } = {}) => {
    const deleted = [];

    return {
      deleted,
      deleteCustomer: async (id) => {
        if (fail) {
          throw new SquareError("Square 503 on /v2/customers",
            { status: 503, retryable: true });
        }
        deleted.push(id);

        return { deleted: true };
      },
    };
  };
  const seed = async () => {
    const stores = testStores();

    await saveCustomer(stores, customer());
    await saveCustomer(stores, customer("sam@example.com"));
    await saveOrder(stores, withSquare("A", "CUST-PAT"));
    await saveOrder(stores, withSquare("A2", "CUST-PAT"));
    await saveOrder(stores, withSquare("B", "CUST-SAM",
      { email: "sam@example.com" }));

    return stores;
  };

  it("counts the profiles on a dry run and deletes none", async () => {
    const stores = await seed();
    const square = squareSpy();
    const r = await forgetCustomer(stores, PAT, {
      news: news(), now, square,
    });

    assert.equal(r.squareProfiles, 1);
    assert.deepEqual(square.deleted, []);
  });

  it("deletes each profile its own orders name, once, and no other",
    async () => {
      const stores = await seed();
      const square = squareSpy();
      const r = await forgetCustomer(stores, PAT, {
        apply: true, news: news(), now, square,
      });

      assert.equal(r.ok, true);
      assert.deepEqual(square.deleted, ["CUST-PAT"]);
      assert.equal(await getCustomer(stores, PAT), null);
      assert.equal((await getOrder(stores, "A")).customer.deleted, true);
      assert.ok(await getCustomer(stores, "sam@example.com"));
    });

  it("changes nothing here when Square cannot be reached", async () => {
    const stores = await seed();
    const r = await forgetCustomer(stores, PAT, {
      apply: true, news: news(), now, square: squareSpy({ fail: true }),
    });

    assert.equal(r.ok, false);
    assert.match(r.message, /payment provider/);
    assert.ok(await getCustomer(stores, PAT));
    assert.equal((await getOrder(stores, "A")).customer.email, PAT);
  });

  it("never calls Square for a customer whose orders name no profile",
    async () => {
      const stores = testStores();
      const square = squareSpy({ fail: true });

      await saveCustomer(stores, customer());
      await saveOrder(stores, order("A"));

      const r = await forgetCustomer(stores, PAT, {
        apply: true, news: news(), now, square,
      });

      assert.equal(r.ok, true);
      assert.equal(r.squareProfiles, 0);
    });
});

describe("deleteOldMessages", () => {
  it("deletes messages and support notes over seven years old", async () => {
    const stores = testStores();

    await stores.customers.set("messages/old", {
      email: PAT, at: "2019-10-15T12:00:00Z" });
    await stores.customers.set("messages/new", {
      email: PAT, at: "2019-10-17T12:00:00Z" });
    await stores.customers.set(`support/${PAT}/old`, {
      at: "2019-10-01T12:00:00Z" });
    await stores.customers.set(`support/${PAT}/new`, {
      at: "2026-10-01T12:00:00Z" });
    await stores.customers.set(`support/${PAT}/undated`, { message: "hi" });

    assert.deepEqual(await deleteOldMessages(stores, now),
      ["messages/old", `support/${PAT}/old`]);
    assert.deepEqual(await deleteOldMessages(stores, now), []);
    assert.ok(await stores.customers.get("messages/new"));
    assert.ok(await stores.customers.get(`support/${PAT}/new`));
    assert.ok(await stores.customers.get(`support/${PAT}/undated`));
  });
});

describe("scrubOldOrders", () => {
  it("scrubs orders placed more than seven years ago, once", async () => {
    const stores = testStores();

    await saveOrder(stores, order("OLD", { at: "2019-10-15T12:00:00Z" }));
    await saveOrder(stores, order("NEW", { at: "2019-10-17T12:00:00Z" }));

    assert.deepEqual(await scrubOldOrders(stores, now), ["OLD"]);
    assert.deepEqual(await scrubOldOrders(stores, now), []);
    assert.equal((await getOrder(stores, "OLD")).customer.deleted, true);
    assert.equal((await getOrder(stores, "NEW")).customer.email, PAT);
    assert.deepEqual((await ordersFor(stores, PAT)).map((o) => o.id),
      ["NEW"]);
  });
});

describe("POST /api/account/delete", () => {
  const req = (body, cookie) => new Request("https://x/api/account/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie: `nff_session=${cookie}`,
    },
    body: JSON.stringify(body),
  });

  it("needs the account's email, then deletes and signs out", async () => {
    const stores = testStores();

    await saveCustomer(stores, customer());

    const session = await createSession(stores, PAT, { now });
    const opts = { stores, now, env: {}, news: news() };

    for (const body of [{}, { confirm: true }, { email: "" },
      { email: "someone@else.test" }]) {
      const refused = await handle(req(body, session.id), opts);

      assert.equal(refused.status, 422, JSON.stringify(body));
      assert.match((await refused.json()).errors.email, /isn't the email/);
    }
    assert.ok(await getCustomer(stores, PAT));

    const typed = `  ${PAT.toUpperCase()} `;
    const res = await handle(req({ email: typed }, session.id), opts);

    assert.equal(res.status, 200);
    assert.equal(res.headers.getSetCookie().length, 2);
    assert.equal(await getCustomer(stores, PAT), null);
  });

  it("says why it must wait", async () => {
    const stores = testStores();

    await saveCustomer(stores, customer());
    await saveOrder(stores, order("C", { status: "paid" }));

    const session = await createSession(stores, PAT, { now });
    const res = await handle(req({ email: PAT }, session.id), {
      stores, now, env: {}, news: news(),
    });

    assert.equal(res.status, 409);
    assert.match((await res.json()).message, /order in progress/);
  });
});
