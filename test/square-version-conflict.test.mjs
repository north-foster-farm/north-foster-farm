// Criteria tests for #658, boxes 1 to 3: a version conflict on
// `cancelFulfillment` or `updateFulfillment` is retried with a fresh
// read of the order. Written before the fix, from the issue alone.
// Held out of `npm test` by its name; turn it on with
//
//   git mv test/square-version-conflict.criteria.mjs \
//     test/square-version-conflict.test.mjs
//
// Boxes 4 and 5 are in test/edit-switch-cancel.criteria.mjs, boxes 6
// and 7 in test/version-conflict-658.test.mjs (on today).
//
// THE CONTRACT
//
// Version conflict. Square's answer to a PUT on /v2/orders/{id} that
// carries a stale `version` (recorded in the sandbox, 2026-10-29,
// test/fixtures/square/order-update-stale-version.json):
//
//   400 { errors: [{ code: "VERSION_MISMATCH",
//     category: "INVALID_REQUEST_ERROR", field: "order.version" }] }
//
// It is matched on the error's code, VERSION_MISMATCH, which `failure`
// already puts on the SquareError as `code`. The category is not
// enough: Square's refusal to cancel an order whose fulfillment is
// open (order-cancel-refused, INVALID_VALUE) is the same 400, the same
// category and the same path, and is not retried.
//
// The retry. Both functions, given a version conflict, read the order
// again (GET /v2/orders/{id}) and PUT again at the version that read
// gives. Bounds, as named exports of lib/square.mjs:
//
//   VERSION_TRIES    PUTs in all, the first included: an integer from 2
//                    to 5 ("a few times").
//   VERSION_WAIT_MS  the most all the waits of one call add up to: more
//                    than 0 and at most 5000 ("a short wait").
//
// The wait is injectable, as `retry`'s is in lib/http.mjs: both
// functions take `sleep` beside `env` and `fetchImpl`,
//
//   cancelFulfillment(id, { env, fetchImpl, sleep })
//   updateFulfillment(id, order, { env, fetchImpl, sleep })
//
// and wait only through it (`sleep(ms)`, a promise), at least once
// before a retry. It defaults to a real timer. The tests pass one that
// returns at once and notes `ms`.
//
// A conflict that never clears throws Square's last refusal as
// `failure` raises it (status 400, code VERSION_MISMATCH) after
// VERSION_TRIES PUTs. Any other error throws as today, at once: no
// second read, no second PUT, no wait.
//
// The saved record when the cancel fails for good, and the
// `square.update_failed` line: see test/edit-switch-cancel.criteria.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sampleOrder } from "../bin/fixtures/request.mjs";
import * as square from "../netlify/functions/lib/square.mjs";
import { body, recorded } from "./recorded.mjs";
import { conflict } from "./version-conflict.mjs";

const SANDBOX = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOCATION_ID_1",
};
const ID = "ORDER_ID_5";

// A recorded order, as a later read finds it: the same order at a
// newer version, as Square leaves it once a refund has landed.
const orderAt = (name, version) => {
  const answer = body("square", name);

  answer.order.version = version;

  return { status: 200, response: answer };
};
const answer = (name) => {
  const { status, response } = recorded("square", name);

  return { status, response };
};

// A fetch that answers each request with `respond(request, n)`, a
// recorded { status, response }, and keeps every request it was sent.
// A request it has no answer for gets a 404, so the call throws.
const UNEXPECTED = { status: 404, response: {} };
const fakeSquare = (respond) => {
  const requests = [];
  const impl = async (url, init = {}) => {
    const request = {
      method: init.method || "GET",
      path: new URL(url).pathname,
      body: init.body ? JSON.parse(init.body) : null,
    };

    requests.push(request);

    const { status, response } = respond(request, requests.length)
      || UNEXPECTED;

    return new Response(JSON.stringify(response), {
      status, headers: { "Content-Type": "application/json" },
    });
  };

  return { impl, requests };
};

// Answers in turn, one per request.
const inTurn = (...answers) => fakeSquare((_, n) => answers[n - 1]);

// A sleep that returns at once and notes what it was asked to wait.
const waits = () => {
  const asked = [];

  return { asked, sleep: async (ms) => { asked.push(ms); } };
};

const deliveryOrder = () => sampleOrder({
  kind: "delivery", email: "customer@example.com",
});

// Each function, run against a fake, with the wait it was given.
const FUNCTIONS = [
  {
    name: "cancelFulfillment",
    order: "order-get-paid-external",
    run: (fetchImpl, sleep) => square.cancelFulfillment(ID, {
      env: SANDBOX, fetchImpl, sleep,
    }),
  },
  {
    name: "updateFulfillment",
    order: "order-get-open",
    run: (fetchImpl, sleep) => square.updateFulfillment(ID, deliveryOrder(), {
      env: SANDBOX, fetchImpl, sleep,
    }),
  },
];

const thrown = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("it throws");
};

