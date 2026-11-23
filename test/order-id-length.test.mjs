// Criteria tests for #937 (the order id pattern matches only
// four-character ids), written from the issue before the fix, one
// describe per box of its "Done when" list marked (test).
//
// Since #253 the site draws six characters after the second dash
// (ID_LENGTH in orders.mjs, NFF-2610-AAAAAA), but ORDER_ID in
// lib/order-id.mjs and SITE_REFERENCE in lib/square.mjs still take
// four. So the Square sweep (jobs.leftOpen) never sweeps a new order
// and the drift check (drift.applyOrderEvent) calls every new order
// "not a website order". The fix reads the length from ID_LENGTH and
// still takes the four-character ids from before #253.
//
// Provisional: box 6 says SITE_REFERENCE "accepts both lengths, for
// NFF- and NFM-". A member ID is always NFM- and 4-4 (member-id.mjs),
// so NFM- with six after the second dash is tested as the issue words
// it, not because the site writes one. Box 8 says "the log line for
// each swept order": the sweep logs no line per order, so what is
// held is the line a failed cancel logs (jobs.step_failed, one per
// order), the jobs.run summary and the sweep's item for each order,
// each the same shape for a six-character id as for a four-character
// one. The drift finding's line is square.drift. The issue's "to
// settle" (when it ships) changes nothing here.
//
// Held out of runs as order-id-length.criteria.mjs until the fix
// renames it to order-id-length.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyOrderEvent } from "../netlify/functions/lib/drift.mjs";
import {
  leftOpen, runJobs, sweepSquareOrders,
} from "../netlify/functions/lib/jobs.mjs";
import { newMemberId } from "../netlify/functions/lib/member-id.mjs";
import { ORDER_ID } from "../netlify/functions/lib/order-id.mjs";
import { getOrder, saveOrder } from "../netlify/functions/lib/records.mjs";
import {
  SITE_VERSION, buildOrder, replaceableReference,
} from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { ID_LENGTH, orderId } from "../netlify/functions/orders.mjs";

const NOW = new Date("2026-10-23T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const PLACED = new Date(NOW.getTime() - 2 * DAY);
const SQUARE_ENV = { SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC" };
const FARM = { FARM_NOTIFICATIONS_EMAIL: "farm@example.com" };

// Ids as the site draws them now and as it drew them before #253.
const SIX = "NFF-2610-AAAAAA";
const FOUR = "NFF-2610-K3WM";

const tail = (id) => id.split("-")[2];

// Every console line a run writes, parsed where it is JSON.
const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      const text = args.map(String).join(" ");

      try {
        lines.push(JSON.parse(text));
      } catch {
        lines.push({ text });
      }
    });
  }

  return lines;
};

// A line's shape: its keys and the type of each value, without the
// time, which differs run to run.
const shapeOf = (line) => Object.fromEntries(Object.entries(line)
  .filter(([k]) => k !== "_time")
  .map(([k, v]) => [k, Array.isArray(v) ? "array" : typeof v])
  .sort(([a], [b]) => (a < b ? -1 : 1)));

// --- The Square sweep's fakes, as in jobs.test.mjs -------------------

const open = (id, referenceId, extra = {}) => ({
  id, referenceId, siteVersion: SITE_VERSION,
  createdAt: PLACED.toISOString(), tenders: 0, total: 1200, ...extra,
});

const fakeSquare = (found, { fails = [] } = {}) => {
  const calls = [];

  return {
    calls,
    searchOpenOrders: async ({ before }) => {
      calls.push(["search", before.toISOString()]);

      return found;
    },
    cancelOrder: async (id, { unpaid }) => {
      calls.push(["cancel", id, unpaid]);
      if (fails.includes(id)) throw new Error("Square 500");

      return { id, cancelled: true };
    },
  };
};

// --- The drift check's fakes, as in drift.test.mjs --------------------

