// #626 takes the "Deliver to <group>" option off the order page, but
// production may hold orders placed with it (#471): their record keeps
// `fulfilment.delivery.toGroup` and the group's place as the address.
// Criterion 3 of #626: such an order still displays, emails and edits
// as before. The stored order is made as production holds one, with no
// new order placed with the option, so this holds whether or not the
// server goes on accepting the option on new orders.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { publicOrder } from "../netlify/functions/lib/account.mjs";
import { editOrder } from "../netlify/functions/lib/edit.mjs";
import { groupOf, setGroupCode } from "../netlify/functions/lib/groups.mjs";
import { amendOrder, getOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

// Monday 2026-11-02: Thursday the 5th is the next delivery day.
const now = instant("2026-11-02", 9, 0, "America/New_York");
const GYM = terms.model.location(groupOf("vff").location);
const SKU = "NFF-CHK-WHL-35-39";
const EMAIL = "pat@example.com";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};
const quiet = { sleep: async () => {} };
const square = {
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createChangeOrder: async () => ({ squareOrderId: "SQC", customerId: "CUST" }),
  createPayment: async (args) => ({
    squarePaymentId: `PAY-${args.squareOrderId}`, status: "COMPLETED",
    receiptUrl: null, brand: "VISA", last4: "4242", wallet: null,
  }),
  payZeroOrder: async (id) => ({ squareOrderId: id }),
  updateFulfillment: async () => {},
  cancelFulfillment: async () => {},
  refundPayment: async () => ({ squareRefundId: "R", status: "COMPLETED" }),
};

// A member's ordinary delivery, placed with the group's code, then
// made into the record the option wrote at launch: the place's
// address, its cooler line and the tag.
const storedToGroup = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: "GYM-2026", now });

  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
      payment: { method: "card", sourceId: "cnon:tok" },
      customer: {
        firstName: "Pat", lastName: "Example", email: EMAIL,
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku: SKU, qty: 2 }],
      fulfilment: {
        method: "delivery", date: "2026-11-05",
        delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch" },
      },
      groupCode: "GYM-2026",
      claimedTotal: 6000,
    }),
  }), { stores, square, now, env, mail: async () => ({}), ...quiet });
  const data = await res.json();

  assert.equal(res.status, 200, JSON.stringify(data));

  const id = data.orderId;

  await amendOrder(stores, id, (order) => ({
    fulfilment: {
      ...order.fulfilment,
      delivery: {
        ...order.fulfilment.delivery,
        address1: GYM.street, address2: "", town: GYM.city, zip: GYM.zip,
        cooler: `The cooler at ${GYM.name}`, toGroup: true,
      },
    },
  }), "test.stored", now);

  return { stores, id };
};

const atPlace = (delivery) => {
  assert.equal(delivery.address1, GYM.street);
  assert.equal(delivery.town, GYM.city);
  assert.equal(delivery.zip, GYM.zip);
  assert.equal(delivery.cooler, `The cooler at ${GYM.name}`);
};

describe("an order placed with the group delivery option (#626)", () => {
  it("still displays, emails and edits as before", async () => {
    const { stores, id } = await storedToGroup();

    // Displays: the account's view of it is a delivery to the place.
    const shown = publicOrder(await getOrder(stores, id), now);

    assert.equal(shown.fulfilment.method, "delivery");
    atPlace(shown.fulfilment.delivery);

    // Edits: one more chicken, the delivery untouched, goes through
    // and leaves the delivery to the place as it was.
    const sent = [];
    const mail = async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    };
    const opts = { now, env, square, mail, ...quiet };
    const body = {
      idempotencyKey: "edit-key-000000-626",
      lines: [{ sku: SKU, qty: 3 }],
      payment: { method: "card", sourceId: "cnon:tok" },
    };
    let result = await editOrder(stores, { email: EMAIL }, id, body, opts);

    if (!result.ok && result.errors && result.errors.total) {
      result = await editOrder(stores, { email: EMAIL }, id, {
        ...body, claimedTotal: result.totals.total,
      }, opts);
    }

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "delivery");
    assert.equal(saved.fulfilment.date, "2026-11-05");
    atPlace(saved.fulfilment.delivery);
    assert.equal(saved.fulfilment.delivery.toGroup, true,
      "the stored record keeps its shape");
    assert.equal(saved.lines.find((l) => l.sku === SKU).qty, 3);
    assert.deepEqual(saved.group && saved.group.key, "vff");

    // Emails: the customer is told of the change, with the place's
    // address as the delivery's.
    const theirs = sent.filter((m) => m.to === EMAIL);

    assert.ok(theirs.length >= 1, "the customer is emailed");
    assert.ok(theirs.some((m) => `${m.text || ""}${m.html || ""}`
      .includes(GYM.street)), "the email names the place's address");
  });
});
