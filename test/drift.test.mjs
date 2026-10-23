// Orders changed in Square itself (#293): detected by webhook and by
// the daily reconcile, flagged to the farm, and never copied into the
// record or charged.

/* eslint-disable camelcase -- Square names its fields its way */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  RECONCILE_MAX, SETTLE, applyOrderEvent, checkOrder, differences,
  driftKey, reconcile,
} from "../netlify/functions/lib/drift.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { PRINTED } from "../netlify/functions/lib/packing.mjs";
import { getOrder, saveOrder } from "../netlify/functions/lib/records.mjs";
import { buildOrder } from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/square-webhook.mjs";

const now = new Date("2026-10-23T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const FARM = { FARM_NOTIFICATIONS_EMAIL: "farm@example.com" };

const order = (id = "NFF-2026-AAAA", fields = {}) => ({
  id,
  status: "paid",
  submittedAt: "2026-10-20T12:00:00Z",
  paidAt: "2026-10-20T12:00:00Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [
    { sku: "EGG", name: "Eggs", label: "Eggs", qty: 2, unitPrice: 7 },
    { sku: "HON", name: "Honey", label: "Honey", qty: 1, unitPrice: 12 },
  ],
  totals: { subtotal: 26, discountAmount: 0, deliveryFee: 0, total: 26 },
  fulfilment: {
    method: "delivery",
    date: "2026-10-28",
    delivery: {
      address1: "1 Farm Rd", town: "Scituate", state: "RI", zip: "02857",
      cooler: "yes",
    },
  },
  flags: {},
  square: { squareOrderId: "SQ-1", customerId: "C-1" },
  payments: [{
    via: "square", method: "card", amount: 26, squarePaymentId: "PAY-1",
  }],
  history: [{ at: "2026-10-20T12:00:00Z", event: "paid" }],
  ...fields,
});

// Square's copy of a record, as Square would hold it, then `change`d.
const squareCopy = (record, change = (o) => o) => {
  const built = buildOrder(record, "C-1", { locationId: "L", catalog: false });

  return change({
    ...built,
    id: record.square.squareOrderId,
    state: "OPEN",
    fulfillments: built.fulfillments.map((f) => ({ ...f, state: "PROPOSED" })),
  });
};

const squareOf = (copies) => ({
  getOrder: async (id) => copies[id] || null,
});

const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

const opts = (record, change, extra = {}) => {
  const box = mailbox();

  return {
    box,
    options: {
      env: FARM, now, mail: box.mail,
      square: squareOf({ [record.square.squareOrderId]:
        squareCopy(record, change) }),
      ...extra,
    },
  };
};

const shift = (iso, days) => new Date(Date.parse(iso) + days * DAY)
  .toISOString();

describe("differences", () => {
  it("finds none when Square is as the site sent it", () => {
    const o = order();
    const copy = squareCopy(o);

    assert.deepEqual(differences(o, { original: copy, carrier: copy }), []);
  });

  it("finds a line changed in Square", () => {
    const o = order();
    const copy = squareCopy(o, (s) => ({
      ...s,
      line_items: [
        { ...s.line_items[0], quantity: "3" },
        { name: "Jam", quantity: "1" },
      ],
    }));
    const found = differences(o, { original: copy, carrier: copy });

    assert.deepEqual(found, [
      "Eggs: 2 on the site, 3 in Square",
      "Honey: 1 on the site, not in Square",
      "1 × Jam in Square, not on the site",
    ]);
  });

  it("finds a date moved in Square", () => {
    const o = order();
    const copy = squareCopy(o, (s) => {
      const f = s.fulfillments[0];

      f.delivery_details.deliver_at =
        shift(f.delivery_details.deliver_at, 2);

      return s;
    });

    const out = differences(o, { original: copy, carrier: copy });

    assert.equal(out.length, 1);
    assert.match(out[0], /^Date: .*28.* on the site, .*30.* in Square$/);
  });

  it("finds a cancel made in Square", () => {
    const o = order();
    const copy = squareCopy(o, (s) => ({ ...s, state: "CANCELED" }));

    assert.deepEqual(differences(o, { original: copy, carrier: copy }), [
      "Canceled in Square; still paid and open on the site",
    ]);
  });

  it("finds a fulfilment canceled in Square", () => {
    const o = order();
    const copy = squareCopy(o, (s) => {
      s.fulfillments[0].state = "CANCELED";

      return s;
    });

    assert.equal(differences(o, { original: copy, carrier: copy }).length, 1);
  });

  it("finds a changed delivery address", () => {
    const o = order();
    const copy = squareCopy(o, (s) => {
      s.fulfillments[0].delivery_details.recipient.address
        .address_line_1 = "9 Other St";

      return s;
    });

    assert.deepEqual(differences(o, { original: copy, carrier: copy }), [
      "Delivery address changed in Square",
    ]);
  });

  it("compares only the fulfilment on an order the customer changed", () => {
    const o = order("NFF-2026-BBBB", {
      edits: [{ at: "2026-10-21T12:00:00Z" }],
    });
    const copy = squareCopy(o, (s) => ({ ...s, line_items: [] }));

    assert.deepEqual(differences(o, { original: copy, carrier: copy }), []);
  });
});

