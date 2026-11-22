// Criteria tests for #827, phase 13 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 13: sending"), held out of
// `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/send.criteria.mjs test/send.test.mjs
//
// All nine criteria are of the new-module kind: they fail on `next`,
// where form/send.js does not exist, and pass once the phase moves
// sending there with its collaborators as arguments. Nothing retires:
// submit.test.mjs tests Submitter, which does not move.
//
// Contract. The design says only that `Send` takes its collaborators
// as arguments so that this test drives it with fakes and Node's mock
// timers; the seam below is the test agent's choice. The call shape
// may be adapted, the expected values may not. The fakes are the
// page's own parts (no network): Submitter's outcomes are its
// documented shapes (assets/scripts/order/submit.js).
//
//   paymentFor({ editing, due, covered })  -> "none" | "credit" | "card"
//     editing  a paid order is being changed; due  cents still to pay;
//     covered  credit covers the order
//   invalidRoute(errors)                   -> "pass" | "group" | "fields"
//   new Send({ submitter, draft, view, crumb, way, editing, prepare,
//     due, covered, tokenize })
//     submitter  { send(payload) -> outcome }
//     draft      { markAttempted(), nextAttempt(), clear(),
//                clearPending() }
//     view       { busy(on), succeed(data, payload), toOrders(),
//                cartCount(n), failed(payload, message),
//                locked(message), payFail(message), lapse(way, dates),
//                ... }: the page's answers
//     crumb      (name) -> void, report.js's
//     way, editing, prepare, due, covered: () -> the form's; prepare
//                is async and gives the payload or null
//     tokenize   (payload) -> the card's source, async
//   send.press()            the Pay button's press
//   send.deliver(payload)   -> the outcome, acted on

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  Send, invalidRoute, paymentFor,
} from "../assets/scripts/order/form/send.js";

const PAYLOAD = Object.freeze({
  customer: { firstName: "Ada", email: "ada@example.com" },
  lines: [{ sku: "NFF-CHK-EGG-LG", qty: 2 }],
  fulfilment: { method: "delivery", date: "2026-12-10" },
  meta: { idempotencyKey: "key-1" },
});
const SOURCE = { method: "card", sourceId: "cnon:card-nonce-ok" };
const DATA = { orderId: "NFF-2612-QA61", customer: { firstName: "Ada" } };

// A Send over fakes that record every call. `answers` are the
// submitter's outcomes, in order.
const rig = ({ answers = [], editing = null, way = "delivery", due = 1900,
  covered = false } = {}) => {
  const calls = [];
  const note = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const sent = [];
  const queue = [...answers];
  const crumbs = [];
  const view = new Proxy({}, { get: (_, name) => note(`view.${name}`) });
  const draft = new Proxy({}, { get: (_, name) => note(`draft.${name}`) });
  const send = new Send({
    submitter: { send: async (payload) => {
      sent.push(payload);

      return queue.shift() ?? { kind: "ok", data: DATA };
    } },
    draft, view,
    crumb: (name) => crumbs.push(name),
    way: () => way,
    editing: () => editing,
    prepare: async () => PAYLOAD,
    due: () => due,
    covered: () => covered,
    tokenize: async () => SOURCE,
  });
  const called = (name) => calls.filter(([n]) => n === name);

  return { send, sent, crumbs, calls, called };
};

// Box 1 of #827.
describe("paymentFor", () => {
  it("is none for a change with nothing more to pay, credit when credit "
    + "covers the order, and the card otherwise", () => {
    assert.equal(paymentFor({ editing: true, due: 0, covered: false }),
      "none");
    assert.equal(paymentFor({ editing: true, due: -500, covered: true }),
      "none");
    assert.equal(paymentFor({ editing: false, due: 0, covered: true }),
      "credit");
    assert.equal(paymentFor({ editing: true, due: 700, covered: true }),
      "credit");
    assert.equal(paymentFor({ editing: false, due: 1900, covered: false }),
      "card");
    assert.equal(paymentFor({ editing: true, due: 700, covered: false }),
      "card");
  });
});

// Box 2 of #827.
describe("invalidRoute", () => {
  it("sends a refused pass to the pass, a refused group code to the group, "
    + "and anything else to the fields", () => {
    assert.equal(invalidRoute({ pass: "That pass has been used." }), "pass");
    assert.equal(invalidRoute({ groupCode: "That code has changed." }),
      "group");
    assert.equal(invalidRoute({ pass: "x", groupCode: "y" }), "pass");
    assert.equal(invalidRoute({ "customer.email": "Enter an email." }),
      "fields");
    assert.equal(invalidRoute({ total: "The total changed." }), "fields");
  });
});

