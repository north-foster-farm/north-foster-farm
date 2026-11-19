// An order on a Thursday the schedule has replaced (#643): the server's
// rule, which holds today and must go on holding once the order page
// and the account keep the date. Written before the change, from the
// issue's spec and "Done when"; one test per criterion, named for it.
// The contract and the criteria that fail until the change are in
// test/kept-thursday.criteria.mjs; the page and the account in
// e2e/kept-thursday.spec.mjs. "A new order can never choose the
// replaced Thursday" is test/delivery-moved.test.mjs's "refuses a new
// order for the replaced Thursday", kept as it is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canChange, planChange,
} from "../netlify/functions/lib/account.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import {
  BASE, DECEMBER, SKU, edit, envWith, ny, placed,
} from "./delivery-moved-setup.mjs";

const KEPT = "2026-12-10";
let keys = 0;

// Placed for Thursday December 10 before the farm moved that week to
// Wednesday the 9th. -> { id, stores }
const onKept = () => placed({
  date: KEPT, now: ny("2026-12-01"), schedule: BASE,
});

// The order page's change: three chickens for two, and the day the
// select holds. -> { result, saved }
const change = async (stores, id, date, now) => {
  keys += 1;

  const { result } = await edit(stores, id, {
    idempotencyKey: `edit-key-643-${String(keys).padStart(8, "0")}`,
    lines: [{ sku: SKU, qty: 3 }],
    fulfilment: { method: "delivery", date },
    payment: { method: "card", sourceId: "cnon:tok" },
  }, { now, schedule: DECEMBER });

  return { result, saved: await getOrder(stores, id) };
};

describe("the server and an order on a replaced Thursday (#643)", () => {
  it("takes a change that keeps the order's Thursday until its cutoff",
    async () => {
      for (const now of [ny("2026-12-03"), ny("2026-12-09", 11, 59)]) {
        const { id, stores } = await onKept();
        const { result, saved } = await change(stores, id, KEPT, now);

        assert.equal(result.ok, true, JSON.stringify(result.errors));
        assert.equal(saved.fulfilment.date, KEPT, now.toISOString());
        assert.equal(saved.lines.find((l) => l.sku === SKU).qty, 3);
      }
    });

  it("refuses a change once the Thursday's cutoff has passed", async () => {
    const { id, stores } = await onKept();
    const { result, saved } = await change(stores, id, KEPT,
      ny("2026-12-09", 12, 1));

    assert.equal(result.ok, false);
    assert.equal(saved.fulfilment.date, KEPT);
    assert.equal(saved.lines.find((l) => l.sku === SKU).qty, 2);
  });

  it("lets the customer choose another day on offer on purpose",
    async () => {
      for (const date of ["2026-12-09", "2026-12-17"]) {
        const { id, stores } = await onKept();
        const { result, saved } = await change(stores, id, date,
          ny("2026-12-03"));

        assert.equal(result.ok, true, JSON.stringify(result.errors));
        assert.equal(saved.fulfilment.date, date);
      }
    });

  it("keeps only the order's own Thursday, never another order's",
    async () => {
      const { id, stores } = await placed({
        date: "2026-12-17", now: ny("2026-12-03"), schedule: DECEMBER,
      });
      const { result, saved } = await change(stores, id, KEPT,
        ny("2026-12-03"));

      assert.equal(result.ok, false);
      assert.equal(result.status, 409, JSON.stringify(result.errors));
      assert.ok(result.errors["fulfilment.date"],
        JSON.stringify(result.errors));
      assert.deepEqual(result.dates.map((d) => d.date),
        ["2026-12-09", "2026-12-17"], "the fresh list the dialog offers");
      assert.equal(saved.fulfilment.date, "2026-12-17");
    });
});

describe("the account's Change delivery and an order on a replaced " +
  "Thursday (#643)", () => {
  const env = envWith(DECEMBER);

  it("keeps the order's Thursday when only the notes change, until its " +
    "cutoff", async () => {
    const { id, stores } = await onKept();
    const order = await getOrder(stores, id);

    for (const now of [ny("2026-12-03"), ny("2026-12-09", 11, 59)]) {
      const plan = planChange(order, {
        date: KEPT, notes: "Leave it by the barn",
        delivery: { cooler: "Porch" },
      }, { now, env });

      assert.equal(plan.errors, undefined, JSON.stringify(plan.errors));
      assert.equal(plan.patch.fulfilment.date, KEPT, now.toISOString());
      assert.equal(canChange(order, now), true, now.toISOString());
    }
  });

  it("can no longer be changed once the Thursday's cutoff has passed",
    async () => {
      const { id, stores } = await onKept();

      assert.equal(canChange(await getOrder(stores, id),
        ny("2026-12-09", 12, 1)), false);
    });

  it("lets the customer move it to another day on offer on purpose",
    async () => {
      const { id, stores } = await onKept();
      const order = await getOrder(stores, id);
      const now = ny("2026-12-03");

      for (const date of ["2026-12-09", "2026-12-17"]) {
        const plan = planChange(order, { date }, { now, env });

        assert.equal(plan.errors, undefined, JSON.stringify(plan.errors));
        assert.equal(plan.patch.fulfilment.date, date);
      }
    });
});