describe("checkOrder", () => {
  it("is quiet when Square matches", async () => {
    const stores = testStores();
    const o = order();
    const { box, options } = opts(o);
    const r = await checkOrder(stores, o, options);

    assert.equal(r.status, "match");
    assert.equal(box.sent.length, 0);
  });

  it("emails the farm once for a change, and keeps the record", async () => {
    const stores = testStores();
    const o = order();

    await saveOrder(stores, o, now);

    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));
    const r = await checkOrder(stores, o, options);
    const again = await checkOrder(stores, o, options);

    assert.equal(r.status, "flagged");
    assert.equal(again.status, "known");
    assert.equal(box.sent.length, 1);
    assert.deepEqual(box.sent[0].to, ["farm@example.com"]);
    assert.match(box.sent[0].subject, /Changed in Square: NFF-2026-AAAA/);
    assert.match(box.sent[0].text, /No slip has printed/);

    const kept = await getOrder(stores, o.id);

    assert.equal(kept.status, "paid");
    assert.deepEqual(kept.payments, o.payments);
    assert.equal(kept.refunds, undefined);
  });

  it("mails once when two events race for one change", async () => {
    const stores = testStores();
    const o = order();
    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));
    const both = await Promise.all([
      checkOrder(stores, o, options),
      checkOrder(stores, o, options),
    ]);

    assert.equal(box.sent.length, 1);
    assert.deepEqual(both.map((r) => r.status).sort(), ["flagged", "known"]);
  });

  it("releases the claim when the mail fails", async () => {
    const stores = testStores();
    const o = order();
    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));

    await assert.rejects(checkOrder(stores, o, {
      ...options, mail: async () => { throw new Error("down"); },
    }), /down/);
    assert.equal(await stores.jobs.get(driftKey(o.id)), null);

    const r = await checkOrder(stores, o, options);

    assert.equal(r.status, "flagged");
    assert.equal(box.sent.length, 1);
  });

  it("says when a slip has already printed", async () => {
    const stores = testStores();
    const o = order();

    await stores.jobs.set(`${PRINTED}${o.id}`, { id: o.id });

    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));
    const r = await checkOrder(stores, o, options);

    assert.equal(r.printed, true);
    assert.match(box.sent[0].text, /already printed/);
  });

  it("tells the farm again when the difference changes", async () => {
    const stores = testStores();
    const o = order();
    const first = opts(o, (s) => ({
      ...s, line_items: [{ ...s.line_items[0], quantity: "3" },
        s.line_items[1]],
    }));

    await checkOrder(stores, o, first.options);
    await checkOrder(stores, o, {
      ...first.options,
      square: squareOf({ "SQ-1": squareCopy(o, (s) => ({
        ...s, state: "CANCELED",
      })) }),
    });

    assert.equal(first.box.sent.length, 2);
  });

  it("forgets a difference that is put right", async () => {
    const stores = testStores();
    const o = order();
    const bad = opts(o, (s) => ({ ...s, state: "CANCELED" }));

    await checkOrder(stores, o, bad.options);
    assert.ok(await stores.jobs.get(driftKey(o.id)));

    await checkOrder(stores, o, {
      ...bad.options, square: squareOf({ "SQ-1": squareCopy(o) }),
    });
    assert.equal(await stores.jobs.get(driftKey(o.id)), null);
  });

  it("waits out a change the site just made itself", async () => {
    const stores = testStores();
    const o = order("NFF-2026-CCCC", {
      history: [{ at: new Date(now.getTime() - SETTLE / 2).toISOString(),
        event: "edit" }],
    });
    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));
    const r = await checkOrder(stores, o, options);

    assert.equal(r.status, "settling");
    assert.equal(box.sent.length, 0);
    assert.equal(await stores.jobs.get(driftKey(o.id)), null);
  });

  it("ignores orders that are not paid", async () => {
    const stores = testStores();
    const o = order("NFF-2026-DDDD", { status: "cancelled" });
    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));

    assert.equal((await checkOrder(stores, o, options)).status, "skipped");
    assert.equal(box.sent.length, 0);
  });
});

