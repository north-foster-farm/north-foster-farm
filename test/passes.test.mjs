import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle, orderId } from "../netlify/functions/orders.mjs";
import { handle as lookup } from "../netlify/functions/passes.mjs";
import { publicOrder } from "../netlify/functions/lib/account.mjs";
import { planEdit } from "../netlify/functions/lib/edit.mjs";
import { rideAlongRiders } from "../netlify/functions/lib/admin.mjs";
import {
  HOLD_MS, PASS_DAYS, RIDE_ALONG_CAP, getPass, holdPass, issuePass,
  listPasses, newPassCode, passCodeOf, passProblem, passState, revokePass,
  ridesAlong, usePass,
} from "../netlify/functions/lib/passes.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { feeCell } from "../assets/scripts/order/lib/summary.mjs";
import { RIDE_ALONG_FEE } from "../assets/scripts/order/lib/totals.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const later = (ms) => new Date(now.getTime() + ms);
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const OTHER = "a1b2c3d4-0000-4000-8000-1a2b3c4d5e6f";
const SKU = "NFF-CHK-WHL-0350-0400";
const index = indexCatalog(catalog);
const schedule = parseSchedule(SCHEDULE).windows;

// One $30 chicken, delivered: $10 under the minimum. The $5 fee is
// charged as usual.
const small = (overrides = {}) => ({
  idempotencyKey: KEY,
  attempt: 1,
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty: 1 }],
  fulfilment: {
    method: "delivery",
    date: "2026-10-08",
    delivery: {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
  claimedTotal: 3500,
  payment: { method: "card", sourceId: "cnon:tok" },
  ...overrides,
});

const square = {
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createPayment: async () => ({
    squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
    brand: "VISA", last4: "4242", wallet: null,
  }),
  cancelOrder: async (id) => ({ id, cancelled: true }),
};

const post = (payload) => new Request("http://x/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const run = (stores, payload, options = {}) => handle(post(payload), {
  stores, square, now, sleep: async () => {},
  mail: async () => ({ id: "m", driver: "test" }), ...options,
});

// A fixed pick, so the codes are known.
const picks = (...codes) => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const queue = codes.join("").replace(/-/g, "").split("")
    .map((c) => chars.indexOf(c));

  return () => queue.shift();
};

describe("pass codes", () => {
  it("are eight unambiguous characters in two groups", () => {
    for (let i = 0; i < 50; i++) {
      assert.match(newPassCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    }
  });

  it("read as typed, with or without the hyphen, in any case", () => {
    assert.equal(passCodeOf("abcd-efgh"), "ABCD-EFGH");
    assert.equal(passCodeOf(" abcdefgh "), "ABCD-EFGH");
    assert.equal(passCodeOf("ABC"), "");
    assert.equal(passCodeOf(null), "");
  });
});

describe("issuePass", () => {
  it("stores a single-use pass that lifts the minimum, for PASS_DAYS",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, {
        email: " Pat@Example.com ", note: "gift", now,
        pick: picks("ABCD-EFGH"),
      });

      assert.equal(pass.code, "ABCD-EFGH");
      assert.deepEqual(pass.lifts, ["minimum"]);
      assert.equal(pass.email, "pat@example.com");
      assert.equal(pass.expiresAt, later(PASS_DAYS * 86_400_000)
        .toISOString());
      assert.deepEqual(await getPass(stores, "abcdefgh"), pass);
    });

  it("never reissues a code", async () => {
    const stores = testStores();

    await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

    const again = await issuePass(stores, {
      now, pick: picks("ABCD-EFGH", "JKMN-PQRS"),
    });

    assert.equal(again.code, "JKMN-PQRS");
    assert.equal((await listPasses(stores)).length, 2);
  });

  it("takes whole days only", async () => {
    await assert.rejects(issuePass(testStores(), { days: 1.5, now }),
      /whole number/);
    await assert.rejects(issuePass(testStores(), { days: 0, now }),
      /whole number/);
  });
});

describe("passProblem", () => {
  const pass = {
    code: "ABCD-EFGH", email: "pat@example.com",
    expiresAt: later(86_400_000).toISOString(),
    heldBy: null, heldAt: null, usedBy: null, revokedAt: null,
  };

  it("passes a good one, with or without the email", () => {
    assert.equal(passProblem(pass, { now }), null);
    assert.equal(passProblem(pass, { email: "PAT@example.com", now }), null);
  });

  it("names what is wrong", () => {
    assert.equal(passProblem(null, { now }), "unknown");
    assert.equal(passProblem({ ...pass, revokedAt: "x" }, { now }),
      "unknown");
    assert.equal(passProblem({ ...pass, usedBy: "NFF-1" }, { now }), "used");
    assert.equal(passProblem(pass, { now: later(2 * 86_400_000) }),
      "expired");
    assert.equal(passProblem(pass, { email: "sam@example.com", now }),
      "email");
  });

  it("lets its own order back in, used or held", () => {
    assert.equal(passProblem({ ...pass, usedBy: "NFF-1" }, {
      orderId: "NFF-1", now,
    }), null);

    const held = { ...pass, heldBy: "NFF-1", heldAt: now.toISOString() };

    assert.equal(passProblem(held, { orderId: "NFF-1", now }), null);
    assert.equal(passProblem(held, { orderId: "NFF-2", now }), "held");
    assert.equal(passProblem(held, {
      orderId: "NFF-2", now: later(HOLD_MS),
    }), null, "a hold lapses");
  });
});

