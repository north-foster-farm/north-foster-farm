// A buying group's rounds (#471): the orders a round gathers, added
// up for the farm and the host, and a walk-in sale recorded against
// one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createFarmOrder, planFarmOrder,
} from "../netlify/functions/lib/farm-orders.mjs";
import {
  groupOf, joinGroup, memberKeyOf, nextRound, roundOccurrence,
  roundOrders, roundSummary, walkInCustomer,
} from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h = 9, m = 0) => instant(iso, h, m, "America/New_York");
const VFF = groupOf("vff");
const SKU = "NFF-CHK-WHL-35-39";
const EGGS = "NFF-CHK-EGG-LG";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
};

const order = (id, email, lines, {
  paid = null, refunded = 0, status = "paid", group = {
    key: "vff", round: "2026-11-08", viaCode: true,
  }, name = "Pat Example",
} = {}) => {
  const total = lines.reduce((s, [, qty, price]) => s + qty * price * 100, 0);

  return {
    id, status, submittedAt: `2026-11-0${id.slice(-1)}T12:00:00.000Z`,
    customer: { email, name },
    lines: lines.map(([sku, qty, price]) => ({
      sku, label: sku, qty, unitPrice: price, lineTotal: qty * price,
    })),
    totals: { total },
    payments: [{ amount: paid === null ? total : paid, via: "square" }],
    refunds: refunded ? [{ amount: refunded, status: "COMPLETED" }] : [],
    group,
  };
};

describe("a round's orders", () => {
  it("are the ones tagged with the group and the round", async () => {
    const stores = testStores();

    await saveOrder(stores, order("NFF-2611-AAAAA1", "a@x.com",
      [[SKU, 2, 30]]));
    await saveOrder(stores, order("NFF-2611-AAAAA2", "b@x.com",
      [[SKU, 1, 30]], { group: { key: "vff", round: "2026-11-22" } }));
    await saveOrder(stores, order("NFF-2611-AAAAA3", "c@x.com",
      [[SKU, 1, 30]], { group: null }));

    const found = await roundOrders(stores, "vff", "2026-11-08");

    assert.deepEqual(found.map((o) => o.id), ["NFF-2611-AAAAA1"]);
    assert.deepEqual(await roundOrders(stores, "vff", "2026-12-06"), []);
  });

  it("add up by member, with the pick list and the net", () => {
    const sum = roundSummary([
      order("NFF-2611-AAAAA1", "a@x.com", [[SKU, 2, 30], [EGGS, 1, 7]]),
      order("NFF-2611-AAAAA2", "b@x.com", [[SKU, 1, 30]],
        { group: { key: "vff", round: "2026-11-08", walkIn: true } }),
      order("NFF-2611-AAAAA3", "a@x.com", [[EGGS, 2, 7]], { refunded: 700 }),
      order("NFF-2611-AAAAA4", "d@x.com", [[SKU, 1, 30]],
        { status: "cancelled", refunded: 3000 }),
    ]);

    assert.equal(sum.count, 4);
    assert.equal(sum.paid, 6700 + 3000 + 1400 + 3000);
    assert.equal(sum.refunded, 3700);
    assert.equal(sum.net, 10400);
    assert.deepEqual(sum.members.map((m) => [m.email, m.net, m.orders]),
      [["a@x.com", 7400, 2], ["b@x.com", 3000, 1], ["d@x.com", 0, 1]]);
    assert.equal(sum.members[1].walkIn, true);
    assert.equal(sum.members[2].cancelled, 1);
    assert.deepEqual(sum.members[0].lines.map((l) => [l.sku, l.qty]),
      [[SKU, 2], [EGGS, 3]]);
    // The cancelled order's chicken is not packed.
    assert.deepEqual(sum.pickList.map((l) => [l.sku, l.qty]),
      [[EGGS, 3], [SKU, 3]]);
  });

  it("is empty, not broken, with no orders", () => {
    const sum = roundSummary([]);

    assert.equal(sum.count, 0);
    assert.equal(sum.net, 0);
    assert.deepEqual(sum.members, []);
    assert.deepEqual(sum.pickList, []);
  });

  it("is today's or the next, and names its occurrence", () => {
    assert.equal(nextRound(VFF, terms, ny("2026-10-26")), "2026-11-08");
    assert.equal(nextRound(VFF, terms, ny("2026-11-08", 7)), "2026-11-08");
    assert.equal(nextRound(VFF, terms, ny("2026-11-09")), "2026-11-22");
    assert.equal(roundOccurrence(VFF, "2026-11-08"), "36TS-261108");
  });
});