describe("applyOrderEvent", () => {
  const event = (id) => ({
    type: "order.updated",
    data: { object: { order_updated: { order_id: id, state: "CANCELED" } } },
  });

  it("finds the record by the reference Square holds", async () => {
    const stores = testStores();
    const o = order();

    await saveOrder(stores, o, now);

    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));
    const r = await applyOrderEvent(stores, event("SQ-1"), options);

    assert.deepEqual([r.handled, r.status, r.id],
      [true, "flagged", "NFF-2026-AAAA"]);
    assert.equal(box.sent.length, 1);
  });

  it("leaves an order the site did not make alone", async () => {
    const stores = testStores();
    const r = await applyOrderEvent(stores, event("POS-1"), {
      env: FARM, now,
      square: squareOf({ "POS-1": { id: "POS-1", reference_id: "walk-in" } }),
    });

    assert.equal(r.handled, false);
  });
});

describe("the webhook", () => {
  const URL = "https://x/api/square/webhook";
  const env = {
    ...FARM, SQUARE_WEBHOOK_SIGNATURE_KEY: "k", SQUARE_WEBHOOK_URL: URL,
  };
  const send = (stores, body, extra) => {
    const text = JSON.stringify(body);

    return handle(new Request(URL, {
      method: "POST",
      headers: { "x-square-hmacsha256-signature":
        createHmac("sha256", "k").update(URL + text).digest("base64") },
      body: text,
    }), { stores, env, now, ...extra });
  };

  it("flags a Square cancel and answers 200", async () => {
    const stores = testStores();
    const o = order();

    await saveOrder(stores, o, now);

    const { box, options } = opts(o, (s) => ({ ...s, state: "CANCELED" }));
    const res = await send(stores, {
      type: "order.fulfillment.updated",
      data: { object: { order_fulfillment_updated: { order_id: "SQ-1" } } },
    }, { mail: box.mail, square: options.square });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.status, "flagged");
    assert.equal(box.sent.length, 1);
  });
});

describe("reconcile", () => {
  it("checks the paid orders from today on and flags the changed", async () => {
    const stores = testStores();
    const a = order("NFF-2026-AAAA");
    const b = order("NFF-2026-BBBB", {
      square: { squareOrderId: "SQ-2" },
    });
    const past = order("NFF-2026-EEEE", {
      square: { squareOrderId: "SQ-3" },
      fulfilment: { ...order().fulfilment, date: "2026-10-01" },
    });

    for (const o of [a, b, past]) await saveOrder(stores, o, now);

    const box = mailbox();
    const r = await reconcile(stores, {
      env: FARM, now, mail: box.mail,
      square: squareOf({
        "SQ-1": squareCopy(a),
        "SQ-2": squareCopy(b, (s) => ({ ...s, state: "CANCELED" })),
      }),
    });

    assert.equal(r.checked, 2);
    assert.deepEqual(r.found.map((f) => [f.id, f.status]),
      [["NFF-2026-BBBB", "flagged"]]);
    assert.equal(box.sent.length, 1);
    assert.ok(RECONCILE_MAX > 0);
  });

  it("runs once a day from the jobs, from 7:00", async () => {
    const stores = testStores();
    const o = order();

    await saveOrder(stores, o, now);

    const box = mailbox();
    const square = squareOf({
      "SQ-1": squareCopy(o, (s) => ({ ...s, state: "CANCELED" })),
    });
    const env = { ...FARM, SQUARE_ACCESS_TOKEN: "t" };
    const run = (at) => runJobs(stores, {
      now: at, realNow: at, env, mail: box.mail, square,
    });
    const early = await run(new Date("2026-10-23T09:00:00Z"));
    const first = await run(new Date("2026-10-23T12:00:00Z"));
    const second = await run(new Date("2026-10-23T13:00:00Z"));
    const drift = box.sent.filter((m) => /Changed in Square/.test(m.subject));

    assert.equal(early.drift, null);
    assert.equal(first.drift.flagged, 1);
    assert.equal(second.drift, null);
    assert.equal(drift.length, 1);
  });
});
