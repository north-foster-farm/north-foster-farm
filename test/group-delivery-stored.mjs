// A member's order stored with the group delivery option (#471), as
// production may hold one after #626: the record keeps
// `fulfilment.delivery.toGroup` and the group's place as the address.
// Shared by group-delivery-kept.test.mjs and
// group-delivery-removal.test.mjs. The order is made as production
// holds one, never placed with the option, so the tests hold whether or
// not the server goes on accepting it on new orders.

import assert from "node:assert/strict";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { editOrder } from "../netlify/functions/lib/edit.mjs";
import { groupOf, setGroupCode } from "../netlify/functions/lib/groups.mjs";
import { amendOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

// Monday 2026-11-02: Thursday the 5th is the next delivery day.
export const now = instant("2026-11-02", 9, 0, "America/New_York");
export const GYM = terms.model.location(groupOf("vff").location);
export const SKU = "NFF-CHK-WHL-35-39";
export const EMAIL = "pat@example.com";
export const COOLER = `The cooler at ${GYM.name}`;

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
// address, its cooler line and the tag. -> { stores, id }
export const storedToGroup = async () => {
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
        cooler: COOLER, toGroup: true,
      },
    },
  }), "test.stored", now);

  return { stores, id };
};

// The customer's edit of the order, asked once without a total to
// learn it, as the page learns it, then sent. `mail` collects what is
// sent. -> the edit's result
export const editStored = async (stores, id, body, mail) => {
  const opts = { now, env, square, mail: mail || (async () => ({})),
    ...quiet };
  const first = await editOrder(stores, { email: EMAIL }, id, body, opts);

  if (first.ok || !first.errors || !first.errors.total) return first;

  return editOrder(stores, { email: EMAIL }, id, {
    ...body, claimedTotal: first.totals.total,
  }, opts);
};

// The delivery is still to the place, its cooler line as stored.
export const atPlace = (delivery) => {
  assert.equal(delivery.address1, GYM.street);
  assert.equal(delivery.town, GYM.city);
  assert.equal(delivery.zip, GYM.zip);
  assert.equal(delivery.cooler, COOLER);
};
