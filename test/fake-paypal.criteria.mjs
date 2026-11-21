// #708, last box: "fake-paypal.mjs ... answer[s] with those shapes",
// for the capture, the order read and the refund. One test each.
//
// The seam assumed: lib/paypal.mjs's public functions (captureOrder,
// getOrder, refundCapture) under PAYPAL_ENV=fake and SITE_CONTEXT=dev
// answer through lib/fake-paypal.mjs, as they do today. Each test runs
// the same function twice: once on the fake, and once on the real code
// (PAYPAL_ENV=sandbox) against a fetch that answers with the recorded
// fixture from test/fixtures/paypal/. The two answers must have the
// same keys and nesting, and the recording's values wherever the fake
// has no reason to differ (status, payer). What the fake puts in from
// the request (ids, the amount) may differ and is checked as put in.
//
// The fake reads its recordings through lib/fake.mjs's `recorded()`,
// so a test can point FIXTURES_DIR at a doctored copy of the fixtures
// and see the fake's answer follow it: the proof that the answer comes
// from the recording and not from an object written by hand.
//
// Fixtures are found by what they recorded (method, path, status), not
// by file name, since the scrubber names them.
//
// Held out of `npm test` (the glob is *.test.mjs) until the swap lands:
//   node --import ./test/setup.mjs --test test/fake-paypal.criteria.mjs

import assert from "node:assert/strict";
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureOrder, createOrder, forgetTokens, getOrder, refundCapture,
} from "../netlify/functions/lib/paypal.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PAYPAL = join(FIXTURES, "paypal");

const FAKE_ENV = { PAYPAL_ENV: "fake", SITE_CONTEXT: "dev" };
const REAL_ENV = {
  PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s",
};
const fake = { env: FAKE_ENV, recordings: null };

// An order of ours, at a total unlike the recording's, so an amount the
// fake copied from the recording instead of putting in shows.
const ORDER = { id: "NFF-2611-CRIT", totals: { total: 700 } };

const ok = (status) => status >= 200 && status < 300;

// Every recorded PayPal exchange: { file, status, request, response }.
// The older hand-posted refusal (refund-422-insufficient-funds) has no
// request and is not one.
const recordings = (dir = PAYPAL) => readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }))
  .filter((r) => r.request);

const KINDS = {
  capture: (r) => r.request.method === "POST"
    && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(r.request.path)
    && ok(r.status) && r.response.status === "COMPLETED",
  "order read": (r) => r.request.method === "GET"
    && /^\/v2\/checkout\/orders\/[^/]+$/.test(r.request.path)
    && r.status === 200 && r.response.status === "CREATED",
  refund: (r) => r.request.method === "POST"
    && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(r.request.path)
    && ok(r.status),
};

const recordingOf = (kind) => {
  const found = recordings().find(KINDS[kind]);

  assert.ok(found, `no recorded PayPal ${kind} in test/fixtures/paypal/`);

  return found;
};

// The real code's fetch: a token (never recorded: its answer is a
// secret), then the one recording.
const answering = (recording) => async (url) => {
  const { pathname } = new URL(url);
  const body = pathname === "/v1/oauth2/token"
    ? { "access_token": "tok", "expires_in": 3600 }
    : recording.response;

  return new Response(JSON.stringify(body), {
    status: pathname === "/v1/oauth2/token" ? 200 : recording.status,
    headers: { "Content-Type": "application/json" },
  });
};
const real = (recording) => ({
  env: REAL_ENV, fetchImpl: answering(recording), recordings: null,
});

// The id in a recorded path, after `before` (orders, captures).
const idIn = (path, before) => path.split("/")[path.split("/")
  .indexOf(before) + 1];