describe("revokePass and usePass", () => {
  it("revoke an open pass, never a used one", async () => {
    const stores = testStores();
    const a = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });
    const b = await issuePass(stores, { now, pick: picks("JKMN-PQRS") });

    assert.ok((await revokePass(stores, a.code, now)).revokedAt);
    assert.equal(passState(await getPass(stores, a.code), now), "revoked");

    await usePass(stores, b.code, "NFF-1", now);
    await usePass(stores, b.code, "NFF-2", now);
    assert.equal((await getPass(stores, b.code)).usedBy, "NFF-1",
      "the first order keeps it");
    await assert.rejects(revokePass(stores, b.code, now), /used by NFF-1/);
    await assert.rejects(revokePass(stores, "ZZZZ-ZZZZ", now), /No pass/);
  });
});

describe("validateOrder's waiver", () => {
  const opts = { index, terms, now, schedule };

  it("lets a delivery under the minimum through and says so", () => {
    const blocked = validateOrder(small(), opts);
    const waived = validateOrder(small(), {
      ...opts, waive: { minimum: true },
    });

    assert.ok(blocked.errors["delivery.minimum"]);
    assert.equal(waived.ok, true);
    assert.equal(waived.order.flags.minimumWaived, true);
    assert.equal(waived.order.totals.deliveryFee, 500, "the fee stays");
  });

  it("waives nothing an order does not need", () => {
    const big = validateOrder(small({ lines: [{ sku: SKU, qty: 2 }] }), {
      ...opts, waive: { minimum: true },
    });

    assert.equal(big.order.flags.minimumWaived, false);
  });
});

describe("POST /api/orders with a pass", () => {
  it("takes a delivery under the minimum and uses the pass up",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });
      const res = await run(stores, small({ pass: "abcd efgh" }));
      const id = orderId(KEY, now);

      assert.equal(res.status, 200);
      assert.equal((await getOrder(stores, id)).pass, pass.code);
      assert.equal((await getOrder(stores, id)).totals.total, 3500);
      assert.equal((await getPass(stores, pass.code)).usedBy, id);

      // A second order cannot use it.
      const again = await run(stores, small({
        idempotencyKey: OTHER, pass: pass.code,
      }));

      assert.equal(again.status, 422);
      assert.equal((await again.json()).errors["delivery.minimum"],
        "That code has already been used.");
    });

  it("refuses a pass issued to another email", async () => {
    const stores = testStores();

    await issuePass(stores, {
      email: "sam@example.com", now, pick: picks("ABCD-EFGH"),
    });

    const res = await run(stores, small({ pass: "ABCD-EFGH" }));

    assert.equal(res.status, 422);
    assert.match((await res.json()).errors["delivery.minimum"],
      /different email/);
  });

  it("holds the pass while an order is paid, against another", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

    await holdPass(stores, pass, orderId(OTHER, now), now);

    const res = await run(stores, small({ pass: pass.code }));

    assert.equal(res.status, 422);
    assert.match((await res.json()).errors["delivery.minimum"], /in use/);
  });

  it("leaves the pass alone when the order meets the minimum",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });
      const res = await run(stores, small({
        lines: [{ sku: SKU, qty: 2 }], claimedTotal: 6000, pass: pass.code,
      }));

      assert.equal(res.status, 200);
      assert.equal((await getOrder(stores, orderId(KEY, now))).pass, null);
      assert.equal((await getPass(stores, pass.code)).usedBy, null);
      assert.equal((await getPass(stores, pass.code)).heldBy, null);
    });
});

describe("changing an order placed with a pass", () => {
  it("keeps the waiver, and the account page carries the pass",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

      await run(stores, small({ pass: pass.code }));

      const order = await getOrder(stores, orderId(KEY, now));
      const edit = (o) => planEdit(stores, o, {
        fulfilment: { date: "2026-10-15" }, claimedTotal: 3500,
      }, {
        now, index, terms, codes: [], group: null,
        validate: validateOrder, schedule,
      });
      const plan = await edit(order);

      assert.equal(plan.ok, true, JSON.stringify(plan.errors));
      assert.equal((await edit({ ...order, pass: null })).ok, false,
        "without its pass the order is under the minimum");
      assert.equal(publicOrder(order, now).pass, pass.code);
    });
});

describe("GET /api/pass", () => {
  const ask = (stores, code, options = {}) => lookup(
    new Request(`http://x/api/pass?code=${encodeURIComponent(code)}`),
    { stores, now, ...options },
  );

  it("says whether a pass is good, and nothing more", async () => {
    const stores = testStores();

    await issuePass(stores, {
      email: "pat@example.com", now, pick: picks("ABCD-EFGH"),
    });

    const good = await ask(stores, "abcd-efgh");

    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { ok: true });

    const bad = await ask(stores, "ZZZZ-ZZZZ");

    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).message, "Not a valid code.");
  });

  it("slows a script down", async () => {
    const stores = testStores();
    let last;

    for (let i = 0; i < 21; i++) {
      last = await ask(stores, "ZZZZ-ZZZZ", { ip: "203.0.113.9" });
    }
    assert.equal(last.status, 429);
  });
});

