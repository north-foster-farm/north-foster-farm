// A round under the group's minimum (#471, James, 6405681338): once
// there is one, the round rolls over, its orders moved to the next
// round through the farm's own change, and it earns nothing of its
// own. With no minimum (November, the pilot) every round runs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupOf } from "../netlify/functions/lib/groups.mjs";
import {
  getOrder, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import {
  belowMinimum, closeRound, workRounds,
} from "../netlify/functions/lib/rounds.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h = 9, m = 0) => instant(iso, h, m, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
};
// The group with a $300 round minimum, as December may set it.
const strict = { ...groupOf("vff"), roundMinimum: 300 };

const order = (id, email, dollars, { status = "paid" } = {}) => ({
  id, status, submittedAt: "2026-11-01T12:00:00.000Z",
  customer: { email, name: email.split("@")[0], firstName: "Pat",
    lastName: "Example", phone: "", contact: "text" },
  lines: [{ sku: SKU, label: "Whole", qty: 1, unitPrice: dollars,
    lineTotal: dollars }],
  totals: { total: dollars * 100 },
  payments: [{ amount: dollars * 100, via: "square" }],
  refunds: [],
  fulfilment: { method: "scheduled", occurrence: "36TS-261108",
    date: "2026-11-08", onfarm: null, delivery: null, state: "agreed" },
  square: { squareOrderId: `SQO-${id}` },
  group: { key: "vff", round: "2026-11-08", viaCode: true },
  notes: "",
});

const harness = () => {
  const sent = [];
  const updated = [];

  return {
    sent, updated,
    mail: async (m) => { sent.push(m); return { id: "m" }; },
    square: { updateFulfillment: async (id, o) => { updated.push([id,
      o.fulfilment.occurrence]); return {}; } },
  };
};

describe("a round under the minimum", () => {
  it("is told apart by the net total", () => {
    assert.equal(belowMinimum(strict, { net: 29_999 }), true);
    assert.equal(belowMinimum(strict, { net: 30_000 }), false);
    assert.equal(belowMinimum(groupOf("vff"), { net: 0 }), false);
    assert.equal(belowMinimum({ roundMinimum: null }, { net: 0 }), false);
  });

  it("rolls its open orders to the next round, each told", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("NFF-2611-RL0001", "a@x.com", 100));
    await saveOrder(stores, order("NFF-2611-RL0002", "b@x.com", 60));
    await saveOrder(stores, order("NFF-2611-RL0003", "c@x.com", 40,
      { status: "cancelled" }));

    const r = await closeRound(stores, strict, "2026-11-08", {
      now: ny("2026-11-08", 0, 1), terms, env, mail: h.mail,
      square: h.square,
    });

    assert.equal(r.closed, true);
    assert.equal(r.round.rolledTo, "2026-11-22");
    assert.deepEqual([...r.round.moved].sort(),
      ["NFF-2611-RL0001", "NFF-2611-RL0002"]);
    assert.deepEqual(r.round.stuck, []);
    assert.equal(r.round.minimum, 300);
    assert.equal(r.round.reward.earned, false);
    assert.equal(r.round.reward.rolled, true);

    const moved = await getOrder(stores, "NFF-2611-RL0001");

    assert.equal(moved.fulfilment.occurrence, "36TS-261122");
    assert.equal(moved.fulfilment.date, "2026-11-22");
    assert.deepEqual(moved.group, { key: "vff", round: "2026-11-22",
      viaCode: true });
    assert.ok(moved.history.some((h) => h.event === "fulfilment.moved"
      && h.to === "36TS-261122"));
    // Square followed, and each member heard.
    assert.deepEqual(h.updated.map((u) => u[1]),
      ["36TS-261122", "36TS-261122"]);
    assert.equal(h.sent.filter((m) => m.to === "a@x.com").length, 1);
    // The cancelled order stays where it was.
    assert.equal((await getOrder(stores, "NFF-2611-RL0003")).fulfilment
      .occurrence, "36TS-261108");
  });

  it("counts the moved orders in the next round", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("NFF-2611-RL0001", "a@x.com", 100));
    await closeRound(stores, strict, "2026-11-08", {
      now: ny("2026-11-08", 0, 1), terms, env, mail: h.mail,
      square: h.square,
    });
    await saveOrder(stores, {
      ...order("NFF-2611-RL0004", "d@x.com", 250),
      fulfilment: { method: "scheduled", occurrence: "36TS-261122",
        date: "2026-11-22", onfarm: null, delivery: null, state: "agreed" },
      group: { key: "vff", round: "2026-11-22", viaCode: true },
    });

    const next = await closeRound(stores, strict, "2026-11-22", {
      now: ny("2026-11-22", 0, 1), terms, env, mail: h.mail,
      square: h.square,
    });

    assert.equal(next.round.rolledTo, undefined);
    assert.equal(next.round.net, 35_000);
    assert.equal(next.round.reward.earned, true);
    assert.equal(next.round.reward.amount, 3_500);
  });

  it("runs every round while there is no minimum", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("NFF-2611-RL0001", "a@x.com", 100));

    const r = await workRounds(stores, {
      now: ny("2026-11-09", 0, 1), terms, env, mail: h.mail,
      square: h.square,
    });

    assert.equal(r.closed[0].rolledTo, undefined);
    assert.equal((await getOrder(stores, "NFF-2611-RL0001")).fulfilment
      .occurrence, "36TS-261108");
    assert.deepEqual(h.updated, []);
  });
});