const versionOf = (request) => request.body.order.version;
const methods = (requests) => requests.map((r) => r.method);

describe("#658: a version conflict is retried with a fresh read", () => {
  it("box 1: cancelFulfillment reads the order again after Square's " +
    "version conflict and succeeds on a later try", async () => {
    const first = recorded("square", "order-get-paid-external");
    const stale = first.response.order.version;
    const net = inTurn(
      answer("order-get-paid-external"),
      conflict(),
      orderAt("order-get-paid-external", stale + 1),
      answer("fulfillment-cancel"),
    );
    const { asked, sleep } = waits();
    const result = await square.cancelFulfillment(ID, {
      env: SANDBOX, fetchImpl: net.impl, sleep,
    });

    assert.deepEqual(result, { id: ID, cancelled: true });
    assert.deepEqual(methods(net.requests), ["GET", "PUT", "GET", "PUT"]);
    assert.equal(versionOf(net.requests[1]), stale);
    assert.equal(versionOf(net.requests[3]), stale + 1,
      "the retry carries the version the fresh read gave");
    assert.deepEqual(net.requests[3].body.order.fulfillments,
      net.requests[1].body.order.fulfillments,
      "the retry cancels the same fulfillment");
    assert.ok(asked.length >= 1, "it waited, through the injected sleep");
  });

  it("box 2: updateFulfillment reads the order again after Square's " +
    "version conflict and succeeds on a later try", async () => {
    const first = recorded("square", "order-get-open");
    const stale = first.response.order.version;
    const net = inTurn(
      answer("order-get-open"),
      conflict(),
      orderAt("order-get-open", stale + 1),
      answer("order-update-fulfillment"),
    );
    const { asked, sleep } = waits();
    const result = await square.updateFulfillment(ID, deliveryOrder(), {
      env: SANDBOX, fetchImpl: net.impl, sleep,
    });

    assert.equal(result.id, ID);
    assert.equal(result.version,
      recorded("square", "order-update-fulfillment").response.order.version);
    assert.deepEqual(methods(net.requests), ["GET", "PUT", "GET", "PUT"]);
    assert.equal(versionOf(net.requests[1]), stale);
    assert.equal(versionOf(net.requests[3]), stale + 1,
      "the retry carries the version the fresh read gave");
    assert.deepEqual(net.requests[3].body.order.fulfillments,
      net.requests[1].body.order.fulfillments,
      "the retry sends the same change");
    assert.ok(asked.length >= 1, "it waited, through the injected sleep");
  });

  it("box 3: an error that is not a version conflict is not retried",
    async () => {
      const other = recorded("square", "order-cancel-refused");

      for (const fn of FUNCTIONS) {
        const net = inTurn(answer(fn.order), answer("order-cancel-refused"));
        const { asked, sleep } = waits();
        const error = await thrown(fn.run(net.impl, sleep));

        assert.equal(error.status, other.status, fn.name);
        assert.equal(error.code, other.response.errors[0].code, fn.name);
        assert.deepEqual(methods(net.requests), ["GET", "PUT"],
          `${fn.name}: one read, one PUT`);
        assert.deepEqual(asked, [], `${fn.name}: no wait`);
      }
    });

  it("box 3: a version conflict that never clears fails after " +
    "VERSION_TRIES tries and at most VERSION_WAIT_MS of waiting",
  async () => {
    const tries = square.VERSION_TRIES;
    const most = square.VERSION_WAIT_MS;

    assert.ok(Number.isInteger(tries) && tries >= 2 && tries <= 5,
      `VERSION_TRIES is a named constant from 2 to 5 (got ${tries})`);
    assert.ok(Number.isFinite(most) && most > 0 && most <= 5000,
      `VERSION_WAIT_MS is a named constant over 0, at most 5000 (${most})`);

    const recordedConflict = conflict();

    for (const fn of FUNCTIONS) {
      const start = recorded("square", fn.order).response.order.version;
      let reads = 0;
      // Every read finds a newer version, and every PUT is refused.
      const net = fakeSquare((request) => (request.method === "GET"
        ? orderAt(fn.order, start + reads++)
        : recordedConflict));
      const { asked, sleep } = waits();
      const error = await thrown(fn.run(net.impl, sleep));
      const puts = net.requests.filter((r) => r.method === "PUT");
      const waited = asked.reduce((sum, ms) => sum + ms, 0);

      assert.equal(error.status, recordedConflict.status, fn.name);
      assert.equal(error.code, recordedConflict.response.errors[0].code,
        fn.name);
      assert.equal(puts.length, tries, `${fn.name}: VERSION_TRIES PUTs`);
      assert.equal(net.requests.length, 2 * tries,
        `${fn.name}: a fresh read before every PUT`);
      assert.ok(waited > 0, `${fn.name}: it waited between tries`);
      assert.ok(waited <= most,
        `${fn.name}: waited ${waited} ms, more than VERSION_WAIT_MS`);
    }
  });
});
