// The sweep of the suite's leftovers on staging (bin/e2e/sweep.mjs):
// it takes only the suite's own stale open orders, cancels each with
// its refund or, refused, without, and deletes it with its mail.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HOUR, gone, isSuiteEmail, main, stale, summarize, sweepOne,
} from "../bin/e2e/sweep.mjs";
import { runOp } from "../netlify/functions/lib/e2e.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-26T12:00:00Z");
const ago = (ms) => new Date(now.getTime() - ms).toISOString();

const order = (over = {}) => ({
  id: "NFF-2610-AAAA", status: "paid", email: "qa-e2e-api-x9@example.com",
  submittedAt: ago(2 * HOUR), ...over,
});

describe("the e2e sweep", () => {
  it("knows the suite's addresses and no other", () => {
    assert.equal(isSuiteEmail("qa-e2e-api-decline-m3k9@example.com"), true);
    assert.equal(isSuiteEmail("QA-E2E-canned@example.com"), true);
    assert.equal(isSuiteEmail("pat@example.com"), false);
    assert.equal(isSuiteEmail("qa-e2e-x@northfosterfarm.com"), false);
    assert.equal(isSuiteEmail("someone+qa-e2e-x@example.com"), false);
    assert.equal(isSuiteEmail(null), false);
  });

  it("takes only the suite's open orders older than an hour", () => {
    const orders = [
      order(),
      order({ id: "NFF-2610-BBBB", status: "submitted" }),
      order({ id: "NFF-2610-CCCC", email: "pat@example.com" }),
      order({ id: "NFF-2610-DDDD", submittedAt: ago(HOUR / 2) }),
      order({ id: "NFF-2610-EEEE", status: "fulfilled" }),
      order({ id: "NFF-2610-FFFF", status: "cancelled" }),
      order({ id: "NFF-2610-GGGG", submittedAt: null }),
    ];

    assert.deepEqual(stale(orders, { now }).map((o) => o.id),
      ["NFF-2610-AAAA", "NFF-2610-BBBB"]);
    assert.deepEqual(stale(orders, { now, maxAge: 3 * HOUR }), []);
  });

  it("cancels with the refund, deletes, and clears the mail", async () => {
    const calls = [];
    const ops = async (name, args) => {
      calls.push([name, args]);

      return {};
    };
    const done = await sweepOne(order(), { ops });

    assert.equal(done.removed, true);
    assert.deepEqual(calls.map(([n]) => n), [
      "orderCancel", "orderDelete", "customerDelete", "outboxClear",
      "outboxClear",
    ]);
    assert.equal(calls[0][1].refund, undefined, "the refund is on");
    assert.deepEqual(calls[3][1], { to: "qa-e2e-api-x9@example.com" });
    assert.deepEqual(calls[4][1], { subject: "NFF-2610-AAAA" },
      "the farm's own notices about the order go too");
  });

  it("goes on past a record already gone, and past a failing step",
    async () => {
      const calls = [];
      const ops = async (name, args) => {
        calls.push(name);
        // As e2e/support/staging.mjs's op() throws a 404.
        if (name === "customerDelete") {
          throw new Error(
            'e2e customerDelete: 404 {"error":"No such customer."}'
          );
        }
        if (name === "outboxClear" && args.subject) {
          throw new Error("e2e outboxClear: 502 Bad Gateway");
        }

        return {};
      };
      const done = await sweepOne(order(), { ops });

      assert.equal(done.removed, false, "one step failed");
      assert.deepEqual(calls, [
        "orderCancel", "orderDelete", "customerDelete", "outboxClear",
        "outboxClear",
      ], "every step still ran");
      assert.deepEqual(done.notes, [
        "cancelled with refund", "order deleted",
        "customer deleted (already gone)", "mail to the address cleared",
        "mail about the order cleared failed (e2e outboxClear: 502 Bad " +
          "Gateway)",
      ]);
    });

  it("reads the deploy's own 404 as already gone, and nothing else",
    () => {
      for (const message of [
        'e2e customerDelete: 404 {"error":"No such customer."}',
        'e2e orderDelete: 404 {"error":"No such order."}',
        "No such customer.", "Not found.",
      ]) {
        assert.equal(gone(new Error(message)), true, message);
      }
      for (const message of [
        "e2e orderDelete: 502 Bad Gateway", "e2e orderDelete: 400 refused",
        "Square 503", "",
      ]) {
        assert.equal(gone(new Error(message)), false, message);
      }
    });

  it("sweeps every stale order, two at one address and one with no " +
    "customer, and reports them all", async () => {
    const calls = [];
    const customers = new Set(["qa-e2e-api-x9@example.com"]);
    const ops = async (name, args) => {
      calls.push([name, args && args.id]);
      if (name === "ordersList") {
        return { orders: [
          order(),
          order({ id: "NFF-2610-BBBB" }),
          order({ id: "NFF-2610-CCCC", email: "qa-e2e-lone-k2@example.com" }),
          order({ id: "NFF-2610-DDDD", email: "pat@example.com" }),
        ] };
      }
      if (name === "customerDelete" && !customers.delete(args.email)) {
        throw new Error(
          'e2e customerDelete: 404 {"error":"No such customer."}'
        );
      }

      return {};
    };
    const written = [];
    const { results, clean } = await main([], {
      ops, now, out: { write: (t) => written.push(t) },
      base: "https://staging--north-foster-farm.netlify.app", ready: true,
    });

    assert.equal(clean, true);
    assert.deepEqual(results.map((r) => [r.id, r.removed]), [
      ["NFF-2610-AAAA", true], ["NFF-2610-BBBB", true],
      ["NFF-2610-CCCC", true],
    ]);
    assert.match(results[1].notes.join(), /customer deleted \(already gone\)/);
    assert.match(results[2].notes.join(), /customer deleted \(already gone\)/);
    assert.ok(!calls.some(([, id]) => id === "NFF-2610-DDDD"),
      "a stranger's order is never touched");
    assert.match(written[0], /4 open orders read, 3 of the suite's/);
  });

  it("writes the summary and reports unclean when an order is left",
    async () => {
      const ops = async (name) => {
        if (name === "ordersList") {
          return { orders: [order(), order({ id: "NFF-2610-BBBB" })] };
        }
        if (name === "orderCancel") throw new Error("Square 503");

        return {};
      };
      const written = [];
      const { results, clean } = await main([], {
        ops, now, out: { write: (t) => written.push(t) },
        base: "https://staging--north-foster-farm.netlify.app", ready: true,
      });

      assert.equal(clean, false);
      assert.equal(results.length, 2, "the second order was still tried");
      assert.match(written[0],
        /2 of the suite's older than an hour, 0 removed/);
      assert.match(written[0], /NFF-2610-BBBB: cancel failed/);
    });

  it("refuses a host that is not one of the site's branch deploys",
    async () => {
      const quiet = {
        ops: async () => ({ orders: [] }), now, out: { write: () => {} },
        ready: true,
      };

      for (const base of [
        "https://northfosterfarm.com",
        "https://a--b.example.com",
        "https://staging--north-foster-farm.netlify.app.evil.test",
        "https://north-foster-farm.netlify.app",
      ]) {
        await assert.rejects(main([], { ...quiet, base }),
          /not a staging deploy/, base);
      }
      assert.deepEqual(await main([], {
        ...quiet, base: "https://staging--north-foster-farm.netlify.app",
      }), { results: [], clean: true });
    });

  it("cancels without a refund when the refund is refused, and says so",
    async () => {
      const calls = [];
      const ops = async (name, args) => {
        calls.push([name, args]);
        if (name === "orderCancel" && args.refund !== false) {
          throw new Error("Square 503");
        }

        return {};
      };
      const done = await sweepOne(order(), { ops });

      assert.equal(done.removed, true);
      assert.equal(calls[1][1].refund, false);
      assert.match(done.notes[0], /refund refused \(Square 503\)/);
      assert.match(summarize([done]), /NFF-2610-AAAA: refund refused/);
    });

  it("leaves an order it cannot cancel, and touches nothing on a dry run",
    async () => {
      const calls = [];
      const ops = async (name) => {
        calls.push(name);
        throw new Error("no");
      };
      const left = await sweepOne(order(), { ops });

      assert.equal(left.removed, false);
      assert.deepEqual(calls, ["orderCancel", "orderCancel"]);
      assert.match(left.notes[0], /left in place/);

      const dry = await sweepOne(order(), { ops, dryRun: true });

      assert.equal(dry.removed, false);
      assert.equal(calls.length, 2, "a dry run calls nothing");
      assert.match(summarize([dry], { dryRun: true, checked: 1 }),
        /dry run[\s\S]*1 open orders read, 1 of the suite's/);
    });

  it("reads the address and the time from the orders op", async () => {
    const stores = testStores();

    await saveOrder(stores, {
      id: "NFF-2610-AAAA", status: "paid", submittedAt: ago(2 * HOUR),
      customer: { email: "qa-e2e-api-x9@example.com" }, lines: [],
      totals: { total: 700 }, fulfilment: { method: "onfarm" },
    }, now);

    const { body } = await runOp(stores, { op: "ordersList" });

    assert.deepEqual(body.orders, [{
      id: "NFF-2610-AAAA", status: "paid",
      email: "qa-e2e-api-x9@example.com", submittedAt: ago(2 * HOUR),
    }]);
  });
});
