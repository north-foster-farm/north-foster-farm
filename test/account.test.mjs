import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cancelOrder, changeOrder, listOrders, requestReturn, saveAddress,
  sendSupport, updateProfile,
} from "../netlify/functions/lib/account.mjs";
import {
  createSession, publicCustomer,
} from "../netlify/functions/lib/auth.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { getCounts, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/account.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
// Monday 5 October 2026, 09:00 ET; delivery Thursday the 8th.
const now = instant("2026-10-05", 9, 0, TZ);
const env = { ADMIN_EMAILS: "farm@example.com", URL: "https://x" };

// Born paid, by card through Square.
const order = (id, method = "delivery", email = "pat@example.com") => ({
  id,
  status: "paid",
  submittedAt: now.toISOString(),
  paidAt: now.toISOString(),
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
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: {
    via: "square", method: "card", at: now.toISOString(),
    squarePaymentId: `PAY-${id}`, receiptUrl: "https://r/x", brand: "VISA",
    last4: "4242",
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
      assert.deepEqual(orders[0].payment, {
        via: "square", method: "card", brand: "VISA", last4: "4242",
        receiptUrl: "https://r/x",
      });
      assert.equal(orders[0].refund, null);
      assert.equal(orders[0].invoice, undefined);
      assert.equal(orders[0].paymentPending, undefined);
      assert.equal(orders[0].canCancel, true);
      assert.equal(orders[0].canChange, true);
      assert.equal(orders[0].square, undefined);
      assert.equal(orders[0].history, undefined);
    });

  it("shows a refund, and a record with no payment shows none", async () => {
    const stores = testStores();

    await saveOrder(stores, {
      ...order("A"),
      refund: {
        at: "2026-10-06T00:00:00Z", source: "farm", amount: 1200, total: true,
        squareRefundId: "SQR-1", paypalRefundId: null, status: "PENDING",
      },
    });
    await saveOrder(stores, { ...order("B"), payment: null });

    const { orders } = await listOrders(stores, customerOf(), { now });
    const a = orders.find((o) => o.id === "A");
    const b = orders.find((o) => o.id === "B");

    assert.deepEqual(a.refund, {
      at: "2026-10-06T00:00:00Z", amount: 1200, total: true,
    });
    assert.equal(b.payment, null);
  });
});