// Keys and nesting, every leaf replaced by its type.
const shapeOf = (node) => {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node)
      .map(([key, value]) => [key, shapeOf(value)]));
  }

  return node === null ? "null" : typeof node;
};

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// A copy of every fixture, with each PayPal recording of `kind` changed
// by `change`, for FIXTURES_DIR. -> its folder.
let doctored = null;
const doctor = (kind, change) => {
  doctored = mkdtempSync(join(tmpdir(), "paypal-criteria-"));
  cpSync(FIXTURES, doctored, { recursive: true });
  const dir = join(doctored, "paypal");
  let changed = 0;

  for (const r of recordings(dir).filter(KINDS[kind])) {
    const { file, ...json } = r;

    change(json.response);
    writeFileSync(join(dir, file), JSON.stringify(json, null, 2));
    changed += 1;
  }
  assert.ok(changed, `no recorded PayPal ${kind} to change`);
  process.env.FIXTURES_DIR = doctored;
};

const was = process.env.FIXTURES_DIR;

beforeEach(() => forgetTokens());
afterEach(() => {
  if (was === undefined) delete process.env.FIXTURES_DIR;
  else process.env.FIXTURES_DIR = was;
  if (doctored) rmSync(doctored, { recursive: true, force: true });
  doctored = null;
});

describe("#708: fake-paypal.mjs answers with the recorded shapes", () => {
  it("answers the capture with the recorded capture's shape", async () => {
    const recording = recordingOf("capture");
    const want = await captureOrder(idIn(recording.request.path, "orders"),
      "KEY", real(recording));
    const { paypalOrderId } = await createOrder(ORDER, "KEY", fake);
    const got = await captureOrder(paypalOrderId, "KEY", fake);

    assert.deepEqual(shapeOf(got), shapeOf(want));
    assert.equal(got.status, want.status);
    // The payer is the recording's: the fake has no payer of its own.
    assert.deepEqual(got.payer, want.payer);
    // Put in from the request.
    assert.equal(got.paypalOrderId, paypalOrderId);
    assert.equal(got.amount, ORDER.totals.total);

    // And it is read from the recording, not written beside it.
    doctor("capture", (response) => {
      const email = "doctored@example.com";

      if (response.payer) response.payer["email_address"] = email;
      const venmo = (response["payment_source"] || {}).venmo;

      if (venmo) venmo["email_address"] = email;
    });
    const again = await createOrder(ORDER, "KEY-2", fake);
    const followed = await captureOrder(again.paypalOrderId, "KEY-2", fake);

    assert.equal(followed.payer.email, "doctored@example.com");
  });

  it("answers the order read with the recorded order read's shape",
    async () => {
      const recording = recordingOf("order read");
      const want = await getOrder(idIn(recording.request.path, "orders"),
        real(recording));
      const { paypalOrderId } = await createOrder(ORDER, "KEY", fake);
      const got = await getOrder(paypalOrderId, fake);

      assert.deepEqual(shapeOf(got), shapeOf(want));
      assert.equal(got.status, want.status);
      assert.equal(got.capture, want.capture);
      // A time, as PayPal's create_time is; its value is the fake's own.
      assert.match(got.updatedAt, TIME);
    });

  it("answers the refund with the recorded refund's shape", async () => {
    const recording = recordingOf("refund");
    const paypalCaptureId = idIn(recording.request.path, "captures");
    const want = await refundCapture({
      paypalCaptureId, amount: 100, key: "KEY", note: "Refund",
    }, real(recording));
    const got = await refundCapture({
      paypalCaptureId: "FAKE-CAPTURE-1", amount: 250, key: "KEY",
      note: "Refund",
    }, fake);

    assert.deepEqual(shapeOf(got), shapeOf(want));
    assert.equal(got.status, want.status);
    assert.equal(got.amount, 250);

    // The status is the recording's, not a constant of the fake's.
    doctor("refund", (response) => {
      response.status = "PENDING";
    });
    const followed = await refundCapture({
      paypalCaptureId: "FAKE-CAPTURE-1", amount: 250, key: "KEY-2",
      note: "Refund",
    }, fake);

    assert.equal(followed.status, "PENDING");
  });
});
