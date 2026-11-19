// A cancel whose Square holders could not all be cancelled (#662,
// the security review of #669): the implementer's own test beside the
// criteria tests in farm-cancel-holders.test.mjs. The money is back by
// then and the drift check skips cancelled orders, so the record is
// flagged squareOutOfSync and the farm gets one square.cancel_failed
// alert naming the Square orders that stayed open, and nothing about
// the customer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelOrder } from "../netlify/functions/lib/admin.mjs";
import { mark } from "../netlify/functions/lib/health.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import {
  EMAIL, env, now, switchedOnce, switchedTwice,
} from "./switched-orders.mjs";
import { CONFLICT, refusal } from "./version-conflict.mjs";

const KIND = "square.cancel_failed";

// The farm's cancel, with the mail it sent and the alert's log line.
// -> { saved, alerts: [mail], lines: [alert log line] }
const cancel = async (t, { stores, id, square }) => {
  const sent = [];
  const lines = [];
  const mail = async (message) => {
    sent.push(message);

    return {};
  };

  t.mock.method(console, "error", (text) => {
    try {
      lines.push(JSON.parse(text));
    } catch {
      // Not a log line.
    }
  });
  t.mock.method(console, "info", () => {});

  let saved;

  try {
    saved = await cancelOrder(stores, id, { now, env, mail, square });
  } finally {
    t.mock.restoreAll();
  }

  return {
    saved,
    alerts: sent.filter((m) => m.idempotencyKey.startsWith(`alert-${KIND}-`)),
    lines: lines.filter((l) => l.event === "alert" && l.kind === KIND),
  };
};

const refuse = (ids) => (holder) => (ids.includes(holder)
  ? refusal(CONFLICT, `/v2/orders/${holder}`) : null);

const flagged = (order) => !!(order.flags || {}).squareOutOfSync;

const outOfSyncEvents = (order) => (order.history || [])
  .filter((h) => h.event === "square.out_of_sync");

describe("#662: a cancel that leaves a Square order open", () => {
  it("flags the order and raises one alert on a partial failure",
    async (t) => {
      const order = await switchedOnce();

      assert.equal(flagged(await getOrder(order.stores, order.id)), false,
        "setup: not flagged");
      order.fail.cancelFulfillment = refuse(["SQO"]);

      const { saved, alerts, lines } = await cancel(t, order);

      assert.equal(saved.status, "cancelled");
      assert.equal(flagged(saved), true);
      assert.equal(outOfSyncEvents(saved).length, 1);
      assert.equal(alerts.length, 1);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].id, order.id);
      assert.deepEqual(lines[0].holders, ["SQO"]);
      assert.ok(lines[0].code);
    });

  it("flags the order and raises one alert when every cancel fails",
    async (t) => {
      const order = await switchedTwice();

      order.fail.cancelFulfillment = refuse(["SQC2", "SQO"]);

      const { saved, alerts, lines } = await cancel(t, order);

      assert.equal(saved.status, "cancelled");
      assert.equal(flagged(saved), true);
      assert.equal(outOfSyncEvents(saved).length, 1);
      assert.equal(alerts.length, 1);
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0].holders, ["SQC2", "SQO"]);
    });

  it("neither flags nor alerts when every cancel succeeds",
    async (t) => {
      const order = await switchedOnce();
      const { saved, alerts, lines } = await cancel(t, order);

      assert.equal(saved.status, "cancelled");
      assert.equal(flagged(saved), false);
      assert.deepEqual(outOfSyncEvents(saved), []);
      assert.deepEqual(alerts, []);
      assert.deepEqual(lines, []);
    });

  // The mute marks live in the jobs store, one per site; two orders
  // built apart share it here as they would in production.
  it("sends an alert for each order failing inside the hour",
    async (t) => {
      const first = await switchedOnce();
      const second = await switchedOnce();

      first.fail.cancelFulfillment = refuse(["SQO"]);
      second.fail.cancelFulfillment = refuse(["SQO"]);

      const a = await cancel(t, first);
      const b = await cancel(t, {
        ...second, stores: { ...second.stores, jobs: first.stores.jobs },
      });

      assert.equal(a.alerts.length, 1);
      assert.equal(b.alerts.length, 1);
      assert.equal(b.lines[0].id, second.id);
    });

  it("sends one alert for the same order inside the hour",
    async (t) => {
      const order = await switchedOnce();

      // As the order's first failed raise left it, a minute ago.
      await mark(order.stores, `alert/${KIND}/${order.id}`, { muted: 0 },
        new Date(now.getTime() - 60_000));
      order.fail.cancelFulfillment = refuse(["SQO"]);

      const { saved, alerts, lines } = await cancel(t, order);

      assert.equal(flagged(saved), true);
      assert.equal(lines.length, 1);
      assert.deepEqual(alerts, []);
    });

  it("names no customer in the alert", async (t) => {
    const order = await switchedOnce();

    order.fail.cancelFulfillment = refuse(["SQC1", "SQO"]);

    const { alerts, lines } = await cancel(t, order);
    const { _time, level, event, kind, ...detail } = lines[0];

    assert.ok(_time && level && event && kind);
    assert.deepEqual(Object.keys(detail).sort(), ["code", "holders", "id"]);
    for (const text of [JSON.stringify(lines[0]),
      JSON.stringify(alerts[0])]) {
      for (const personal of [EMAIL, "Pat", "401-555-0100", "Main St"]) {
        assert.ok(!text.includes(personal), personal);
      }
    }
  });
});
