import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import {
  canChange, changeOrder, publicOrder,
} from "../netlify/functions/lib/account.mjs";
import { occurrenceUse } from "../netlify/functions/lib/admin.mjs";
import {
  migrateScheduledPickup, planMigration,
} from "../netlify/functions/lib/migrate.mjs";
import {
  amendOrder, getOrder, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};
const customer = { email: "pat@example.com", name: "Pat Example" };
const quiet = { sleep: async () => {} };
const square = {
  createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
  createPayment: async (args) => ({
    squarePaymentId: `PAY-${args.squareOrderId}`, status: "COMPLETED",
    receiptUrl: null, brand: "VISA", last4: "4242", wallet: null,
  }),
};

const body = (fulfilment) => ({
  idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment,
  claimedTotal: 5500,
  payment: { method: "card", sourceId: "cnon:tok" },
});

const send = async (stores, fulfilment) => placeOrder(
  new Request("http://x/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body(fulfilment)),
  }),
  { stores, square, now, env, mail: async () => ({}), ...quiet }
);

const place = async (fulfilment) => {
  const stores = testStores();
  const res = await send(stores, fulfilment);

  assert.equal(res.status, 200, await res.clone().text());

  return { stores, id: (await res.json()).orderId };
};

// The drop site's Saturday and the Foster market's Sunday, both inside
// the horizon (Oct 17) of the 6th.
const DROP = { method: "scheduled", occurrence: "VFVQ-261017" };
const FOSTER = "WAC5-261011";
const outbox = () => {
  const sent = [];

  return { sent, mail: async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  } };
};
const move = (stores, id, changes, mail) => changeOrder(stores, customer, id,
  changes, { now, env, mail, square: { updateFulfillment: async () => ({}) } });

// What Stage 1 stored, put back by hand.
const legacy = async (stores, id, fulfilment) => amendOrder(stores, id, {
  fulfilment: { ...(await getOrder(stores, id)).fulfilment, ...fulfilment },
}, "test", now);

describe("an order for a scheduled pickup", () => {
  it("stores the occurrence and derives its date", async () => {
    const { stores, id } = await place(DROP);
    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.fulfilment.occurrence, "VFVQ-261017");
    assert.equal(saved.fulfilment.date, "2026-10-17");
    assert.equal(saved.fulfilment.site, undefined);
  });

  it("refuses a scheduled pickup with no occurrence chosen", async () => {
    for (const fulfilment of [
      { method: "scheduled" },
      { method: "scheduled", occurrence: "" },
      { method: "scheduled", occurrence: "", date: "2026-10-17" },
    ]) {
      const res = await send(testStores(), fulfilment);
      const body = await res.json();

      assert.equal(res.status, 422, JSON.stringify(fulfilment));
      assert.equal(body.errors["fulfilment.occurrence"],
        "Choose a pickup day and place.");
    }
  });

  it("takes a date only if it is the occurrence's own", async () => {
    const stores = testStores();
    const same = await send(stores, { ...DROP, date: "2026-10-17" });
    const other = await send(testStores(), { ...DROP, date: "2026-10-18" });

    assert.equal(same.status, 200);
    assert.equal(other.status, 409);
    assert.match((await other.json()).errors["fulfilment.occurrence"],
      /no longer available/);
  });

  it("refuses an unknown, archived, past-horizon or unlisted occurrence",
    async () => {
      for (const occurrence of [
        "ZZZZ-261017", "GR6C-260710", "VFVQ-261024", "VFVQ-261018", "nope",
      ]) {
        const res = await send(testStores(),
          { method: "scheduled", occurrence });

        assert.ok([409, 422].includes(res.status), occurrence);
        assert.ok((await res.json()).errors["fulfilment.occurrence"],
          occurrence);
      }
    });

  it("still takes a page that posts the drop site the old way", async () => {
    const { stores, id } = await place({
      method: "scituate", date: "2026-10-17",
    });
    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.fulfilment.occurrence, "VFVQ-261017");
  });

  it("still takes a page that posts a market and its site the old way",
    async () => {
      const { stores, id } = await place({
        method: "market", site: "foster", date: "2026-10-11",
      });
      const saved = await getOrder(stores, id);

      assert.equal(saved.fulfilment.method, "scheduled");
      assert.equal(saved.fulfilment.occurrence, FOSTER);
      assert.equal(saved.fulfilment.date, "2026-10-11");
      assert.equal(saved.fulfilment.site, undefined);
    });

  it("refuses an old market post for a date its site never had",
    async () => {
      const res = await send(testStores(), {
        method: "market", site: "foster", date: "2026-10-12",
      });

      assert.ok([409, 422].includes(res.status));
    });

  it("refuses an occurrence on an on-farm order", async () => {
    const res = await send(testStores(), {
      method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
      occurrence: "VFVQ-261017",
    });

    assert.equal(res.status, 422);
  });
});

