// A buying group member's changes (#471): a change of pickup day or
// items knows the group, so the group's round is among the choices
// and the tag's round follows the new day.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import {
  changeOrder, planChange,
} from "../netlify/functions/lib/account.mjs";
import { planEdit } from "../netlify/functions/lib/edit.mjs";
import {
  buyingFor, groupOf, joinGroup, retag,
} from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import discountCodes from "../data/discount-codes.json" with {
  type: "json",
};
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h = 9, m = 0) => instant(iso, h, m, "America/New_York");
const now = ny("2026-11-02");
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
};
const VFF = groupOf("vff");
const SKU = "NFF-CHK-WHL-35-39";
const index = indexCatalog(catalog);
const schedule = Object.assign(parseSchedule(SCHEDULE).windows,
  { lines: parseSchedule(SCHEDULE).lines });
const customer = { email: "pat@x.com", name: "Pat Example" };

// A paid drop-site order on Saturday 2026-11-07, a member's or not.
const dropOrder = (group = null) => ({
  id: "NFF-2611-CHANGE", status: "paid",
  submittedAt: "2026-11-01T12:00:00.000Z", paidAt: "2026-11-01T12:00:05Z",
  customer: { ...customer, firstName: "Pat", lastName: "Example",
    phone: "4015550100", contact: "call" },
  lines: [{ sku: SKU, label: "Whole", name: "Whole", qty: 2, unitPrice: 30,
    lineTotal: 60, squareVariationId: null }],
  totals: { subtotal: 6000, discountTier: 50, discountAmount: 500,
    deliveryFee: 0, total: 5500 },
  fulfilment: { method: "scheduled", occurrence: "VFVQ-261107",
    date: "2026-11-07", onfarm: null, delivery: null, state: "agreed" },
  payments: [{ at: "2026-11-01T12:00:05Z", amount: 5500, via: "square" }],
  refunds: [], notes: "", code: null, group,
});

const member = async (stores) => {
  await saveCustomer(stores, { ...customer, phone: "", avatar: null,
    discountGroup: null, address: null });
  await joinGroup(stores, customer.email, "vff", { now });

  return stores;
};

describe("the group a change is offered by", () => {
  it("is the order's tag while a member, else the membership", async () => {
    const stores = testStores();

    assert.equal(await buyingFor(stores, dropOrder()), null);
    // The tag alone offers nothing (#495): a member removed can't move
    // an order into a round.
    assert.equal(await buyingFor(stores, dropOrder({ key: "vff" })), null);
    await member(stores);
    assert.equal((await buyingFor(stores, dropOrder({ key: "vff" }))).key,
      "vff");
    assert.equal((await buyingFor(stores, dropOrder())).key, "vff");
  });

  it("retags with the round after the new day", () => {
    const tagged = dropOrder({ key: "vff", round: "2026-11-08",
      viaCode: true });

    assert.deepEqual(retag(tagged, VFF, terms, "2026-11-10"),
      { key: "vff", round: "2026-11-22", viaCode: true });
    assert.deepEqual(retag(dropOrder(), VFF, terms, "2026-11-07"),
      { key: "vff", round: "2026-11-08", viaCode: false });
    assert.equal(retag(dropOrder(), null, terms, "2026-11-07"), null);
    assert.deepEqual(retag(tagged, null, terms, "2026-11-07"), tagged.group);
  });
});

describe("moving a pickup to the group's round", () => {
  it("is refused to anyone else, and offered to a member", () => {
    const order = dropOrder();
    const to = { method: "scheduled", occurrence: "36TS-261108" };
    const refused = planChange(order, to, { now, env });

    assert.equal(refused.errors.occurrence, "That pickup isn't available.");

    const moved = planChange(order, to, { now, env, member: VFF });

    assert.equal(moved.errors, undefined);
    assert.equal(moved.patch.fulfilment.occurrence, "36TS-261108");
    assert.equal(moved.patch.fulfilment.date, "2026-11-08");
    assert.deepEqual(moved.patch.group,
      { key: "vff", round: "2026-11-08", viaCode: false });
  });

  it("keeps a tagged order's tag, its round following the day", () => {
    const order = dropOrder({ key: "vff", round: "2026-11-08",
      viaCode: true });
    // The group's order moves to the drop site on the 14th: still the
    // group's, in the round after.
    const moved = planChange(order, {
      method: "scheduled", occurrence: "VFVQ-261114",
    }, { now, env });

    assert.equal(moved.errors, undefined);
    assert.deepEqual(moved.patch.group,
      { key: "vff", round: "2026-11-22", viaCode: true });

    // The same day again changes nothing of the tag.
    const notes = planChange(order, { notes: "ring twice" }, { now, env });

    assert.equal(notes.patch.group, undefined);
  });

  it("reaches the record through the account's change", async () => {
    const stores = await member(testStores());
    const order = dropOrder();

    await saveOrder(stores, order, now);

    // The session's customer is the record, with its membership.
    const r = await changeOrder(stores, await getCustomer(stores,
      customer.email), order.id, {
      method: "scheduled", occurrence: "36TS-261108",
    }, { now, env, mail: async () => ({}),
      square: { updateFulfillment: async () => ({}) } });

    assert.equal(r.ok, true, JSON.stringify(r.errors));

    const saved = await getOrder(stores, order.id);

    assert.equal(saved.fulfilment.occurrence, "36TS-261108");
    assert.deepEqual(saved.group,
      { key: "vff", round: "2026-11-08", viaCode: false });
  });
});

describe("changing a member's items", () => {
  const plan = (stores, order, body) => planEdit(stores, order, body, {
    now, index, terms, codes: discountCodes.codes, group: null,
    validate: validateOrder, schedule, env,
  });

  it("offers the group's round and tags the order", async () => {
    const stores = await member(testStores());
    const order = dropOrder();
    const planned = await plan(stores, order, {
      fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
      lines: [{ sku: SKU, qty: 3 }],
      claimedTotal: 8500,
    });

    assert.equal(planned.ok, true, JSON.stringify(planned.errors));
    assert.equal(planned.next.fulfilment.occurrence, "36TS-261108");
    assert.deepEqual(planned.next.group,
      { key: "vff", round: "2026-11-08", viaCode: false });
    assert.equal(planned.change.difference, 3000);
  });

  it("is refused the round for anyone else, whose tag stays null",
    async () => {
      const stores = testStores();
      const order = dropOrder();
      const planned = await plan(stores, order, {
        fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
        lines: [{ sku: SKU, qty: 3 }],
        claimedTotal: 8500,
      });

      assert.equal(planned.ok, false);
      assert.match(planned.errors["fulfilment.occurrence"],
        /no longer available/);

      const same = await plan(stores, order, {
        lines: [{ sku: SKU, qty: 3 }], claimedTotal: 8500,
      });

      assert.equal(same.ok, true, JSON.stringify(same.errors));
      assert.equal(same.next.group, null);
    });
});
