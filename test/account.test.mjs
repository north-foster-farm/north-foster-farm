import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cancelOrder, changeOrder, listOrders, requestReturn, saveAddress,
  sendSupport, updateProfile,
} from "../netlify/functions/lib/account.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { markPaid } from "../netlify/functions/lib/payments.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/account.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
// Monday 5 October 2026, 09:00 ET; delivery Thursday the 8th.
const now = instant("2026-10-05", 9, 0, TZ);
const env = { ADMIN_EMAILS: "farm@example.com", URL: "https://x" };

const order = (id, method = "delivery", email = "pat@example.com") => ({
  id,
  status: "submitted",
  submittedAt: now.toISOString(),
  customer: { name: "Pat Example", email, phone: "" },
  lines: [
    { sku: "A", label: "Eggs (per dozen), Large", qty: 1, unitPrice: 7,
      lineTotal: 7 },
  ],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 500, total: 1200 },
  fulfilment: {
    method,
    date: method === "delivery" ? "2026-10-08" : "2026-10-07",
    onfarm: method === "onfarm"
      ? { window: "morning", phone: "4015550100", textOk: false } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
      gate: "", notes: "",
    } : null,
  },
  notes: "",
  square: {
    squareOrderId: "SQO", invoiceId: `INV-${id}`, invoiceUrl: "https://pay",
    invoiceNumber: "7",
  },
});

const customerOf = (email = "pat@example.com") => ({
  email, name: "Pat Example", phone: "", avatar: null, discountGroup: null,
  address: null,
});

const harness = () => {
  const sent = [];
  const calls = [];

  return {
    sent,
    calls,
    opts: {
      now,
      env,
      mail: async (m) => {
        sent.push(m);

        return { id: `m${sent.length}`, driver: "test" };
      },
      square: {
        cancelInvoice: async (id) => { calls.push(["cancelInvoice", id]); },
        cancelFulfilment: async (id) => {
          calls.push(["cancelFulfilment", id]);
        },
        updateFulfilment: async (id, o) => {
          calls.push(["updateFulfilment", id, o.fulfilment.date]);
        },
      },
    },
  };
};

describe("listOrders", () => {
  it("shows only the customer's orders, newest first, in public shape",
    async () => {
      const stores = testStores();

      await saveOrder(stores, {
        ...order("A"), submittedAt: "2026-10-01T00:00:00Z",
      });
      await saveOrder(stores, order("B"));
      await saveOrder(stores, order("C", "delivery", "other@example.com"));

      const { orders } = await listOrders(stores, customerOf(), { now });

      assert.deepEqual(orders.map((o) => o.id), ["B", "A"]);
      assert.equal(orders[0].invoice.url, "https://pay");
      assert.equal(orders[0].canCancel, true);
      assert.equal(orders[0].square, undefined);
      assert.equal(orders[0].history, undefined);
    });
});

describe("cancelOrder", () => {
  it("cancels an unpaid order, closes Square and emails", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await saveOrder(stores, order("A"), now);
    const r = await cancelOrder(stores, customerOf(), "A", opts);

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "cancelled");
    assert.deepEqual(calls, [
      ["cancelInvoice", "INV-A"], ["cancelFulfilment", "SQO"],
    ]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /cancelled/);
    assert.match(sent[0].text, /you were not charged/);
  });

  it("flags a paid order for refund and tells the farm", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await saveOrder(stores, order("A"), now);
    await markPaid(stores, "A", { ...opts, now });
    sent.length = 0;
    const r = await cancelOrder(stores, customerOf(), "A", opts);

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "paid");
    assert.equal(r.order.cancelRequested, true);
    assert.equal(r.order.canCancel, false);
    assert.deepEqual(calls, []);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /refund is on its way/);
    assert.deepEqual(sent[1].to, ["farm@example.com"]);
    assert.match(sent[1].subject, /Refund needed/);
  });

  it("refuses someone else's order, and one past the cutoff", async () => {
    const stores = testStores();
    const { opts } = harness();

    await saveOrder(stores, order("A"), now);
    assert.equal((await cancelOrder(stores, customerOf("x@y.com"), "A", opts))
      .status, 404);

    const late = instant("2026-10-07", 12, 1, TZ);

    assert.equal((await cancelOrder(stores, customerOf(), "A", {
      ...opts, now: late,
    })).status, 409);
  });
});