const record = (id) => ({
  id,
  status: "paid",
  submittedAt: "2026-10-20T12:00:00Z",
  paidAt: "2026-10-20T12:00:00Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [
    { sku: "EGG", name: "Eggs", label: "Eggs", qty: 2, unitPrice: 7 },
  ],
  totals: { subtotal: 14, discountAmount: 0, deliveryFee: 0, total: 14 },
  fulfilment: {
    method: "delivery",
    date: "2026-10-28",
    delivery: {
      address1: "1 Farm Rd", town: "Scituate", state: "RI", zip: "02857",
      cooler: "yes",
    },
  },
  flags: {},
  square: { squareOrderId: "SQ-1", customerId: "C-1" },
  payments: [{
    via: "square", method: "card", amount: 14, squarePaymentId: "PAY-1",
  }],
  history: [{ at: "2026-10-20T12:00:00Z", event: "paid" }],
});

// Square's copy of the record, canceled in the Square Dashboard, so
// the check has a finding to report.
const canceledCopy = (o) => {
  const built = buildOrder(o, "C-1", { locationId: "L", catalog: false });

  return {
    ...built,
    id: o.square.squareOrderId,
    state: "CANCELED",
    fulfillments: built.fulfillments.map((f) => ({ ...f, state: "PROPOSED" })),
  };
};

const updated = (squareId) => ({
  type: "order.updated",
  data: { object: {
    order_updated: { order_id: squareId, state: "CANCELED" },
  } },
});

const driftOf = async (id) => {
  const stores = testStores();
  const o = record(id);
  const sent = [];

  await saveOrder(stores, o, NOW);

  const r = await applyOrderEvent(stores, updated("SQ-1"), {
    env: FARM, now: NOW,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
    square: {
      getOrder: async (sq) => (sq === "SQ-1" ? canceledCopy(o) : null),
    },
  });

  return { r, sent };
};

// ----------------------------------------------------------------------

describe("ORDER_ID matches an id as the site draws it today, six " +
  "characters after the second dash", () => {
  it("the site draws ID_LENGTH characters, six", () => {
    assert.equal(ID_LENGTH, 6);
    assert.equal(tail(orderId("criteria-key-0000", NOW)).length, ID_LENGTH);
  });

  it("matches the issue's example and ids orderId draws", () => {
    assert.ok(ORDER_ID.test(SIX), SIX);

    for (let draw = 0; draw < 20; draw++) {
      const id = orderId(`criteria-key-${draw}`, NOW, draw);

      assert.ok(ORDER_ID.test(id), id);
    }
  });
});

describe("It still matches a four-character id from before #253", () => {
  it("matches NFF-YYMM- and four letters and digits", () => {
    for (const id of [FOUR, "NFF-2601-ABCD", "NFF-2512-2345"]) {
      assert.ok(ORDER_ID.test(id), id);
    }
  });
});

describe("It refuses other lengths and shapes: five and seven " +
  "characters, lower case, a missing part", () => {
  it("refuses five and seven characters", () => {
    assert.ok(!ORDER_ID.test("NFF-2610-AAAAA"), "five");
    assert.ok(!ORDER_ID.test("NFF-2610-AAAAAAA"), "seven");
  });

  it("refuses the other lengths around them too", () => {
    for (const n of [0, 1, 2, 3, 8, 12]) {
      const id = `NFF-2610-${"A".repeat(n)}`;

      assert.ok(!ORDER_ID.test(id), id);
    }
  });

  it("refuses lower case", () => {
    for (const id of ["nff-2610-aaaaaa", "NFF-2610-aaaaaa",
      "nff-2610-K3WM", "NFF-2610-k3wm", "NFF-2610-AAAaAA"]) {
      assert.ok(!ORDER_ID.test(id), id);
    }
  });

  it("refuses a missing part", () => {
    for (const id of ["", "NFF", "NFF-", "NFF-2610", "NFF-2610-",
      "NFF--AAAAAA", "-2610-AAAAAA", "2610-AAAAAA", "NFF-AAAAAA",
      "NFF2610AAAAAA", "NFF-2610AAAAAA"]) {
      assert.ok(!ORDER_ID.test(id), JSON.stringify(id));
    }
  });

  it("refuses other shapes", () => {
    for (const id of ["NFM-2610-AAAAAA", "NFX-2610-AAAA", "NFF-261-AAAAAA",
      "NFF-26100-AAAAAA", "NFF-26AB-AAAAAA", ` ${SIX}`, `${SIX} `,
      `${SIX}\n`, `${SIX}-X`, "NFF-2610-AAA-AA", "NFF-2610-AAAA_A",
      "INV-0042", "walk-in"]) {
      assert.ok(!ORDER_ID.test(id), JSON.stringify(id));
    }
  });
});

