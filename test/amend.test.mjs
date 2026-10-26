import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import {
  applyAmend, planAmend,
} from "../netlify/functions/lib/amend.mjs";
import { editOrder } from "../netlify/functions/lib/edit.mjs";
import {
  amendOrder, getOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  withholdCustomerEmail,
} from "../netlify/functions/lib/payments.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
  URL: "https://x", PICKUP_SCHEDULE: SCHEDULE,
};
const quiet = { sleep: async () => {} };

const fakeSquare = ({ refuse } = {}) => {
  const calls = [];
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createChangeOrder: async (order, change, key) => {
      calls.push(["changeOrder", key, change.difference]);

      return { squareOrderId: "SQC1", customerId: "CUST" };
    },
    createPayment: async (args) => ({
      squarePaymentId: `PAY-${args.squareOrderId}`, status: "COMPLETED",
      receiptUrl: null, brand: "VISA", last4: "4242", wallet: null,
    }),
    payZeroOrder: async (id) => {
      calls.push(["payZero", id]);

      return { squareOrderId: id };
    },
    cancelOrder: async () => {},
    cancelFulfillment: async (id) => calls.push(["cancelFulfillment", id]),
    updateFulfillment: async (id, o) => {
      calls.push(["updateFulfillment", id, o.fulfilment.date,
        o.fulfilment.method, o.fulfilment.occurrence]);
      if (refuse) throw new Error("Square: the fulfillment is completed");
    },
  };

  return { square, calls };
};

const outbox = () => {
  const sent = [];

  return { sent, mail: async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  } };
};

const newOrder = {
  idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment: {
    method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
  },
  claimedTotal: 5500,
  payment: { method: "card", sourceId: "cnon:tok" },
};

const placed = async () => {
  const stores = testStores();
  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newOrder),
  }), { stores, square: fakeSquare().square, now, env,
    mail: async () => ({}), ...quiet });

  assert.equal(res.status, 200);

  return { stores, id: (await res.json()).orderId };
};

const MARKET = { fulfilment: { method: "scheduled",
  occurrence: "WAC5-261025" } };

// A placed order the customer then moved to delivery.
const delivered = async () => {
  const { stores, id } = await placed();
  const customer = { email: "pat@example.com", name: "Pat Example" };
  const opts = { now, env, square: fakeSquare().square,
    mail: async () => ({}), ...quiet };
  const body = {
    idempotencyKey: "edit-key-000000-delivery",
    fulfilment: { method: "delivery", date: "2026-10-08",
      delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
        cooler: "Porch" } },
    payment: { method: "card", sourceId: "cnon:tok" },
  };
  const first = await editOrder(stores, customer, id, body, opts);

  await editOrder(stores, customer, id, {
    ...body, claimedTotal: first.totals.total,
  }, opts);

  return { stores, id };
};

// Plans and applies a change, as the CLI does.
const change = async (stores, id, body, {
  at = now, square = fakeSquare().square, mail = async () => ({}),
  noSquare = false, force = false,
} = {}) => {
  const planned = await planAmend(stores, id, body, {
    now: at, env, noSquare,
  });

  if (!planned.ok) return planned;

  const done = await applyAmend(stores, planned.plan, {
    now: at, env, mail, square, force, ...quiet,
  });

  return { ...done, plan: planned.plan };
};

afterEach(() => withholdCustomerEmail(false));

