// A member's Thursday delivery to the group's place (#471): a delivery
// like any other, to the place's address, with the usual minimum and
// fee, tagged with the round after its day (James, 6406932945,
// 6407008800).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { groupOf, setGroupCode } from "../netlify/functions/lib/groups.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h = 9, m = 0) => instant(iso, h, m, "America/New_York");
// Monday 2026-11-02: Thursday the 5th is the next delivery day, and
// the round after it is Sunday the 8th.
const now = ny("2026-11-02");
const VFF = groupOf("vff");
const GYM = terms.model.location(VFF.location);
const SKU = "NFF-CHK-WHL-35-39";
const index = indexCatalog(catalog);
const schedule = Object.assign(parseSchedule(SCHEDULE).windows,
  { lines: parseSchedule(SCHEDULE).lines });
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};

const payload = (delivery, extra = {}) => ({
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "text",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment: { method: "delivery", date: "2026-11-05", delivery },
  // $60 less the $5 tier, plus the $5 fee.
  claimedTotal: 6000,
  ...extra,
});

describe("a delivery to the group's place", () => {
  it("takes the place's address, never the payload's", () => {
    const result = validateOrder(payload({
      toGroup: true, address1: "9 Elsewhere St", town: "Nowhere",
      zip: "02825", cooler: "",
    }), { index, terms, now, schedule, deliverTo: GYM });

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const d = result.order.fulfilment.delivery;

    assert.equal(d.address1, GYM.street);
    assert.equal(d.town, GYM.city);
    assert.equal(d.zip, GYM.zip);
    assert.equal(d.state, "RI");
    assert.equal(d.zipStatus, "approved");
    assert.equal(d.toGroup, true);
    // Draft wording.
    assert.equal(d.cooler, `The cooler at ${GYM.name}`);
    // The usual fee: $60 is under the $150 free-delivery line.
    assert.equal(result.order.totals.deliveryFee, 500);
    assert.equal(result.order.totals.total, 6000);
  });

  it("keeps a cooler note the member gives", () => {
    const result = validateOrder(payload({
      toGroup: true, cooler: "Front desk, ask for the blue cooler",
    }), { index, terms, now, schedule, deliverTo: GYM });

    assert.equal(result.order.fulfilment.delivery.cooler,
      "Front desk, ask for the blue cooler");
  });

  it("holds a member to the delivery minimum like anyone", () => {
    const result = validateOrder(payload({ toGroup: true }, {
      lines: [{ sku: "NFF-CHK-EGG-LG", qty: 1 }], claimedTotal: 1200,
    }), { index, terms, now, schedule, deliverTo: GYM });

    assert.equal(result.ok, false);
    assert.match(result.errors["delivery.minimum"], /Delivery requires/);
  });

  it("means nothing without the group: the address is the customer's",
    () => {
      const result = validateOrder(payload({
        toGroup: true, address1: "1 Main St", town: "Foster", zip: "02825",
        cooler: "Porch",
      }), { index, terms, now, schedule });

      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.order.fulfilment.delivery.address1, "1 Main St");
      assert.equal(result.order.fulfilment.delivery.toGroup, undefined);
    });
});

describe("placed through POST /api/orders", () => {
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createPayment: async (args) => ({
      squarePaymentId: `PAY-${args.squareOrderId}`, status: "COMPLETED",
      receiptUrl: null, brand: "VISA", last4: "4242", wallet: null,
    }),
  };
  const send = (stores, body) => placeOrder(
    new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
        payment: { method: "card", sourceId: "cnon:tok" },
        ...body,
      }),
    }),
    { stores, square, now, env, mail: async () => ({}),
      sleep: async () => {} }
  );

  it("is tagged with the round after its Thursday", async () => {
    const stores = testStores();

    await setGroupCode(stores, "vff", { code: "GYM-2026", now });

    const res = await send(stores, payload({ toGroup: true },
      { groupCode: "GYM-2026" }));
    const data = await res.json();

    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.fulfilment.method, "delivery");
    assert.equal(data.fulfilment.date, "2026-11-05");
    assert.equal(data.fulfilment.delivery.address1, GYM.street);
    assert.equal(data.totals.total, 6000);

    const order = await getOrder(stores, data.orderId);

    assert.deepEqual(order.group,
      { key: "vff", round: "2026-11-08", viaCode: true });
  });
});
