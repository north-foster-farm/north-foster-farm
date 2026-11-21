// The server's side of #721: after a Venmo capture refused with
// INSTRUMENT_DECLINED the page reopens the sheet on the same PayPal
// order and captures again, marked `restart`. The decline path (the
// credit given back, the declined count) may then run twice for one
// order, and the restart's capture must reach PayPal under a request
// id of its own, since PayPal may answer a repeated one with the
// first decline. Not a criteria test: the implementer's own.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  PAGE_GRACE, attemptKey, finishVenmo, rescueCheckout,
} from "../netlify/functions/lib/checkout.mjs";
import {
  creditBalance, grantCredit,
} from "../netlify/functions/lib/credit.mjs";
import { joinGroup, setGroupCode } from "../netlify/functions/lib/groups.mjs";
import { readCount } from "../netlify/functions/lib/health.mjs";
import { PayPalError } from "../netlify/functions/lib/paypal.mjs";
import {
  checkoutByPayPal, getCheckout, getOrder, markCheckout, saveCheckout,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-11-02", 9, 0, "America/New_York");
const DAY = "2026-11-02";
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const EMAIL = "pat@example.com";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};
const from = { group: "vff", round: "2026-10-25", kind: "host" };

// A $55 order, $20 of it the member's credit: $35 by Venmo.
const body = (payment) => ({
  idempotencyKey: KEY,
  customer: {
    firstName: "Pat", lastName: "Example", email: EMAIL,
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
  fulfilment: { method: "scheduled", occurrence: "36TS-261122" },
  claimedTotal: 3500,
  payment: { method: "venmo", ...payment },
});

const member = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: "GYM-2026", now });

  const session = await createSession(stores, EMAIL, { now });

  await joinGroup(stores, EMAIL, "vff", { now });
  await grantCredit(stores, EMAIL, {
    amount: 2000, from, now, timeZone: terms.timeZone,
  });

  return { stores, cookie: `nff_session=${session.id}` };
};

// Each capture is answered by the next of `answers`: "declined", or a
// completed capture.
const fakePaypal = (answers) => {
  const calls = [];
  const paypal = {
    createOrder: async (order, key) => {
      calls.push(["create", key]);

      return { paypalOrderId: "PPO" };
    },
    // Approved again in the restarted sheet, and left alone since.
    getOrder: async (id) => ({
      paypalOrderId: id, status: "APPROVED", updatedAt: now.toISOString(),
    }),
    captureOrder: async (id, key) => {
      calls.push(["capture", key, id]);
      if (answers.shift() === "declined") {
        throw new PayPalError("PayPal 422", {
          status: 422, declined: true, code: "INSTRUMENT_DECLINED",
        });
      }

      return {
        paypalOrderId: id, paypalCaptureId: "CAP", status: "COMPLETED",
        amount: 3500, payer: { email: "pat@venmo", name: "Pat" },
      };
    },
  };

  return { paypal, calls };
};

const fakeSquare = () => {
  const keys = [];
  const square = {
    createOrder: async (order, key) => {
      keys.push(key);

      return { squareOrderId: "SQO", customerId: "CUST" };
    },
    createPayment: async () => ({
      squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
    }),
    cancelOrder: async () => ({}),
    findPaid: async () => null,
  };

  return { square, keys };
};

const send = (ctx, payment, fakes) => placeOrder(
  new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: ctx.cookie },
    body: JSON.stringify(body(payment)),
  }),
  {
    stores: ctx.stores, now, env, mail: async () => ({}),
    sleep: async () => {}, ...fakes,
  }
);

describe("a Venmo capture after the restart (#721)", () => {
  it("gives the credit back each time it is declined, and keeps the " +
    "checkout for the restart", async () => {
    const ctx = await member();
    const { paypal, calls } = fakePaypal(["declined", "declined"]);
    const { square } = fakeSquare();
    const capture = { stage: "capture", paypalOrderId: "PPO" };

    assert.equal((await send(ctx, { stage: "create" }, { paypal, square }))
      .status, 200);

    const first = await send(ctx, capture, { paypal, square });

    assert.equal(first.status, 402);
    assert.equal((await first.json()).code, "INSTRUMENT_DECLINED");
    assert.equal(await creditBalance(ctx.stores, EMAIL, now), 2000);
    assert.equal(await readCount(ctx.stores, "declined", DAY), 1);
    assert.ok(await getCheckout(ctx.stores, KEY), "kept for the restart");

    const second = await send(ctx, { ...capture, restart: true },
      { paypal, square });

    assert.equal(second.status, 402);
    assert.equal(await creditBalance(ctx.stores, EMAIL, now), 2000);
    assert.equal(await readCount(ctx.stores, "declined", DAY), 2);

    const captures = calls.filter((c) => c[0] === "capture");

    assert.equal(captures.length, 2);
    assert.notEqual(captures[1][1], captures[0][1],
      "the restart's capture has a request id of its own");
  });

  it("captures under a fresh request id and records the order as any " +
    "capture does", async () => {
    const ctx = await member();
    const { paypal, calls } = fakePaypal(["declined"]);
    const { square, keys } = fakeSquare();
    const capture = { stage: "capture", paypalOrderId: "PPO" };

    await send(ctx, { stage: "create" }, { paypal, square });
    assert.equal((await send(ctx, capture, { paypal, square })).status, 402);

    const paid = await send(ctx, { ...capture, restart: true },
      { paypal, square });
    const data = await paid.json();

    assert.equal(paid.status, 200, JSON.stringify(data));
    assert.equal(data.status, "paid");
    assert.deepEqual(calls.filter((c) => c[0] === "capture").map((c) => c[1]),
      [attemptKey(KEY, 1), `${attemptKey(KEY, 1)}-restart`]);
    // Square's keys are the attempt's, as for any capture.
    assert.deepEqual(keys, [attemptKey(KEY, 1)]);
    assert.equal(await creditBalance(ctx.stores, EMAIL, now), 0);
    assert.equal(await getCheckout(ctx.stores, KEY), null);

    const saved = await getOrder(ctx.stores, data.orderId);

    assert.equal(saved.meta.attempt, 1);
    assert.equal(saved.payments[0].paypalCaptureId, "CAP");
    assert.equal(JSON.stringify(saved).includes("restart"), false,
      "the record carries no mark of the restart");
  });
});

