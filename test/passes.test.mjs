import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle } from "../netlify/functions/orders.mjs";
import { handle as lookup } from "../netlify/functions/passes.mjs";
import { publicOrder } from "../netlify/functions/lib/account.mjs";
import {
  buildOrder, settings,
} from "../netlify/functions/lib/square.mjs";
import { planEdit } from "../netlify/functions/lib/edit.mjs";
import {
  HOLD_MS, PASS_DAYS, PASS_MESSAGES, getPass, holdPass, issuePass,
  listPasses, newPassCode, passCodeOf, passProblem, passState, revokePass,
  usePass, waivesFee,
} from "../netlify/functions/lib/passes.mjs";
import { orderForSubmission } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { feeCell } from "../assets/scripts/order/lib/summary.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const later = (ms) => new Date(now.getTime() + ms);
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const OTHER = "a1b2c3d4-0000-4000-8000-1a2b3c4d5e6f";
const SKU = "NFF-CHK-WHL-35-39";
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
  findPaid: async () => null,
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

  it("lets the submission that holds it back in", () => {
    const held = { ...pass, heldBy: KEY, heldAt: now.toISOString() };

    assert.equal(passProblem(held, { holder: KEY, now }), null);
    assert.equal(passProblem(held, { holder: OTHER, now }), "held");
    assert.equal(passProblem(held, {
      holder: OTHER, now: later(HOLD_MS),
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
      const order = await orderForSubmission(stores, KEY);

      assert.equal(res.status, 200);
      assert.equal(order.pass, pass.code);
      assert.equal(order.totals.total, 3500);
      assert.equal((await getPass(stores, pass.code)).usedBy, order.id);

      // A second order cannot use it.
      const again = await run(stores, small({
        idempotencyKey: OTHER, pass: pass.code,
      }));

      assert.equal(again.status, 422);
      assert.equal((await again.json()).errors.pass,
        "That code isn't valid.");
    });

  it("refuses a pass issued to another email", async () => {
    const stores = testStores();

    await issuePass(stores, {
      email: "sam@example.com", now, pick: picks("ABCD-EFGH"),
    });

    const res = await run(stores, small({ pass: "ABCD-EFGH" }));

    assert.equal(res.status, 422);
    assert.equal((await res.json()).errors.pass,
      "That code isn't valid.");
    assert.equal((await orderForSubmission(stores, KEY)), null);
  });

  it("holds the pass while an order is paid, against another", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

    await holdPass(stores, pass, OTHER, now);

    const res = await run(stores, small({ pass: pass.code }));

    assert.equal(res.status, 422);
    assert.equal((await res.json()).errors.pass,
      "That code isn't valid.");
  });

  it("leaves the pass alone when the order meets the minimum",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });
      const res = await run(stores, small({
        lines: [{ sku: SKU, qty: 2 }], claimedTotal: 6000, pass: pass.code,
      }));

      assert.equal(res.status, 200);
      assert.equal((await orderForSubmission(stores, KEY)).pass, null);
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

      const order = await orderForSubmission(stores, KEY);
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
    assert.deepEqual(await good.json(), { ok: true, waivesFee: false });

    const bad = await ask(stores, "ZZZZ-ZZZZ");

    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).message, "That code isn't valid.");
  });

  it("lets the submission that holds a pass see it as good",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

      await holdPass(stores, pass, KEY, now);
      assert.equal((await ask(stores, pass.code)).status, 404);

      const mine = await lookup(new Request(
        `http://x/api/pass?code=${pass.code}&holder=${KEY}`
      ), { stores, now });

      assert.equal(mine.status, 200);
    });

  it("says whether it waives the fee too", async () => {
    const stores = testStores();

    await issuePass(stores, {
      now, waiveFee: true, pick: picks("ABCD-EFGH"),
    });
    await issuePass(stores, { now, pick: picks("JKMN-PQRS") });

    assert.deepEqual(await (await ask(stores, "ABCD-EFGH")).json(),
      { ok: true, waivesFee: true });
    assert.deepEqual(await (await ask(stores, "JKMN-PQRS")).json(),
      { ok: true, waivesFee: false });
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

// James's wording (on #182): one refusal for every code that doesn't
// work. The farm's list keeps the reason.
describe("the refusals", () => {
  it("are one sentence, whatever the reason", () => {
    assert.deepEqual(new Set(Object.values(PASS_MESSAGES)),
      new Set(["That code isn't valid."]));
  });

  it("leave the reason to the farm's list", () => {
    const pass = {
      code: "ABCD-EFGH", expiresAt: later(86_400_000).toISOString(),
    };

    assert.equal(passState({ ...pass, usedBy: "NFF-1" }, now),
      "used by NFF-1");
    assert.equal(passState(pass, later(2 * 86_400_000)), "expired");
  });
});

// A standing pass (6333265908): one email, every order, never used up.
describe("standing passes", () => {
  const standing = (stores, options = {}) => issuePass(stores, {
    email: "pat@example.com", standing: true, days: null, now,
    pick: picks("ABCD-EFGH"), ...options,
  });

  it("need an email, and never expire unless given days", async () => {
    await assert.rejects(issuePass(testStores(), {
      standing: true, days: null, now,
    }), /needs --email/);
    await assert.rejects(issuePass(testStores(), { days: null, now }),
      /whole number/, "a single-use pass always expires");

    const open = await standing(testStores());

    assert.equal(open.standing, true);
    assert.equal(open.expiresAt, null);
    assert.equal(passProblem(open, { now: later(3650 * 86_400_000) }), null);
    assert.equal(passState(open, now), "standing");

    const dated = await standing(testStores(), { days: 30 });

    assert.equal(passState(dated, now),
      `standing until ${dated.expiresAt.slice(0, 10)}`);
  });

  it("let every order from its email under the minimum", async () => {
    const stores = testStores();
    const pass = await standing(stores);

    for (const key of [KEY, OTHER]) {
      const res = await run(stores, small({
        idempotencyKey: key, pass: pass.code,
      }));

      assert.equal(res.status, 200, key);
      assert.equal((await orderForSubmission(stores, key)).pass, pass.code);
    }

    const after = await getPass(stores, pass.code);

    assert.equal(after.usedBy, null, "never used up");
    assert.equal(after.heldBy, null, "never held");
  });

  it("refuse another email with the generic words", async () => {
    const stores = testStores();
    const pass = await standing(stores);
    const res = await run(stores, small({
      pass: pass.code,
      customer: { ...small().customer, email: "sam@example.com" },
    }));

    assert.equal(res.status, 422);
    assert.equal((await res.json()).errors.pass,
      "That code isn't valid.");
  });

  it("answer a refused code before the total, over the minimum too",
    async () => {
      const stores = testStores();
      const pass = await standing(stores, {
        email: "sam@example.com", waiveFee: true,
      });
      // Two chickens, $5 off; the page took the fee off, so it claims
      // $55 where the server, without the code, makes it $60.
      const res = await run(stores, small({
        lines: [{ sku: SKU, qty: 2 }], claimedTotal: 5500, pass: pass.code,
      }));

      assert.equal(res.status, 422);
      assert.deepEqual((await res.json()).errors,
        { pass: "That code isn't valid." });
    });

  it("leave a pickup alone: a code lifts nothing there", async () => {
    const stores = testStores();
    const pass = await standing(stores, { email: "sam@example.com" });
    const res = await run(stores, small({
      pass: pass.code, claimedTotal: 3000,
      fulfilment: {
        method: "onfarm", date: "2026-10-07",
        onfarm: { window: MORNING },
      },
    }));

    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal((await orderForSubmission(stores, KEY)).pass, null);
  });

  it("end when revoked, and the list shows them", async () => {
    const stores = testStores();
    const pass = await standing(stores);

    await revokePass(stores, pass.code, now);

    const res = await run(stores, small({ pass: pass.code }));

    assert.equal(res.status, 422);
    assert.equal(passState((await listPasses(stores))[0], now), "revoked");
  });
});

// --waive-fee (6333306849): the fee line at $0, a $0 service charge in
// Square, no discount line. Ride-along customers get a standing one.
describe("passes that waive the fee", () => {
  const money = terms.money;
  const totalsOf = (qty, waiveFee, zipStatus = "listed") => computeTotals({
    lines: [{ sku: SKU, qty }], method: "delivery", index, money,
    zipStatus, waiveFee,
  });

  it("take the fee and the outside-area fee off, and say so", () => {
    const t = totalsOf(1, true, "unlisted");

    assert.equal(t.deliveryFee, 0);
    assert.equal(t.areaFee, 0);
    assert.equal(t.feeWaived, true);
    assert.equal(t.discountAmount, 0, "no discount line");
    assert.equal(t.total, 3000);
    assert.deepEqual(feeCell(t, "delivery"),
      { show: true, waived: true, text: "$0" });
  });

  it("leave an order with no fee to waive as it was", () => {
    assert.deepEqual(totalsOf(5, true), totalsOf(5, false));
    assert.equal("feeWaived" in totalsOf(1, false), false);
  });

  it("send the delivery to Square as a $0 charge", () => {
    const t = totalsOf(1, true);
    const built = buildOrder({
      id: "NFF-2610-ABCD",
      customer: { name: "Pat Example", email: "pat@example.com" },
      fulfilment: {
        method: "delivery", date: "2026-10-08",
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch",
        },
      },
      lines: [{
        sku: SKU, name: "Whole Chicken", unitPrice: 30, qty: 1,
        lineTotal: 30, squareVariationId: null,
      }],
      totals: t,
      flags: { zipUnlisted: false },
    }, "CUST", settings({
      SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC",
      SQUARE_ENV: "sandbox",
    }));

    assert.deepEqual(built.service_charges.map((c) => [
      c.name, c.amount_money.amount,
    ]), [["Delivery fee", 0]]);
    assert.equal(built.discounts, undefined);
  });

  it("are issued from the CLI's flag and named in the list", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, {
      email: "pat@example.com", standing: true, days: null, waiveFee: true,
      now, pick: picks("ABCD-EFGH"),
    });

    assert.deepEqual(pass.lifts, ["minimum", "fee"]);
    assert.equal(waivesFee(pass), true);
    assert.equal(passState(pass, now), "standing, waives the fee");
  });

  it("charge an order under the minimum nothing for delivery",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, {
        email: "pat@example.com", standing: true, days: null, waiveFee: true,
        now, pick: picks("ABCD-EFGH"),
      });
      const res = await run(stores, small({
        pass: pass.code, claimedTotal: 3000,
      }));
      const order = await orderForSubmission(stores, KEY);

      assert.equal(res.status, 200);
      assert.equal(order.totals.deliveryFee, 0);
      assert.equal(order.totals.total, 3000);
      assert.equal(order.passWaivesFee, true);
      assert.equal(publicOrder(order, now).passWaivesFee, true);
    });

  it("waive the fee over the minimum too, for a standing pass",
    async () => {
      const stores = testStores();
      const pass = await issuePass(stores, {
        email: "pat@example.com", standing: true, days: null, waiveFee: true,
        now, pick: picks("ABCD-EFGH"),
      });
      const res = await run(stores, small({
        lines: [{ sku: SKU, qty: 2 }], claimedTotal: 6000 - 500,
        pass: pass.code,
      }));
      const order = await orderForSubmission(stores, KEY);

      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      assert.equal(order.totals.deliveryFee, 0);
      assert.equal(order.pass, pass.code);
    });

  it("keep the fee off when the order is changed", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, {
      now, waiveFee: true, pick: picks("ABCD-EFGH"),
    });

    await run(stores, small({ pass: pass.code, claimedTotal: 3000 }));

    const order = await orderForSubmission(stores, KEY);
    const plan = await planEdit(stores, order, {
      fulfilment: { date: "2026-10-15" }, claimedTotal: 3000,
    }, {
      now, index, terms, codes: [], group: null,
      validate: validateOrder, schedule,
    });

    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  });
});