describe("jobs.leftOpen sweeps an abandoned Square order whose " +
  "reference is a six-character id", () => {
  it("leftOpen counts it", () => {
    assert.equal(leftOpen(open("SQ-6", SIX)), true);
    assert.equal(leftOpen(open("SQ-4", FOUR)), true, "and a four");
  });

  it("the sweep reports it and cancels it, unpaid only", async () => {
    const stores = testStores();
    const square = fakeSquare([open("SQ-6", SIX), open("SQ-4", FOUR)]);
    const found = await sweepSquareOrders(stores, {
      env: SQUARE_ENV, now: NOW, square,
    });

    assert.deepEqual(found, [
      { squareOrderId: "SQ-6", orderId: SIX,
        createdAt: PLACED.toISOString(), total: 1200, cancelled: true },
      { squareOrderId: "SQ-4", orderId: FOUR,
        createdAt: PLACED.toISOString(), total: 1200, cancelled: true },
    ]);
    assert.deepEqual(square.calls.filter((c) => c[0] === "cancel"),
      [["cancel", "SQ-6", true], ["cancel", "SQ-4", true]]);
  });

  it("still skips a six-character order that is paid, untagged, " +
    "recorded or waiting on a checkout (guard)", async () => {
    const stores = testStores();

    assert.equal(leftOpen(open("SQ", SIX, { tenders: 1 })), false);
    assert.equal(leftOpen(open("SQ", SIX, { siteVersion: null })), false);

    await saveOrder(stores, record("NFF-2610-PAIDAB"), NOW);
    assert.ok(await getOrder(stores, "NFF-2610-PAIDAB"));

    const square = fakeSquare([open("SQ-REC", "NFF-2610-PAIDAB")]);

    assert.deepEqual(await sweepSquareOrders(stores, {
      env: SQUARE_ENV, now: NOW, square,
    }), []);
    assert.ok(!square.calls.some((c) => c[0] === "cancel"));
  });
});

describe("The drift check treats an order with a six-character " +
  "reference as a website order and checks it", () => {
  it("finds the record by a six-character reference and flags it",
    async (t) => {
      capture(t);

      const { r, sent } = await driftOf(SIX);

      assert.notEqual(r.reason, "not a website order");
      assert.deepEqual([r.handled, r.status, r.id], [true, "flagged", SIX]);
      assert.equal(sent.length, 1, "the farm is told");
    });

  it("still checks a four-character reference (guard)", async (t) => {
    capture(t);

    const { r } = await driftOf(FOUR);

    assert.deepEqual([r.handled, r.status, r.id], [true, "flagged", FOUR]);
  });

  it("a six-character reference with no record is \"no record\", not " +
    "\"not a website order\"", async () => {
    const r = await applyOrderEvent(testStores(), updated("SQ-9"), {
      env: FARM, now: NOW,
      square: { getOrder: async () => ({ id: "SQ-9", reference_id: SIX }) },
    });

    assert.deepEqual(r, { handled: false, reason: "no record" });
  });

  it("still leaves an order the site did not make alone (guard)",
    async () => {
      for (const reference of ["walk-in", "NFF-2610-AAAAA", null]) {
        const r = await applyOrderEvent(testStores(), updated("POS-1"), {
          env: FARM, now: NOW,
          square: { getOrder: async () => ({
            id: "POS-1", reference_id: reference,
          }) },
        });

        assert.deepEqual(r, { handled: false, reason: "not a website order" },
          String(reference));
      }
    });
});