// The buyer is declined once, approves again in the restarted sheet,
// and closes the tab before the page's capture lands: the jobs' sweep
// finds the checkout and must capture under the restart's id, since
// PayPal may replay the decline for the first one (QA and security,
// round two of #721).
describe("the jobs' rescue of a restarted Venmo checkout (#721)", () => {
  const later = new Date(now.getTime() + PAGE_GRACE);
  const rescue = (ctx, fakes) => getCheckout(ctx.stores, KEY)
    .then((checkout) => rescueCheckout(ctx.stores, checkout, {
      env, mail: async () => ({}), sleep: async () => {}, ...fakes,
      now: later,
    }));

  it("captures under the restart's id once the first capture was " +
    "declined", async () => {
    const ctx = await member();
    const { paypal, calls } = fakePaypal(["declined"]);
    const { square } = fakeSquare();

    await send(ctx, { stage: "create" }, { paypal, square });
    assert.equal((await send(ctx, { stage: "capture", paypalOrderId: "PPO" },
      { paypal, square })).status, 402);
    assert.equal((await getCheckout(ctx.stores, KEY)).restarted, true,
      "the decline marks the checkout");

    const saved = await rescue(ctx, { paypal, square });

    assert.equal(saved.status, "paid");
    assert.deepEqual(calls.filter((c) => c[0] === "capture").map((c) => c[1]),
      [attemptKey(KEY, 1), `${attemptKey(KEY, 1)}-restart`]);
    assert.equal(await creditBalance(ctx.stores, EMAIL, now), 0);
    assert.equal(await getCheckout(ctx.stores, KEY), null);
  });

  it("tries the restart's id once when the first id is declined and " +
    "the checkout carries no mark", async () => {
    const ctx = await member();
    const { paypal, calls } = fakePaypal(["declined", "declined"]);
    const { square } = fakeSquare();

    await send(ctx, { stage: "create" }, { paypal, square });
    await send(ctx, { stage: "capture", paypalOrderId: "PPO" },
      { paypal, square });

    // A checkout the mark never reached.
    const { restarted, ...unmarked } = await getCheckout(ctx.stores, KEY);

    assert.equal(restarted, true);
    await ctx.stores.orders.set(`checkout/${KEY}`, unmarked);

    const saved = await rescue(ctx, { paypal, square });
    const k = attemptKey(KEY, 1);

    assert.equal(saved.status, "paid");
    assert.deepEqual(calls.filter((c) => c[0] === "capture").map((c) => c[1]),
      [k, k, `${k}-restart`]);
    assert.equal(await creditBalance(ctx.stores, EMAIL, now), 0);
  });
});

// A new attempt of the submission starts while the first attempt's
// capture is in flight, so the first checkout is archived before its
// decline is marked. The mark must land on the archive and leave the
// new attempt in the latest slot (security's and QA's probes, round
// three of #721).
describe("the restarted mark when a new attempt starts first (#721)", () => {
  const order = { id: "ORD-1", totals: { total: 1500 } };
  const stored = (attempt, paypalOrderId) => ({
    key: KEY, attempt, at: now.toISOString(), order, paypalOrderId,
  });
  const declinedAfter = (stores) => ({
    captureOrder: async () => {
      await saveCheckout(stores, stored(2, "PP2"));
      throw new PayPalError("declined", {
        declined: true, code: "INSTRUMENT_DECLINED",
      });
    },
  });

  it("marks the archived attempt and keeps the new one latest",
    async () => {
      const stores = testStores();

      await saveCheckout(stores, stored(1, "PP1"));
      await assert.rejects(finishVenmo(stores, order, {
        key: KEY, attempt: 1, paypalOrderId: "PP1",
      }, { paypal: declinedAfter(stores), sleep: async () => {}, now }),
      (error) => error.code === "INSTRUMENT_DECLINED");

      const latest = await getCheckout(stores, KEY);
      const first = await checkoutByPayPal(stores, "PP1", KEY);

      assert.equal(latest.paypalOrderId, "PP2");
      assert.equal(latest.restarted, undefined);
      assert.equal((await getCheckout(stores, KEY, "PP2")).paypalOrderId,
        "PP2");
      assert.equal(first.paypalOrderId, "PP1");
      assert.equal(first.archived, true);
      assert.equal(first.restarted, true);
    });

  it("marks nothing when the checkout is gone", async () => {
    const stores = testStores();
    const checkout = await saveCheckout(stores, stored(1, "PP1"));

    await stores.orders.delete(`checkout/${KEY}`);
    await stores.orders.delete(`by-paypal/PP1`);

    assert.equal(await markCheckout(stores, checkout, { restarted: true }),
      null);
    assert.equal(await getCheckout(stores, KEY), null);
  });
});