describe("a customer's move within scheduled pickup", () => {
  it("goes from the drop site to a market the schedule opened", async () => {
    const { stores, id } = await place(DROP);
    const { sent, mail } = outbox();
    const r = await move(stores, id, { occurrence: FOSTER }, mail);

    assert.equal(r.ok, true, JSON.stringify(r.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "scheduled");
    assert.equal(saved.fulfilment.occurrence, FOSTER);
    assert.equal(saved.fulfilment.date, "2026-10-11");
    assert.equal(saved.totals.total, 5500, "no money changes");
    assert.ok(saved.history.some((h) => h.event === "customer.changed"));

    const moved = saved.history.find((h) => h.event === "fulfilment.moved");

    assert.equal(moved.from, "VFVQ-261017");
    assert.equal(moved.to, FOSTER);
    assert.equal(moved.by, "customer");
    assert.ok(moved.at);

    const toCustomer = sent.find((m) => m.to === "pat@example.com");

    assert.match(toCustomer.text, /Before: Village Green/);
    assert.match(toCustomer.text, /Where: Foster Farmers Market/);

    const toFarm = sent.find((m) => m.subject.startsWith("Pickup moved"));

    assert.match(toFarm.text, /Was: \*\*Drop site, Village Green/);
    assert.match(toFarm.text, /Now: \*\*Foster Farmers Market/);
  });

  it("moves to another date of the same series on a date alone",
    async () => {
      const { stores, id } = await place({
        method: "scheduled", occurrence: "WAC5-261011",
      });
      const r = await move(stores, id, { date: "2026-10-04" });

      assert.equal(r.ok, false, "Oct 4 is past, and not offered");
      assert.equal(r.errors.date, "That pickup isn't available.");

      const same = await move(stores, id, { date: "2026-10-11" });

      assert.equal(same.ok, true, "no change at all");
      assert.equal((await getOrder(stores, id)).history
        .filter((h) => h.event === "fulfilment.moved").length, 0);
    });

  it("keeps each move of a market order, to a date then the drop site",
    async () => {
      const { stores, id } = await place(DROP);
      const later = "WAC5-261018";

      // A market order the farm booked beyond the usual list.
      await legacy(stores, id, { occurrence: later, date: "2026-10-18" });

      const first = await move(stores, id, { occurrence: FOSTER });

      assert.equal(first.ok, true, JSON.stringify(first.errors));

      const second = await move(stores, id, { occurrence: "VFVQ-261017" });

      assert.equal(second.ok, true, JSON.stringify(second.errors));

      const saved = await getOrder(stores, id);
      const moves = saved.history.filter((h) => h.event === "fulfilment.moved");

      assert.deepEqual(moves.map((h) => [h.from, h.to, h.by]), [
        [later, FOSTER, "customer"],
        [FOSTER, "VFVQ-261017", "customer"],
      ]);
      assert.equal(saved.fulfilment.occurrence, "VFVQ-261017");
      assert.equal(saved.fulfilment.date, "2026-10-17");
    });

  it("takes only an occurrence the schedule offers", async () => {
    const { stores, id } = await place(DROP);
    const shut = await move(stores, id, { occurrence: "WAC5-261004" });
    const archived = await move(stores, id, { occurrence: "GR6C-260710" });
    const unknown = await move(stores, id, { occurrence: "ZZZZ-261011" });
    const far = await move(stores, id, { occurrence: "WAC5-261025" });

    for (const r of [shut, archived, unknown, far]) {
      assert.equal(r.ok, false);
      assert.equal(r.errors.occurrence, "That pickup isn't available.");
    }
    assert.equal((await getOrder(stores, id)).fulfilment.occurrence,
      "VFVQ-261017");
  });

  it("is not for on-farm pickup or delivery", async () => {
    const { stores, id } = await place({
      method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
    });
    const r = await move(stores, id, { occurrence: FOSTER });

    assert.equal(r.ok, false);
    assert.match(r.errors.method, /Only a scheduled pickup/);
  });

  it("moves an order stored the Stage 1 way, and rewrites its shape",
    async () => {
      const { stores, id } = await place(DROP);

      await legacy(stores, id, { method: "scituate", occurrence: undefined });

      const r = await move(stores, id, { occurrence: FOSTER });
      const saved = await getOrder(stores, id);

      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.equal(saved.fulfilment.method, "scheduled");
      assert.equal(saved.history.find((h) => h.event === "fulfilment.moved")
        .from, "VFVQ-261017");
    });
});

describe("the account's pickup", () => {
  it("carries the place and window, derived and never stored", async () => {
    const { stores, id } = await place(DROP);
    const order = await getOrder(stores, id);
    const pub = publicOrder(order, now);

    assert.equal(pub.pickup.name, "Drop site");
    assert.equal(pub.pickup.occurrence, order.fulfilment.occurrence);
    assert.match(pub.pickup.place, /Village Green/);
    assert.equal(pub.pickup.window, "10 – 11 AM");
    assert.equal(pub.pickup.gone, false);
    assert.equal(order.pickup, undefined);
  });

  it("reads an order still stored the Stage 1 way", async () => {
    const { stores, id } = await place(DROP);
    const old = await legacy(stores, id, {
      method: "scituate", occurrence: undefined,
    });

    assert.equal(publicOrder(old, now).pickup.name, "Drop site");
    assert.equal(publicOrder(old, now).pickup.gone, false);
  });

  it("has none for an on-farm order", async () => {
    const { stores, id } = await place({
      method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
    });

    assert.equal(publicOrder(await getOrder(stores, id), now).pickup, null);
  });

  it("shows an occurrence gone from the data without the change control",
    async () => {
      const { stores, id } = await place(DROP);
      const gone = await legacy(stores, id, { occurrence: "ZZZZ-261017" });
      const pub = publicOrder(gone, now);

      assert.equal(pub.pickup.gone, true);
      assert.equal(pub.pickup.name, "Pickup, ZZZZ-261017");
      assert.equal(pub.canChange, false);
      assert.equal(canChange(gone, now), false);

      const r = await move(stores, id, { date: "2026-10-18" });

      assert.equal(r.ok, false);
      assert.match(r.errors.order, /call, text, or email/);
    });
});

describe("the occurrences orders name", () => {
  it("lists them, and the ones that are gone", async () => {
    const { stores, id } = await place(DROP);

    assert.deepEqual((await occurrenceUse(stores)).occurrences,
      { "VFVQ-261017": 1 });

    await legacy(stores, id, { occurrence: "ZZZZ-261017" });

    const use = await occurrenceUse(stores);

    assert.deepEqual(use.missing, [{ id, occurrence: "ZZZZ-261017" }]);
  });

  it("checks the history of a move too", async () => {
    const { stores, id } = await place(DROP);

    await move(stores, id, { occurrence: FOSTER });

    const order = await getOrder(stores, id);

    await amendOrder(stores, id, { history: [...order.history, {
      at: now.toISOString(), event: "fulfilment.moved", from: "QQQQ-261001",
      to: FOSTER, by: "farm",
    }] }, "test", now);

    const use = await occurrenceUse(stores);

    assert.deepEqual(use.missing, [{ id, occurrence: "QQQQ-261001" }]);
    assert.deepEqual(use.occurrences, { [FOSTER]: 1 });
  });
});

describe("the migration to scheduled pickup", () => {
  const fixtures = async () => {
    const { stores, id: drop } = await place(DROP);
    const { id: market } = await (async () => {
      const res = await send(stores, { method: "scheduled",
        occurrence: FOSTER });
      const json = await res.json();

      return { id: json.orderId };
    })();

    return { stores, drop, market };
  };
  // The idempotency key repeats, so a second order is the same order;
  // make a distinct one by hand instead.
  const second = async (stores, id) => {
    const order = await getOrder(stores, id);
    const copy = { ...order, id: `${id}-B`, history: [...order.history] };

    await amendOrder(stores, id, {}, "test", now);
    await stores.orders.set(`order/${copy.id}`, copy);

    return copy.id;
  };

  it("maps drop site and market orders by their date", async () => {
    const { stores, id } = await place(DROP);
    const other = await second(stores, id);

    await legacy(stores, id, { method: "scituate", occurrence: undefined });
    await amendOrder(stores, other, { fulfilment: {
      ...(await getOrder(stores, other)).fulfilment, method: "market",
      site: "foster", date: "2026-10-11", occurrence: undefined,
    } }, "test", now);
    await amendOrder(stores, other, { fulfilment: {
      ...(await getOrder(stores, other)).fulfilment, occurrence: undefined,
    } }, "test", now);

    const orders = [await getOrder(stores, id), await getOrder(stores, other)];
    const plan = planMigration(orders);

    assert.deepEqual(plan.changes.map((c) => [c.id, c.to]),
      [[id, "VFVQ-261017"], [other, FOSTER]]);
    assert.deepEqual(plan.unmapped, []);
  });

  it("maps a retired pop-up site by its id", () => {
    const plan = planMigration([{
      id: "NFF-X", fulfilment: {
        method: "market", site: "city-hall-2026-07-10", date: "2026-07-10",
      },
    }]);

    assert.equal(plan.changes[0].to, "GR6C-260710");
  });

  it("rewrites the fulfilment, touches nothing else, and is idempotent",
    async () => {
      const { stores, drop } = await fixtures();
      const before = await getOrder(stores, drop);

      await legacy(stores, drop, { method: "scituate", occurrence: undefined });

      let backups = 0;
      const backup = async () => { backups += 1; };
      const run = () => migrateScheduledPickup(stores, { backup, now });
      const first = await run();
      const after = await getOrder(stores, drop);

      assert.equal(first.ok, true);
      assert.equal(first.changes.length, 1);
      assert.equal(backups, 1, "backed up before the first write");
      assert.equal(after.fulfilment.method, "scheduled");
      assert.equal(after.fulfilment.occurrence, "VFVQ-261017");
      assert.equal(after.fulfilment.date, before.fulfilment.date);
      assert.deepEqual(after.totals, before.totals);
      assert.deepEqual(after.payments, before.payments);
      assert.deepEqual(after.square, before.square);
      assert.equal(after.history.at(-1).event, "fulfilment.migrated");

      const again = await run();

      assert.equal(again.changes.length, 0);
      assert.equal(backups, 1, "nothing to do, nothing backed up");
      assert.deepEqual(await getOrder(stores, drop), after);
    });

  it("changes nothing on a dry run", async () => {
    const { stores, drop } = await fixtures();

    await legacy(stores, drop, { method: "scituate", occurrence: undefined });

    const before = await getOrder(stores, drop);
    const r = await migrateScheduledPickup(stores, {
      dryRun: true, backup: async () => assert.fail("no backup on a dry run"),
    });

    assert.equal(r.changes.length, 1);
    assert.deepEqual(await getOrder(stores, drop), before);
  });

  it("stops, changing nothing, and lists an order it can't map",
    async () => {
      const { stores, drop, market } = await fixtures();

      await legacy(stores, drop, { method: "scituate", occurrence: undefined });
      await amendOrder(stores, market, { fulfilment: {
        ...(await getOrder(stores, market)).fulfilment, method: "market",
        site: "gone", occurrence: undefined,
      } }, "test", now);

      const before = await getOrder(stores, drop);
      const r = await migrateScheduledPickup(stores, {
        backup: async () => assert.fail("no backup when it stops"),
      });

      assert.equal(r.ok, false);
      assert.deepEqual(r.unmapped.map((u) => u.id), [market]);
      assert.match(r.unmapped[0].reason, /matches no occurrence/);
      assert.deepEqual(await getOrder(stores, drop), before);
    });

  it("refuses to write when the backup fails", async () => {
    const { stores, drop } = await fixtures();

    await legacy(stores, drop, { method: "scituate", occurrence: undefined });

    const before = await getOrder(stores, drop);

    await assert.rejects(migrateScheduledPickup(stores, {
      backup: async () => { throw new Error("no bucket"); },
    }), /no bucket/);
    assert.deepEqual(await getOrder(stores, drop), before);
  });

  it("keeps a change that lands between the plan and the write",
    async () => {
      const { stores, drop } = await fixtures();

      await legacy(stores, drop, { method: "scituate", occurrence: undefined });

      // The backup runs after the plan: an edit lands in that gap.
      const backup = async () => {
        const order = await getOrder(stores, drop);

        await saveOrder(stores, {
          ...order,
          history: [...order.history, { at: "x", event: "late.note" }],
        }, now);
      };
      const r = await migrateScheduledPickup(stores, { backup, now });
      const after = await getOrder(stores, drop);

      assert.equal(r.changes.length, 1);
      assert.equal(after.fulfilment.method, "scheduled");
      assert.deepEqual(after.history.slice(-2).map((h) => h.event),
        ["late.note", "fulfilment.migrated"]);
    });

  it("skips an order that is no longer an old shape", async () => {
    const { stores, drop } = await fixtures();

    await legacy(stores, drop, { method: "scituate", occurrence: undefined });

    const backup = async () => {
      const order = await getOrder(stores, drop);

      await saveOrder(stores, {
        ...order, fulfilment: { ...order.fulfilment, method: "delivery" },
      }, now);
    };
    const r = await migrateScheduledPickup(stores, { backup, now });

    assert.equal(r.changes.length, 0);
    assert.equal((await getOrder(stores, drop)).fulfilment.method,
      "delivery");
  });
});