describe("a walk-in sale at a round", () => {
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createPayment: async () => ({
      squarePaymentId: "PAY-1", status: "COMPLETED", receiptUrl: null,
      brand: null, last4: null, wallet: null,
    }),
    completeOrder: async (id) => ({ id, completed: true }),
    findPaid: async () => null,
    getOrder: async (id) => ({ id, tenders: [] }),
  };
  const mail = async () => ({ id: "m" });
  const body = async (stores, email = "walk@x.com") => ({
    customer: await walkInCustomer(stores, email, { first: "Lee" }),
    lines: [{ sku: SKU, qty: 2 }],
    fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
  });

  it("takes the buyer's details from the record or a placeholder",
    async () => {
      const stores = testStores();

      assert.deepEqual(await walkInCustomer(stores, "new@x.com"), {
        email: "new@x.com", firstName: "Walk-in", lastName: "Customer",
        phone: "", contact: "text",
      });

      await saveCustomer(stores, {
        email: "pat@x.com", name: "Pat Example", firstName: "Pat",
        lastName: "Example", phone: "4015550100", avatar: null,
        discountGroup: null, address: null,
      });
      assert.deepEqual(await walkInCustomer(stores, "pat@x.com",
        { last: "E." }), {
        email: "pat@x.com", firstName: "Pat", lastName: "E.",
        phone: "4015550100", contact: "text",
      });
    });

  it("is recorded at the round after the day, tagged, paid, a member",
    async () => {
      const stores = testStores();
      // Monday after the round: the occurrence is no longer offered.
      const now = ny("2026-11-09");
      const refused = await planFarmOrder(stores, await body(stores), {
        now, env, group: VFF,
      });

      assert.equal(refused.ok, false);
      assert.match(refused.errors["fulfilment.occurrence"],
        /no longer available/);

      const r = await createFarmOrder(stores, await body(stores), {
        now, env, mail, square, group: VFF, kept: "36TS-261108",
        walkIn: true, paid: { tender: "cash" },
      });

      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.equal(r.order.status, "paid");
      assert.equal(r.order.fulfilment.occurrence, "36TS-261108");
      assert.equal(r.order.fulfilment.date, "2026-11-08");
      assert.deepEqual(r.order.group,
        { key: "vff", round: "2026-11-08", viaCode: false, walkIn: true });
      assert.equal(r.order.totals.total, 5500);

      const customer = await getCustomer(stores, "walk@x.com");

      assert.equal(memberKeyOf(customer), "vff");
      assert.equal(customer.memberGroup.via, "walk-in");

      const found = await roundOrders(stores, "vff", "2026-11-08");

      assert.deepEqual(found.map((o) => o.id), [r.order.id]);
      assert.equal(roundSummary(found).net, 5500);
    });

  it("tags a farm-made order for a member with no group given",
    async () => {
      const stores = testStores();
      const now = ny("2026-10-26");

      await saveCustomer(stores, {
        email: "pat@x.com", name: "Pat Example", phone: "", avatar: null,
        discountGroup: null, address: null,
      });
      await joinGroup(stores, "pat@x.com", "vff", { now });

      const planned = await planFarmOrder(stores, {
        customer: await walkInCustomer(stores, "pat@x.com"),
        lines: [{ sku: SKU, qty: 1 }],
        fulfilment: { method: "onfarm", date: "2026-10-27",
          onfarm: { window: "09:00-12:00" } },
      }, { now, env });

      assert.equal(planned.ok, true, JSON.stringify(planned.errors));
      assert.deepEqual(planned.order.group,
        { key: "vff", round: "2026-11-08", viaCode: false });

      const other = await planFarmOrder(stores, {
        customer: await walkInCustomer(stores, "new@x.com"),
        lines: [{ sku: SKU, qty: 1 }],
        fulfilment: { method: "onfarm", date: "2026-10-27",
          onfarm: { window: "09:00-12:00" } },
      }, { now, env });

      assert.equal(other.order.group, null);
    });
});