describe("SITE_REFERENCE in lib/square.mjs accepts both lengths, for " +
  "NFF- and NFM-", () => {
  it("accepts an order id of either length", () => {
    assert.ok(replaceableReference(FOUR), FOUR);
    assert.ok(replaceableReference(SIX), SIX);
    assert.ok(replaceableReference(orderId("criteria-key-0000", NOW)),
      "an id orderId draws");
  });

  it("accepts a member ID, and NFM- with either length", () => {
    assert.ok(replaceableReference(newMemberId()), "a member ID");
    assert.ok(replaceableReference("NFM-K3WM-7QPA"), "NFM- and four");
    assert.ok(replaceableReference("NFM-K3WM-7QPAXY"), "NFM- and six");
  });

  it("still refuses other lengths and what someone typed (guard)", () => {
    for (const value of ["NFF-2610-AAAAA", "NFF-2610-AAAAAAA",
      "NFM-K3WM-7QPAX", "NFM-K3WM-7QPAXYZ", "nff-2610-aaaaaa",
      "LOYALTY-0042", "NFX-2610-AAAAAA"]) {
      assert.ok(!replaceableReference(value), value);
    }
  });
});

describe("The log line for each swept order and each drift finding is " +
  "unchanged in shape", () => {
  // One sweep through runJobs with one order whose cancel fails, so it
  // logs its jobs.step_failed line and the run its jobs.run line.
  const sweepLines = async (t, id) => {
    const lines = capture(t);
    const stores = testStores();
    const square = fakeSquare([open("SQ-1", id)], { fails: ["SQ-1"] });
    const r = await runJobs(stores, {
      env: SQUARE_ENV, square, now: NOW, realNow: NOW,
      mail: async () => ({ id: "m", driver: "test" }),
    });

    return {
      item: r.squareOpen,
      failed: lines.filter((l) => l.event === "jobs.step_failed"
        && l.step === "squareCancel"),
      run: lines.filter((l) => l.event === "jobs.run" && !l.scope),
    };
  };

  it("a swept order's lines and item have the four-character shape",
    async (t) => {
      const four = await sweepLines(t, FOUR);

      t.mock.restoreAll();

      const six = await sweepLines(t, SIX);

      assert.equal(four.failed.length, 1, "the guard's own line");
      assert.equal(six.failed.length, 1, "one line for the six");
      assert.deepEqual(shapeOf(six.failed[0]), shapeOf(four.failed[0]));
      assert.deepEqual(shapeOf(six.failed[0]), {
        error: "string", event: "string", id: "string", level: "string",
        step: "string",
      });
      assert.equal(six.failed[0].id, SIX, "the id logged whole");

      assert.equal(six.run.length, 1);
      assert.deepEqual(shapeOf(six.run[0]), shapeOf(four.run[0]));
      assert.equal(six.run[0].counts.squareOpen, 1);
      assert.deepEqual(six.run[0].counts, four.run[0].counts);

      assert.equal(six.item.length, 1);
      assert.deepEqual(shapeOf(six.item[0]), shapeOf(four.item[0]));
      assert.deepEqual(Object.keys(six.item[0]), [
        "squareOrderId", "orderId", "createdAt", "total", "cancelled",
        "error",
      ]);
    });

  it("a drift finding's square.drift line has the four-character shape",
    async (t) => {
      const lines = capture(t);

      await driftOf(FOUR);
      await driftOf(SIX);

      const drift = lines.filter((l) => l.event === "square.drift");

      assert.equal(drift.length, 2, "one line for each length");

      const [four, six] = drift;

      assert.deepEqual(shapeOf(six), shapeOf(four));
      assert.deepEqual(shapeOf(six), {
        changes: "array", event: "string", id: "string", level: "string",
        printed: "boolean",
      });
      assert.equal(six.level, "warn");
      assert.equal(six.id, SIX, "the id logged whole");
      assert.deepEqual(six.changes, four.changes);
    });
});