describe("changeOrder", () => {
  it("moves the date and drop-off details and updates Square", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await saveOrder(stores, order("A"), now);
    const r = await changeOrder(stores, customerOf(), "A", {
      date: "2026-10-15",
      delivery: { cooler: "Back steps", gate: "9", notes: "Dog is friendly" },
      notes: "Thanks!",
    }, opts);

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.order.fulfilment.date, "2026-10-15");
    assert.equal(r.order.fulfilment.delivery.cooler, "Back steps");
    assert.equal(r.order.notes, "Thanks!");
    assert.deepEqual(calls, [["updateFulfilment", "SQO", "2026-10-15"]]);
    assert.match(sent[0].subject, /updated/);
    assert.match(sent[0].text, /find your cooler\? _\*\*Back steps\*\*_/);
  });

  it("rejects a date that is not offered and an empty cooler", async () => {
    const stores = testStores();
    const { opts } = harness();

    await saveOrder(stores, order("A"), now);
    const bad = await changeOrder(stores, customerOf(), "A", {
      date: "2026-10-09", delivery: { cooler: "" },
    }, opts);

    assert.equal(bad.status, 422);
    assert.ok(bad.errors.date);
    assert.ok(bad.errors["delivery.cooler"]);
  });

  it("flags the order and tells the farm when Square cannot follow",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();

      await saveOrder(stores, order("A", "onfarm"), now);
      const r = await changeOrder(stores, customerOf(), "A", {
        onfarm: { window: "afternoon" },
      }, {
        ...opts,
        square: { updateFulfilment: async () => { throw new Error("no"); } },
      });

      assert.equal(r.ok, true);
      assert.equal((await getOrder(stores, "A")).flags.squareOutOfSync, true);
      assert.ok(sent.some((m) => /out of sync/.test(m.subject)));
    });
});

describe("profile and address", () => {
  it("updates name, phone and a valid avatar", async () => {
    const stores = testStores();
    const ok = await updateProfile(stores, customerOf(), {
      name: " Patricia ", phone: "401-555-0100", avatar: "rooster",
    });

    assert.equal(ok.customer.name, "Patricia");
    assert.equal(ok.customer.avatar, "rooster");
    assert.equal((await getCustomer(stores, "pat@example.com")).avatar,
      "rooster");

    const bad = await updateProfile(stores, customerOf(), {
      name: "", phone: "12", avatar: "dragon",
    });

    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.errors).sort(),
      ["avatar", "name", "phone"]);
  });

  it("turns reminder emails off and on, one at a time", async () => {
    const stores = testStores();
    const saved = await saveCustomer(stores, customerOf());
    const off = await updateProfile(stores, saved, {
      reminders: { payment: false },
    });

    assert.deepEqual(off.customer.reminders,
      { payment: false, delivery: true });

    // A key left out is unchanged; anything truthy is on.
    const on = await updateProfile(stores, off.customer, {
      reminders: { delivery: 0 },
    });

    assert.deepEqual(on.customer.reminders,
      { payment: false, delivery: false });
    assert.deepEqual((await getCustomer(stores, "pat@example.com")).reminders,
      { payment: false, delivery: false });

    const back = await updateProfile(stores, on.customer, {
      reminders: { payment: true, delivery: true },
    });

    assert.deepEqual(back.customer.reminders,
      { payment: true, delivery: true });
    assert.equal((await updateProfile(stores, saved, { reminders: "no" }))
      .status, 422);
  });

  it("approves an in-area address at once", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const r = await saveAddress(stores, customerOf(), {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    }, opts);

    assert.equal(r.customer.address.status, "approved");
    assert.equal(r.customer.address.state, "RI");
    assert.equal(sent.length, 0);
  });

  it("holds an outside address pending and tells the farm", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const r = await saveAddress(stores, customerOf(), {
      address1: "5 Far Rd", town: "Nowhere", zip: "01234",
    }, opts);

    assert.equal(r.customer.address.status, "pending");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["farm@example.com"]);
    assert.match(sent[0].subject, /Address to review/);

    // The farm approves; changing only the cooler keeps that.
    const approved = await saveCustomer(stores, {
      ...r.customer,
      address: { ...r.customer.address, status: "approved" },
    });
    const again = await saveAddress(stores, approved, {
      address1: "5 Far Rd", town: "Nowhere", zip: "01234", cooler: "Shed",
    }, opts);

    assert.equal(again.customer.address.status, "approved");
    assert.equal(sent.length, 1);

    // A new street starts the review over.
    const moved = await saveAddress(stores, again.customer, {
      address1: "6 Far Rd", town: "Nowhere", zip: "01234",
    }, opts);

    assert.equal(moved.customer.address.status, "pending");
    assert.equal(sent.length, 2);
  });
});