describe("Send, getting through", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  // Let the microtasks between two awaits run.
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // Box 3 of #827.
  it("sends a send that cannot get through once more, 3 seconds later, "
    + "with the same payload", async () => {
    const { send, sent } = rig({ answers: [{ kind: "retry" },
      { kind: "ok", data: DATA }] });
    const done = send.deliver(PAYLOAD);

    await settle();
    assert.equal(sent.length, 1);
    mock.timers.tick(2999);
    await settle();
    assert.equal(sent.length, 1, "not before 3 seconds");
    mock.timers.tick(1);
    await settle();
    assert.equal(sent.length, 2, "once more at 3 seconds");
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(sent[1], sent[0], "the same payload");
    assert.equal((await done).kind, "ok");
  });

  // Box 4 of #827.
  it("shows the failed card after a second failure to get through, and "
    + "sends nothing more", async () => {
    const { send, sent, called } = rig({ answers: [{ kind: "retry" },
      { kind: "retry" }, { kind: "ok", data: DATA }] });
    const done = send.deliver(PAYLOAD);

    await settle();
    mock.timers.tick(3000);
    await done;
    mock.timers.tick(10_000);
    await settle();

    assert.equal(sent.length, 2);
    assert.equal(called("view.failed").length, 1);
    assert.equal(called("view.failed")[0][1], PAYLOAD);
    assert.equal(called("view.succeed").length, 0);
  });
});

// Box 5 of #827.
describe("Send, a payment refused", () => {
  it("starts a new attempt and says why by Pay, for a declined payment "
    + "and for one that disagrees with its order", async () => {
    for (const outcome of [
      { kind: "declined", code: "CARD_DECLINED",
        message: "The card was declined." },
      { kind: "checkout", message: "The total changed. Pay again." },
    ]) {
      const { send, called } = rig({ answers: [outcome] });

      await send.deliver(PAYLOAD);
      assert.equal(called("draft.nextAttempt").length, 1, outcome.kind);
      assert.deepEqual(called("view.payFail").map(([, m]) => m),
        [outcome.message], outcome.kind);
      assert.equal(called("view.failed").length, 0, outcome.kind);
    }
  });
});

// Box 6 of #827.
describe("Send, a stale answer", () => {
  it("opens the lapsed dialog for the chosen way", async () => {
    const dates = [{ date: "2026-12-17" }];

    for (const way of ["delivery", "group", "scheduled", "onfarm"]) {
      const { send, called } = rig({ way,
        answers: [{ kind: "stale", dates }] });

      await send.deliver(PAYLOAD);
      assert.deepEqual(called("view.lapse").map(([, w, d]) => [w, d]),
        [[way, dates]], way);
    }
  });
});

// Box 7 of #827.
describe("Send, a refusal", () => {
  it("shows the locked card for a refusal that locks a paid order, and the "
    + "failed card for any other failure", async () => {
    const lockedOut = { kind: "failed", locked: true,
      message: "This order can't be changed any more." };
    const changing = rig({ answers: [lockedOut],
      editing: { id: "NFF-2612-QA61", held: 6100, kept: 0 } });

    await changing.send.deliver(PAYLOAD);
    assert.deepEqual(changing.called("view.locked").map(([, m]) => m),
      [lockedOut.message]);
    assert.equal(changing.called("view.failed").length, 0);

    for (const [outcome, editing] of [
      [lockedOut, null],
      [{ kind: "failed", message: "Something went wrong placing your "
        + "order." }, null],
      [{ kind: "failed", message: "Something went wrong." },
        { id: "NFF-1", held: 1, kept: 0 }],
    ]) {
      const { send, called } = rig({ answers: [outcome], editing });

      await send.deliver(PAYLOAD);
      assert.equal(called("view.locked").length, 0);
      assert.deepEqual(called("view.failed").map(([, p, m]) => [p, m]),
        [[PAYLOAD, outcome.message]]);
    }
  });
});

// Box 8 of #827.
describe("Send, paid", () => {
  it("clears the draft and zeroes the header's count for a paid new "
    + "order, and clears its draft and goes to the account's orders for a "
    + "paid change", async () => {
    const fresh = rig();

    await fresh.send.deliver(PAYLOAD);
    assert.equal(fresh.called("draft.clear").length, 1);
    assert.deepEqual(fresh.called("view.cartCount").map(([, n]) => n), [0]);
    assert.equal(fresh.called("view.succeed").length, 1);
    assert.equal(fresh.called("view.toOrders").length, 0);

    const change = rig({ editing: { id: "NFF-1", held: 1400, kept: 0 } });

    await change.send.deliver(PAYLOAD);
    assert.equal(change.called("draft.clear").length, 1);
    assert.equal(change.called("view.toOrders").length, 1);
    assert.equal(change.called("view.cartCount").length, 0);
    assert.equal(change.called("view.succeed").length, 0);
  });
});

// Box 9 of #827.
describe("Send, crumbs", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("leaves one crumb on the press, and one on the answer: pay.ok or "
    + "pay.failed", async () => {
    const ok = rig();

    await ok.send.press();
    assert.deepEqual(ok.crumbs, ["pay.press", "pay.ok"]);
    assert.equal(ok.sent.length, 1);
    assert.deepEqual(ok.sent[0].payment, SOURCE, "the card's source");

    const declined = rig({ answers: [{ kind: "declined",
      message: "The card was declined." }] });

    await declined.send.press();
    assert.deepEqual(declined.crumbs, ["pay.press", "pay.failed"]);

    // Two sends, one answer.
    const twice = rig({ answers: [{ kind: "retry" }, { kind: "retry" }] });
    const pressed = twice.send.press();

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(3000);
    await pressed;
    assert.deepEqual(twice.crumbs, ["pay.press", "pay.failed"]);
  });
});