describe("orders change, the farm's change to any order", () => {
  it("refuses an order cancelled while Square was changing, and flags it " +
    "out of sync with Square", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const update = square.updateFulfillment;

    // A customer's cancel lands while the farm's change is in Square.
    square.updateFulfillment = async (...args) => {
      await update(...args);
      await setStatus(stores, id, "cancelled", now);
    };

    const planned = await planAmend(stores, id, MARKET, {
      now, env, noSquare: false,
    });

    assert.equal(planned.ok, true, JSON.stringify(planned));
    await assert.rejects(applyAmend(stores, planned.plan, {
      now, env, mail: async () => ({}), square, force: false, ...quiet,
    }), /became cancelled.*flagged out of sync/);
    assert.equal(calls.filter((c) => c[0] === "updateFulfillment").length, 1);

    const saved = await getOrder(stores, id);

    assert.equal(saved.status, "cancelled");
    assert.equal(saved.flags.squareOutOfSync, true);
    assert.equal(saved.history.some((h) => h.event === "farm.changed"),
      false, "the change was not recorded");
  });

  it("changes a future order and follows in Square", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const { sent, mail } = outbox();
    const r = await change(stores, id, MARKET, { square, mail });

    assert.equal(r.ok, true, JSON.stringify(r));

    const saved = await getOrder(stores, id);
    const last = saved.history.find((h) => h.event === "farm.changed");

    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
    assert.equal(saved.fulfilment.date, "2026-10-25");
    assert.equal(last.event, "farm.changed");
    assert.equal(last.square, "updated");
    assert.match(last.before, /On-farm pickup/);
    assert.match(last.after, /Foster/);
    assert.deepEqual(calls[0].slice(0, 2), ["updateFulfillment", "SQO"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "pat@example.com");
    // The schedule hasn't opened Foster: a warning, not a refusal.
    assert.ok(r.plan.warnings.some((w) => /could choose/.test(w)));
  });

  it("changes a past order, warning of the customer's rules it " +
    "overrides", async () => {
    const { stores, id } = await placed();
    const later = instant("2026-10-26", 9, 0, "America/New_York");
    const { square } = fakeSquare();
    const r = await change(stores, id, MARKET, { at: later, square });

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.plan.warnings.some((w) => /in the past/.test(w)));
    assert.ok(r.plan.warnings.some((w) => /could choose/.test(w)));
    assert.equal((await getOrder(stores, id)).fulfilment.date, "2026-10-25");
  });

  it("changes a present order in any status", async () => {
    const { stores, id } = await placed();

    await amendOrder(stores, id, { status: "fulfilled" }, "fulfilled", now);

    const r = await change(stores, id, MARKET);

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.plan.warnings.some((w) => /fulfilled, not paid/.test(w)));
    assert.equal((await getOrder(stores, id)).status, "fulfilled");
  });

  it("needs an occurrence that exists", async () => {
    const { stores, id } = await placed();
    const r = await change(stores, id, { fulfilment: {
      method: "scheduled", occurrence: "ZZZZ-261025" } });

    assert.equal(r.ok, false);
    assert.match(r.errors["fulfilment.occurrence"],
      /No occurrence "ZZZZ-261025" to book/);
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
  });

  it("won't book an archived series' occurrence", async () => {
    const { stores, id } = await placed();
    const r = await change(stores, id, { fulfilment: {
      method: "scheduled", occurrence: "R6N4-260718" } });

    assert.equal(r.ok, false);
    assert.match(r.errors["fulfilment.occurrence"], /to book/);
  });

  it("won't take a date that isn't the occurrence's", async () => {
    const { stores, id } = await placed();
    const r = await change(stores, id, { fulfilment: {
      method: "scheduled", occurrence: "WAC5-261025", date: "2026-10-26" } });

    assert.equal(r.ok, false);
    assert.match(r.errors["fulfilment.date"], /is on 2026-10-25/);
  });

  it("won't take an occurrence on another way of getting the order",
    async () => {
      const { stores, id } = await placed();
      const r = await change(stores, id, { fulfilment: {
        method: "onfarm", occurrence: "WAC5-261025" } });

      assert.equal(r.ok, false);
      assert.match(r.errors["fulfilment.occurrence"], /goes with method/);
    });

  it("moves an order stored the Stage 1 way, telling the move", async () => {
    const { stores, id } = await placed();

    await amendOrder(stores, id, { fulfilment: {
      ...(await getOrder(stores, id)).fulfilment, method: "market",
      site: "foster", date: "2026-10-18", onfarm: null,
    } }, "test", now);

    const r = await change(stores, id, MARKET);
    const saved = await getOrder(stores, id);
    const moved = saved.history.find((h) => h.event === "fulfilment.moved");

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(saved.fulfilment.site, undefined);
    assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
    assert.deepEqual([moved.from, moved.to, moved.by],
      ["WAC5-261018", "WAC5-261025", "farm"]);
  });

  it("with --no-square leaves Square alone and records it", async () => {
    const { stores, id } = await placed();
    const { square, calls } = fakeSquare();
    const r = await change(stores, id, MARKET, { square, noSquare: true });

    assert.equal(r.ok, true);
    assert.deepEqual(calls, []);
    assert.match(r.plan.effects.square, /--no-square/);
    assert.match(r.report.square, /not changed/);
    assert.match((await getOrder(stores, id)).history
      .find((h) => h.event === "farm.changed").square, /--no-square/);
  });

  it("refuses a change that could move money, unless --force",
    async () => {
      const { stores, id } = await placed();
      const { square } = fakeSquare();

      const customer = { email: "pat@example.com", name: "Pat Example" };
      const opts = { now, env, square, mail: async () => ({}), ...quiet };
      const body = {
        idempotencyKey: "edit-key-000000-delivery",
        fulfilment: { method: "delivery", date: "2026-10-08",
          delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
            cooler: "Porch" } },
        payment: { method: "card", sourceId: "cnon:tok" },
      };
      const first = await editOrder(stores, customer, id, body, opts);

      await editOrder(stores, customer, id, {
        ...body, claimedTotal: first.totals.total,
      }, opts);

      const before = await getOrder(stores, id);

      assert.equal(before.fulfilment.method, "delivery");

      const refused = await change(stores, id, MARKET, { square });

      assert.equal(refused.ok, false);
      assert.equal(refused.refused, "money");
      assert.match(refused.message, /take off \$\d+/);
      assert.match(refused.plan.effects.money, /take off/);
      assert.equal((await getOrder(stores, id)).fulfilment.method,
        "delivery");

      const forced = await change(stores, id, MARKET, { square,
        force: true });
      const saved = await getOrder(stores, id);

      assert.equal(forced.ok, true, JSON.stringify(forced));
      assert.equal(saved.fulfilment.method, "scheduled");
      // Forcing applies the record; no money moved.
      assert.deepEqual(saved.totals, before.totals);
      assert.equal(saved.history.find((h) => h.event === "farm.changed").forced,
        true);
    });

  it("applies nothing when Square refuses, unless --force", async () => {
    const { stores, id } = await placed();
    const { square } = fakeSquare({ refuse: true });
    const { sent, mail } = outbox();
    const refused = await change(stores, id, MARKET, { square, mail });

    assert.equal(refused.ok, false);
    assert.equal(refused.refused, "square");
    assert.match(refused.message, /would not take the change/);
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
    assert.equal(sent.length, 0);

    const forced = await change(stores, id, MARKET, { square, mail,
      force: true });
    const saved = await getOrder(stores, id);

    assert.equal(forced.ok, true);
    assert.match(forced.report.square, /refused.*kept the old fulfillment/);
    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.flags.squareOutOfSync, true);
    assert.match(saved.history.find((h) => h.event === "farm.changed").square,
      /kept the old fulfillment/);
  });

  it("lists every side effect, and --dry-run changes nothing", async () => {
    const { stores, id } = await placed();
    const planned = await planAmend(stores, id, MARKET, { now, env });

    assert.equal(planned.ok, true);

    const { effects } = planned.plan;

    assert.match(effects.email, /pat@example.com.*order changed/);
    assert.match(effects.square, /Square order SQO/);
    assert.match(effects.stock, /none/);
    assert.match(effects.money, /none/);
    assert.match(effects.history[0], /farm.changed/);
    assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");
  });

  it("says no email goes with --no-email, and sends none", async () => {
    const { stores, id } = await placed();
    const { sent, mail } = outbox();

    withholdCustomerEmail(true);

    const r = await change(stores, id, MARKET, { mail });

    assert.equal(r.ok, true);
    assert.match(r.plan.effects.email, /none \(--no-email\)/);
    assert.equal(sent.length, 0);
  });

  it("runs NFF-2610-Z9J3's command on a copy of its record shape",
    async () => {
      const { stores, id } = await placed();
      const later = instant("2026-10-27", 9, 0, "America/New_York");
      const { sent, mail } = outbox();

      // The command: bin/nff --production orders change NFF-2610-Z9J3
      // --method scheduled --occurrence WAC5-261025 --no-email
      withholdCustomerEmail(true);

      const r = await change(stores, id, MARKET, { at: later, mail });
      const saved = await getOrder(stores, id);

      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(saved.fulfilment.method, "scheduled");
      assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
      assert.equal(saved.fulfilment.date, "2026-10-25");
      assert.equal(saved.status, "paid");
      assert.equal(sent.length, 0);
    });

  it("runs Z9J3's command when Square refuses: refuse, then --force",
    async () => {
      const { stores, id } = await placed();
      const later = instant("2026-10-27", 9, 0, "America/New_York");
      const { square } = fakeSquare({ refuse: true });

      withholdCustomerEmail(true);

      const refused = await change(stores, id, MARKET,
        { at: later, square });

      assert.equal(refused.ok, false);
      assert.equal(refused.refused, "square");
      assert.doesNotMatch(refused.message, /Nothing was applied/);
      assert.equal((await getOrder(stores, id)).fulfilment.method, "onfarm");

      const forced = await change(stores, id, MARKET,
        { at: later, square, force: true });
      const saved = await getOrder(stores, id);
      const event = saved.history.find((h) => h.event === "farm.changed");

      assert.equal(forced.ok, true, JSON.stringify(forced));
      assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
      assert.equal(saved.flags.squareOutOfSync, true);
      assert.deepEqual(event.flags,
        { noSquare: false, force: true, noEmail: true });
    });

  it("runs Z9J3's command with --no-square and records every flag",
    async () => {
      const { stores, id } = await placed();
      const later = instant("2026-10-27", 9, 0, "America/New_York");
      const { square, calls } = fakeSquare({ refuse: true });

      withholdCustomerEmail(true);

      const r = await change(stores, id, MARKET,
        { at: later, square, noSquare: true });
      const saved = await getOrder(stores, id);

      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(calls, []);
      assert.equal(saved.fulfilment.occurrence, "WAC5-261025");
      assert.deepEqual(saved.history
        .find((h) => h.event === "farm.changed").flags,
      { noSquare: true, force: false, noEmail: true });
    });

  it("cancels the $0 order it made when a later Square call fails",
    async () => {
      const { stores, id } = await delivered();
      const { square } = fakeSquare();
      const keys = [];
      const cancelled = [];

      square.createChangeOrder = async (o, c, key) => {
        keys.push(key);

        return { squareOrderId: "SQC1", customerId: "CUST" };
      };
      square.cancelFulfillment = async () => { throw new Error("stuck"); };
      square.cancelOrder = async (sid) => {
        cancelled.push(sid);

        return { id: sid, cancelled: true };
      };

      const one = await change(stores, id, MARKET, { square, force: true });

      assert.equal(one.ok, true, JSON.stringify(one));
      assert.deepEqual(cancelled, ["SQC1"]);
      assert.match(one.report.square, /SQC1.*canceled/);

      // A retry of the same change, an hour on.
      const again = instant("2026-10-06", 10, 0, "America/New_York");

      await applyAmend(stores, one.plan, {
        now: again, env, mail: async () => ({}), square, force: true, ...quiet,
      });
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1], "the key names the target, not the time");
    });

  it("gives a repeat change its own key and leaves a paid $0 order",
    async () => {
      const { stores, id } = await delivered();
      const { square } = fakeSquare();
      const keys = [];
      const asked = [];
      const DELIVERY = { fulfilment: { method: "delivery",
        date: "2026-10-08", delivery: { address1: "1 Main St",
          town: "Foster", zip: "02825", cooler: "Porch" } } };
      const at = (h) => instant("2026-10-06", h, 0, "America/New_York");

      square.createChangeOrder = async (o, c, key) => {
        keys.push(key);

        return { squareOrderId: `SQ-${keys.length}`, customerId: "CUST" };
      };
      square.cancelOrder = async (sid, opts) => {
        asked.push([sid, opts.unpaid]);

        return { id: sid, cancelled: false };
      };

      // B, A, B: each lands, so each is a change of its own.
      for (const [h, body] of [[10, MARKET], [11, DELIVERY], [12, MARKET]]) {
        const ok = await change(stores, id, body,
          { at: at(h), square, force: true });

        assert.equal(ok.ok, true, JSON.stringify(ok));
      }
      assert.equal(new Set(keys).size, 3, keys.join());

      // A again, but its last Square step fails.
      square.cancelFulfillment = async () => { throw new Error("stuck"); };

      const failed = await change(stores, id, DELIVERY,
        { at: at(13), square });

      assert.equal(failed.ok, false);
      assert.equal(new Set(keys).size, 4, "a repeat reused a key");
      assert.deepEqual(asked, [["SQ-4", true]]);
      assert.match(failed.message, /SQ-4.*left in place/);
    });

  it("names payment as the cause only when the $0 order has tenders",
    async () => {
      for (const paid of [true, false]) {
        const { stores, id } = await delivered();
        const { square } = fakeSquare();

        square.cancelFulfillment = async () => { throw new Error("stuck"); };
        square.cancelOrder = async (sid) => ({ id: sid, cancelled: false,
          paid });

        const failed = await change(stores, id, MARKET,
          { square, force: true });

        const said = failed.report.square;

        assert.equal(failed.ok, true, JSON.stringify(failed));
        assert.match(said, /SQC1\) was left in place/);
        assert.equal(/has taken payment/.test(said), paid, said);
      }
    });

  it("names the $0 order it could not cancel, and keeps it with --force",
    async () => {
      const { stores, id } = await delivered();
      const { square } = fakeSquare();

      square.cancelFulfillment = async () => { throw new Error("stuck"); };
      square.cancelOrder = async () => { throw new Error("no"); };

      const forced = await change(stores, id, MARKET, { square, force: true });

      assert.equal(forced.ok, true, JSON.stringify(forced));
      assert.match(forced.report.square, /SQC1.*could not be canceled/);
      assert.equal((await getOrder(stores, id)).square.fulfilmentOrderId,
        "SQC1");
    });

  it("refuses a change that changes nothing", async () => {
    const { stores, id } = await placed();
    const r = await change(stores, id, { fulfilment: { date: "2026-10-07" } });

    assert.equal(r.ok, false);
    assert.equal(r.errors.order, "Nothing has changed.");
  });
});