describe("returns and support", () => {
  it("records a return request on a paid order and tells the farm",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();

      await saveOrder(stores, order("A"), now);
      assert.equal((await requestReturn(stores, customerOf(), "A", {
        reason: "x",
      }, opts)).status, 409, "unpaid orders have nothing to return");

      await markPaid(stores, "A", { ...opts, now });
      sent.length = 0;
      const r = await requestReturn(stores, customerOf(), "A", {
        reason: "One pack was thawed", skus: ["A", "nope"],
      }, opts);

      assert.equal(r.ok, true);
      assert.equal(r.request.status, "requested");
      assert.deepEqual(r.request.skus, ["A"]);
      assert.equal(r.order.returns.length, 1);
      assert.match(sent[0].subject, /Return request/);
    });

  it("files a support message and tells the farm", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const r = await sendSupport(stores, customerOf(), {
      subject: "Eggs", message: "Do you have duck eggs?", orderId: "",
    }, opts);

    assert.equal(r.ok, true);
    assert.match(sent[0].subject, /Support: Eggs/);
    assert.match(sent[0].text, /duck eggs/);
    assert.equal((await stores.customers.list("support/pat@example.com/"))
      .length, 1);
    assert.equal((await sendSupport(stores, customerOf(), {}, opts)).status,
      422);
  });
});

describe("the account endpoints", () => {
  const req = (path, method, body, cookie) => new Request(`https://x${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie: `nff_session=${cookie}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it("needs a session and routes by path", async () => {
    const stores = testStores();
    const { opts } = harness();

    assert.equal((await handle(req("/api/account/orders", "GET"), {
      stores, ...opts,
    })).status, 401);

    const session = await createSession(stores, "pat@example.com", { now });

    await saveOrder(stores, order("A"), now);

    const list = await handle(req("/api/account/orders", "GET", undefined,
      session.id), { stores, ...opts });

    assert.equal(list.status, 200);
    assert.equal((await list.json()).orders[0].id, "A");

    const profile = await handle(req("/api/account/profile", "PATCH", {
      name: "Pat", avatar: "chick", reminders: { delivery: false },
    }, session.id), { stores, ...opts });
    const me = (await profile.json()).customer;

    assert.equal(me.avatar, "chick");
    assert.deepEqual(me.reminders, { payment: true, delivery: false });

    const cancel = await handle(req("/api/account/orders/A/cancel", "POST",
      {}, session.id), { stores, ...opts });

    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).order.status, "cancelled");

    const missing = await handle(req("/api/account/orders/ZZZZZZ/cancel",
      "POST", {}, session.id), { stores, ...opts });

    assert.equal(missing.status, 404);
  });

  it("refuses cross-site posts", async () => {
    const stores = testStores();
    const { opts } = harness();
    const session = await createSession(stores, "pat@example.com", { now });
    const r = new Request("https://x/api/account/support", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "sec-fetch-site": "cross-site",
        cookie: `nff_session=${session.id}`,
      },
      body: "{}",
    });

    assert.equal((await handle(r, { stores, ...opts })).status, 403);
  });
});