// A ride-along pass (#183): the farm's way to grant a delivery on a
// run it drives anyway, at no fee and no minimum, capped by customers
// a month.
describe("ride-along passes", () => {
  const ride = (stores, email = "pat@example.com", options = {}) =>
    issuePass(stores, {
      email, now, rideAlong: true, pick: picks("RYDE-AAAA"), ...options,
    });

  it("lift the fee as well as the minimum, for one email", async () => {
    const stores = testStores();
    const pass = await ride(stores);
    const plain = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

    assert.deepEqual(pass.lifts, ["minimum", "fee"]);
    assert.equal(ridesAlong(pass), true);
    assert.equal(ridesAlong(plain), false);
    await assert.rejects(ride(testStores(), null), /needs --email/);
  });

  it(`are refused past ${RIDE_ALONG_CAP} customers a month`, async () => {
    const riders = ["a@example.com", "b@example.com", "c@example.com"];

    await assert.rejects(ride(testStores(), "d@example.com", { riders }),
      /3 customers already ride along this month/);

    const again = await ride(testStores(), "B@example.com", { riders });

    assert.equal(again.email, "b@example.com", "a rider may ride again");
    assert.ok(await ride(testStores(), "d@example.com", {
      riders: riders.slice(1),
    }));
  });

  it("count the month's ride-along orders and open passes", async () => {
    const stores = testStores();

    await ride(stores);
    await run(stores, small({ pass: "RYDE-AAAA", claimedTotal: 3000 }));
    await ride(stores, "sam@example.com", { pick: picks("SAMR-YDES") });
    await revokePass(stores, (await ride(stores, "lee@example.com", {
      pick: picks("KEER-YDES"),
    })).code, now);
    await issuePass(stores, {
      email: "kim@example.com", now, pick: picks("KYMP-PPAN"),
    });

    assert.deepEqual((await rideAlongRiders(stores, now)).sort(),
      ["pat@example.com", "sam@example.com"]);
    assert.deepEqual(await rideAlongRiders(stores, later(40 * 86_400_000)),
      [], "another month, and the open pass has expired");
  });

  it("book a delivery under the minimum at no fee, and are used up",
    async () => {
      const stores = testStores();
      const pass = await ride(stores);
      const res = await run(stores, small({
        pass: pass.code, claimedTotal: 3000,
      }));
      const order = await getOrder(stores, orderId(KEY, now));

      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      assert.equal(order.fulfilment.rideAlong, true);
      assert.equal(order.totals.deliveryFee, 0);
      assert.equal(order.totals.total, 3000);
      assert.equal(order.pass, pass.code);
      assert.equal((await getPass(stores, pass.code)).usedBy, order.id);
    });

  it("are used by an order that meets the minimum too", async () => {
    const stores = testStores();
    const pass = await ride(stores);
    const res = await run(stores, small({
      lines: [{ sku: SKU, qty: 2 }], claimedTotal: 5500, pass: pass.code,
    }));

    assert.equal(res.status, 200);
    assert.equal((await getOrder(stores, orderId(KEY, now))).pass, pass.code);
  });

  it("say why when the page priced one the pass can't give", async () => {
    const stores = testStores();
    const pass = await ride(stores);

    await usePass(stores, pass.code, orderId(OTHER, now), now);

    const res = await run(stores, small({
      lines: [{ sku: SKU, qty: 2 }], claimedTotal: 5500, pass: pass.code,
    }));
    const body = await res.json();

    assert.equal(res.status, 422);
    assert.equal(body.errors.total, "That code has already been used.");
    assert.equal(body.totals.deliveryFee, 500);
  });

  it("are named to the page, and keep the order one through a change",
    async () => {
      const stores = testStores();
      const pass = await ride(stores);
      const good = await lookup(
        new Request(`http://x/api/pass?code=${pass.code}`), { stores, now },
      );

      assert.deepEqual(await good.json(), { ok: true, rideAlong: true });
      await run(stores, small({ pass: pass.code, claimedTotal: 3000 }));

      const order = await getOrder(stores, orderId(KEY, now));
      const plan = await planEdit(stores, order, {
        fulfilment: { date: "2026-10-15" }, claimedTotal: 3000,
      }, {
        now, index, terms, codes: [], group: null,
        validate: validateOrder, schedule,
      });

      assert.equal(plan.ok, true, JSON.stringify(plan.errors));
      assert.equal(publicOrder(order, now).fulfilment.rideAlong, true);
    });

  it("show their fee as a ride-along's on the page", () => {
    assert.deepEqual(feeCell({ subtotal: 3000, deliveryFee: 0,
      rideAlong: true }, "delivery"),
    { show: true, waived: true, text: RIDE_ALONG_FEE });
  });
});