describe("cancelOrder", () => {
  it("flags the order for a refund, puts the stock back and tells the " +
    "farm what to run", async () => {
    const stores = testStores();
    const { sent, calls, opts } = harness();

    await setCount(stores, "A", 3);
    await saveOrder(stores, order("A"), now);
    const r = await cancelOrder(stores, customerOf(), "A", opts);

    assert.equal(r.ok, true);
    assert.equal(r.order.status, "paid", "closed by the farm, not here");
    assert.equal(r.order.cancelRequested, true);
    assert.equal(r.order.canCancel, false);
    assert.equal(r.order.canChange, false);
    assert.deepEqual(calls, [], "Square is touched from the CLI");
    assert.equal((await getCounts(stores)).A, 4);
    assert.equal(sent.length, 2);
    assert.match(sent[0].subject, /cancelled/);
    assert.match(sent[0].text, /refund is on its way/);
    assert.deepEqual(sent[1].to, ["farm@example.com"]);
    assert.equal(sent[1].subject,
      "Refund needed: A cancelled by pat@example.com");
    assert.match(sent[1].text, /bin\/nff orders cancel A --refund/);
    assert.match(sent[1].html,
      /<code>bin\/nff orders cancel A --refund<\/code>/);

    const saved = await getOrder(stores, "A");

    assert.equal(saved.cancelRequestedAt, now.toISOString());
    assert.equal(saved.history.at(-2).event, "cancel.requested");

    // Asking twice is refused: the first request already stands.
    const again = await cancelOrder(stores, customerOf(), "A", opts);

    assert.equal(again.status, 409);
    assert.equal(sent.length, 2);
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

  it("makes a moved pickup a new request, answers a denied window, and " +
    "tells the farm", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const o = order("A", "onfarm");

    o.fulfilment.state = "agreed";
    o.fulfilment.agreedAt = "2026-10-05T12:00:00Z";
    o.question = {
      kind: "window", reason: "Rain.", openedAt: "2026-10-05T12:30:00Z",
      answeredAt: null, answer: null, by: null,
    };
    await saveOrder(stores, o, now);

    // Only the notes: still agreed, question still open.
    const same = await changeOrder(stores, customerOf(), "A", {
      notes: "Back door", onfarm: { window: "morning" },
    }, opts);

    assert.equal(same.order.fulfilment.state, "agreed");
    assert.equal(same.order.question.answeredAt, null);
    assert.equal(sent.filter((m) => Array.isArray(m.to)).length, 0);

    const moved = await changeOrder(stores, customerOf(), "A", {
      onfarm: { window: "afternoon" },
    }, opts);

    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.order.fulfilment.state, "requested");
    assert.equal(moved.order.fulfilment.agreedAt, null);
    assert.equal(moved.order.question.answer, "reschedule");
    assert.ok(moved.order.question.answeredAt);

    const customer = sent.filter((m) => !Array.isArray(m.to));
    const farm = sent.filter((m) => Array.isArray(m.to));

    assert.match(customer.at(-1).subject, /updated/);
    assert.match(customer.at(-1).text,
      /- Requested: Wednesday, October 7, afternoon/);
    assert.equal(farm.length, 1);
    assert.match(farm[0].subject, /^Pickup time to confirm: A/);
    assert.match(farm[0].text, /bin\/nff orders confirm A/);
  });

  it("keeps a denied order open to change or cancel past the cutoff",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();
      const o = order("A", "onfarm");

      o.question = {
        kind: "window", reason: "", openedAt: now.toISOString(),
        answeredAt: null, answer: null, by: null,
      };
      await saveOrder(stores, o, now);

      // Midnight before the pickup has passed.
      const late = instant("2026-10-07", 9, 0, TZ);
      const listed = await listOrders(stores, customerOf(), { now: late });

      assert.equal(listed.orders[0].canChange, true);
      assert.equal(listed.orders[0].canCancel, true);
      assert.equal(listed.orders[0].question.kind, "window");

      const r = await cancelOrder(stores, customerOf(), "A", {
        ...opts, now: late,
      });

      assert.equal(r.ok, true);
      assert.equal(r.order.cancelRequested, true, "the farm refunds");
      assert.equal(r.order.question.answer, "cancel");
      assert.match(sent[0].subject, /cancelled/);
      assert.match(sent[0].text, /refund is on its way/);

      // Without a question the cutoff still closes the doors.
      await saveOrder(stores, order("B", "onfarm"), now);
      const b = await listOrders(stores, customerOf(), { now: late });

      assert.equal(b.orders.find((x) => x.id === "B").canChange, false);
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
  it("updates the name in parts, the phone and a valid avatar", async () => {
    const stores = testStores();
    const ok = await updateProfile(stores, customerOf(), {
      firstName: " Patricia ", lastName: "Example", phone: "401-555-0100",
      avatar: "rooster", marketing: true,
    }, { now: new Date("2026-09-23T15:00:00Z") });

    assert.equal(ok.customer.firstName, "Patricia");
    assert.equal(ok.customer.lastName, "Example");
    assert.equal(ok.customer.name, "Patricia Example");
    assert.equal(ok.customer.marketing, true);
    assert.equal(ok.customer.marketingAt, "2026-09-23T15:00:00.000Z");

    const off = await updateProfile(stores, ok.customer, {
      marketing: false,
    }, { now: new Date("2026-09-24T15:00:00Z") });

    assert.equal(off.customer.marketing, false);
    assert.equal(off.customer.marketingAt, "2026-09-24T15:00:00.000Z");
    assert.equal(publicCustomer(customerOf()).marketing, false,
      "off unless the customer turned it on");
    assert.equal(ok.customer.avatar, "rooster");
    assert.equal((await getCustomer(stores, "pat@example.com")).avatar,
      "rooster");

    const bad = await updateProfile(stores, customerOf(), {
      firstName: "", lastName: "", phone: "12", avatar: "dragon",
    });

    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.errors).sort(),
      ["avatar", "firstName", "lastName", "phone"]);
  });

  it("turns the delivery reminder off and on", async () => {
    const stores = testStores();
    const saved = await saveCustomer(stores, customerOf());
    const off = await updateProfile(stores, saved, {
      reminders: { delivery: 0 },
    });

    assert.deepEqual(off.customer.reminders, { delivery: false });
    assert.deepEqual((await getCustomer(stores, "pat@example.com")).reminders,
      { delivery: false });

    // A key left out is unchanged; one that no longer exists (payment
    // reminders, from when an order could be unpaid) is ignored.
    const same = await updateProfile(stores, off.customer, {
      reminders: { payment: true },
    });

    assert.deepEqual(same.customer.reminders, { delivery: false });

    const back = await updateProfile(stores, same.customer, {
      reminders: { delivery: 1 },
    });

    assert.deepEqual(back.customer.reminders, { delivery: true });
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

      await saveOrder(stores, { ...order("Z"), status: "cancelled" }, now);
      assert.equal((await requestReturn(stores, customerOf(), "Z", {
        reason: "x",
      }, opts)).status, 409, "a cancelled order has nothing to return");
      await saveOrder(stores, order("A"), now);
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
      firstName: "Pat", lastName: "Example", avatar: "chick",
      reminders: { delivery: false },
    }, session.id), { stores, ...opts });
    const me = (await profile.json()).customer;

    assert.equal(me.avatar, "chick");
    assert.equal(me.name, "Pat Example");
    assert.deepEqual(me.reminders, { delivery: false });

    const cancel = await handle(req("/api/account/orders/A/cancel", "POST",
      {}, session.id), { stores, ...opts });

    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).order.cancelRequested, true);

    const missing = await handle(req("/api/account/orders/ZZZZZZ/cancel",
      "POST", {}, session.id), { stores, ...opts });

    assert.equal(missing.status, 404);

    // The pay-link and Venmo routes went with the invoice.
    for (const gone of ["resend", "venmo"]) {
      const r = await handle(req(`/api/account/orders/A/${gone}`, "POST",
        {}, session.id), { stores, ...opts });

      assert.equal(r.status, 404, gone);
    }
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