// Security's race (#301): two submissions of one single-use pass on two
// function instances, interleaved. Each read and checked the pass
// before either wrote; the swap lets one hold it.
describe("holding a pass is a compare-and-swap", () => {
  it("lets one of two racing holds win", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });
    const [a, b] = await Promise.all([
      getPass(stores, pass.code), getPass(stores, pass.code),
    ]);

    assert.equal(passProblem(a, { holder: KEY, now }), null);
    assert.equal(passProblem(b, { holder: OTHER, now }), null);

    const held = await Promise.all([
      holdPass(stores, a, KEY, now), holdPass(stores, b, OTHER, now),
    ]);

    assert.equal(held.filter(Boolean).length, 1);
    assert.equal((await getPass(stores, pass.code)).heldBy,
      held[0] ? KEY : OTHER);
  });

  it("lets the same submission hold it again", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

    assert.ok(await holdPass(stores, pass, KEY, now));
    assert.ok(await holdPass(stores, pass, KEY, now));
  });

  it("refuses the order that loses, after the check passed", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });
    // Another instance holds it between this one's check and its hold.
    const orders = stores.orders;
    const swap = orders.swap;

    orders.swap = async (...args) => {
      orders.swap = swap;
      await holdPass(stores, pass, OTHER, now);

      return swap(...args);
    };

    const res = await run(stores, small({ pass: pass.code }));

    assert.equal(res.status, 422);
    assert.equal((await res.json()).errors.pass,
      "That code isn't valid.");
    assert.equal(await orderForSubmission(stores, KEY), null);
    assert.equal((await getPass(stores, pass.code)).heldBy, OTHER);
  });

  it("uses a pass once, whichever order is first", async () => {
    const stores = testStores();
    const pass = await issuePass(stores, { now, pick: picks("ABCD-EFGH") });

    await Promise.all([
      usePass(stores, pass.code, "NFF-1", now),
      usePass(stores, pass.code, "NFF-2", now),
    ]);
    assert.equal((await getPass(stores, pass.code)).usedBy, "NFF-1");
  });
});

