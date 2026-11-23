// Criteria tests for #950: the sweep of abandoned Square orders writes
// a log line for each order it cancels. Written by the test agent
// before any implementation, from the issue's words alone, one test
// per box of its "Done when" list marked (test), each named for its
// box. Held out of `npm test` by its name; the change that meets #950
// turns it on with
//
//   git mv test/sweep-cancel-log.criteria.mjs \
//     test/sweep-cancel-log.test.mjs
//
// THE CONTRACT. The issue names what the line holds but not its
// fields, so this decides them. Provisional: James or security may
// rename a field, and the implementer changes the test with it.
//
// 1. The line goes through lib/log.mjs (`log.info`, or warn or error),
//    so it is scrubbed and shipped like every other line. The tests
//    read it from the console, as test/address-key-by-cli.test.mjs
//    does.
// 2. Its fields follow the repository's other production-change lines
//    (docs/security.md, "Logging changes to production records"):
//    `event` names the action, `by` who acted, and `before` and
//    `after` the state, "OPEN" and "CANCELED" (a bare string or a
//    `state` inside an object). The site's order id and Square's
//    order id are values anywhere in the line, under id keys so the
//    scrubber keeps them whole. The total is Square's, in cents (the
//    number the sweep already reports), or a string holding it in
//    dollars ("65.00").
// 3. Who acted: `sweepSquareOrders` takes a `by`. Unset, as the
//    scheduled run leaves it, the line names the job: `by` is "jobs"
//    (lib/recorder.mjs's prune line) or "job". `bin/nff jobs square`
//    passes `by: "cli"` (bin/recorder.mjs and bin/promote.mjs log as
//    "cli"). Since bin/nff can't reach Square from a test (the fake's
//    search finds nothing and the stores are its own process's), the
//    CLI's box runs the sweep as bin/nff calls it and reads bin/nff's
//    call for the `by`.
// 4. "The same line" is the same `event` and the same fields; only
//    `by` differs.
//
// Square runs for real here (lib/square.mjs's searchOpenOrders and
// cancelOrder) behind a stub that answers with the recorded sandbox
// replies in test/fixtures/square (2026-10-29): orders-search-open
// for the search, order-get-before-cancel (its failed tenders
// dropped), order-get-paid and order-get-completed for the read
// before a cancel, order-cancel-fulfillment and order-cancel for the
// two updates. Each copy has its id, reference and total changed.
//
// The site's order ids have four characters (NFF-2610-K3WM), the
// shape from before #253: lib/order-id.mjs on next matches only that
// one, and #945 matches it and six. So these tests fail for want of
// the line, not for want of #945.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  runJobs, sweepSquareOrders,
} from "../netlify/functions/lib/jobs.mjs";
import { saveCheckout } from "../netlify/functions/lib/records.mjs";
import * as squareApi from "../netlify/functions/lib/square.mjs";
import { setPause } from "../netlify/functions/lib/square-pause.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { body } from "./recorded.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TOKEN = "EAAAl-criteria-950-secret-token";
const ENV = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: TOKEN,
  SQUARE_LOCATION_ID: "LOC",
};
// 10:00 in New York, after SQUARE_SWEEP_HOUR, and three days after
// the orders were made.
const NOW = new Date("2026-11-23T15:00:00Z");
const MADE = "2026-11-20T15:00:00.000Z";

// What the recorded reply holds about the customer, which no line may
// carry (test/fixtures/square/order-get-before-cancel.json).
const RECIPIENT = ["customer@example.com", "5555550100", "ADDRESS_LINE_1",
  "Display Name"];

// A field that would hold a payment detail, a secret or a contact.
const PRIVATE = new RegExp(["card", "tender", "payment", "last_?4",
  "fingerprint", "nonce", "source_?id", "token", "recipient", "address",
  "phone", "email", "customer"].join("|"), "i");

// The orders a sweep finds. `get` is the recorded read Square answers
// for it before a cancel: open and unpaid, paid since the search, or
// no longer open.
const ORDERS = {
  ok: { id: "ORDER_ID_OK", ref: "NFF-2610-K3WM", total: 6500, get: "open" },
  two: { id: "ORDER_ID_TWO", ref: "NFF-2610-P7QR", total: 4200,
    get: "open" },
  paid: { id: "ORDER_ID_PAID", ref: "NFF-2610-PAID", total: 5500,
    get: "paid" },
  closed: { id: "ORDER_ID_DONE", ref: "NFF-2610-DONE", total: 3000,
    get: "completed" },
  waiting: { id: "ORDER_ID_WAIT", ref: "NFF-2610-WAIT", total: 2500,
    get: "open" },
};

const unpaid = () => {
  const order = body("square", "order-get-before-cancel").order;

  return { ...order, tenders: [] };
};

const reads = {
  open: unpaid,
  paid: () => body("square", "order-get-paid").order,
  completed: () => body("square", "order-get-completed").order,
};

const money = (amount) => ({ amount, currency: "USD" });

// A recorded order made into `o`: Square's own field names.
const as = (order, o) => ({
  ...order, "id": o.id, "reference_id": o.ref,
  "total_money": money(o.total),
});

const asFound = (o) => ({ ...as(unpaid(), o), "created_at": MADE });

// A Square that has `orders` open, recorded replies throughout.
const squareWith = (orders) => {
  const calls = [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const json = (data) => new Response(JSON.stringify(data), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = new URL(url).pathname;
    const sent = init.body ? JSON.parse(init.body) : null;

    calls.push({ method, path, body: sent });

    if (method === "POST" && path === "/v2/orders/search") {
      return json({
        ...body("square", "orders-search-open"), orders: orders.map(asFound),
        cursor: undefined,
      });
    }

    const id = decodeURIComponent(path.replace("/v2/orders/", ""));
    const o = byId.get(id);

    if (!o) throw new Error(`unexpected ${method} ${path}`);
    if (method === "GET") {
      return json({ order: as(reads[o.get](), o) });
    }
    if (method === "PUT") {
      const name = sent.order.fulfillments
        ? "order-cancel-fulfillment" : "order-cancel";
      const reply = body("square", name);

      return json({ ...reply, order: as(reply.order, o) });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  // As the scheduled run passes it: the module's two calls, on the
  // stub.
  const square = {
    searchOpenOrders: (q, opts) => squareApi.searchOpenOrders(q,
      { ...opts, fetchImpl }),
    cancelOrder: (id, opts) => squareApi.cancelOrder(id,
      { ...opts, fetchImpl }),
  };

  return { calls, fetchImpl, square };
};

const puts = (calls) => calls.filter((c) => c.method === "PUT");

// Every JSON line written to the console while the test runs.
const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      const text = args.map(String).join(" ");

      try {
        const record = JSON.parse(text);

        if (record && typeof record === "object") lines.push(record);
      } catch {
        // Not a log line.
      }
    });
  }

  return lines;
};

const values = (x) => (x && typeof x === "object"
  ? Object.values(x).flatMap(values) : [x]);

const keys = (x) => (x && typeof x === "object"
  ? Object.entries(x).flatMap(([k, v]) => [k, ...keys(v)]) : []);

const states = (x) => values(x).filter((v) => typeof v === "string");

// The line for a cancel of Square order `id`: it names the order and
// its state after is CANCELED.
const cancelLines = (lines, id) => lines.filter((r) => values(r)
  .includes(id) && states(r.after).includes("CANCELED"));

const assertLine = (lines, o, actor) => {
  const found = cancelLines(lines, o.id);

  assert.equal(found.length, 1,
    `one line for the cancel of ${o.id}, got ${found.length}: ${
      JSON.stringify(lines)}`);

  const [line] = found;
  const all = values(line);

  assert.equal(typeof line.event, "string", "the line names the action");
  assert.ok(line.event.length > 0, "the line names the action");
  assert.match(String(line.by), actor, "the line names who acted");
  assert.ok(all.includes(o.ref), `the line names the site's order id ${
    o.ref}: ${JSON.stringify(line)}`);
  assert.ok(all.includes(o.id), "the line names Square's order id");
  assert.ok(all.includes(o.total) || all.some((v) => typeof v === "string"
    && v.includes((o.total / 100).toFixed(2))),
  `the line holds the total ${o.total}: ${JSON.stringify(line)}`);
  assert.ok(states(line.before).includes("OPEN"),
    `the state before is OPEN: ${JSON.stringify(line.before)}`);
  assert.ok(!states(line.before).includes("CANCELED"),
    "the state before is not CANCELED");
  assert.deepEqual(states(line.after).filter((v) => v === "OPEN"), [],
    "the state after is not OPEN");

  return line;
};

const JOB = /^jobs?\b/;
const CLI = /^cli\b/;

const mail = async () => ({ id: "m1", driver: "test" });

const scheduled = (stores, square, env = ENV) => runJobs(stores, {
  env, mail, square, now: NOW, realNow: NOW,
});

// One `case "<command>":` of bin/nff's switch, up to the next case.
const caseOf = (source, command) => {
  const start = source.indexOf(`case "${command}":`);

  assert.ok(start >= 0, `bin/nff has a case for ${command}`);

  const next = source.indexOf("\n  case \"", start + 1);

  return source.slice(start, next < 0 ? undefined : next);
};

describe("#950: the sweep logs each Square order it cancels", () => {
  it("The scheduled sweep writes one log line for each order it " +
    "cancels, naming the job as the actor, the site's order id, " +
    "Square's order id, the total, and OPEN to CANCELED", async (t) => {
    const lines = capture(t);
    const { calls, square } = squareWith([ORDERS.ok, ORDERS.two]);
    const r = await scheduled(testStores(), square);

    assert.deepEqual(r.squareOpen.map((o) => [o.squareOrderId, o.cancelled]),
      [[ORDERS.ok.id, true], [ORDERS.two.id, true]], "the sweep ran");
    assert.equal(puts(calls).length, 4, "two updates for each order");

    assertLine(lines, ORDERS.ok, JOB);
    assertLine(lines, ORDERS.two, JOB);

    const [first] = cancelLines(lines, ORDERS.ok.id);

    assert.ok(!values(first).includes(ORDERS.two.id),
      "a line for each order, not one for both");
  });

  it("`bin/nff jobs square --apply` writes the same line for each " +
    "order it cancels, naming the CLI as the actor", async (t) => {
    const lines = capture(t);
    const cli = squareWith([ORDERS.ok, ORDERS.two]);

    // As bin/nff calls it with --apply, `by` added.
    const found = await sweepSquareOrders(testStores(), {
      env: ENV, now: NOW, fetchImpl: cli.fetchImpl, cancel: true,
      by: "cli",
    });

    assert.deepEqual(found.map((o) => o.cancelled), [true, true]);

    const fromCli = assertLine(lines, ORDERS.ok, CLI);

    assertLine(lines, ORDERS.two, CLI);

    // The same line as the scheduled job's, but for who acted.
    const job = squareWith([ORDERS.ok]);

    lines.length = 0;
    await scheduled(testStores(), job.square);

    const fromJob = assertLine(lines, ORDERS.ok, JOB);
    const shape = (line) => Object.keys(line)
      .filter((k) => !["_time", "by"].includes(k)).sort();

    assert.equal(fromCli.event, fromJob.event, "the same action");
    assert.deepEqual(shape(fromCli), shape(fromJob), "the same fields");

    const nff = readFileSync(join(root, "bin/nff"), "utf8");

    assert.match(caseOf(nff, "jobs square"),
      /sweepSquareOrders\(stores,\s*\{[^}]*\bby:\s*"cli"/,
      "bin/nff jobs square passes the CLI as who acted");
  });

  it("A dry run, the report-only mode under the kill switch, and an " +
    "order the sweep refuses (paid, not open, a waiting checkout) " +
    "write no such line", async (t) => {
    const lines = capture(t);
    const ids = Object.values(ORDERS).map((o) => o.id);
    const none = (what) => {
      for (const id of ids) {
        assert.deepEqual(cancelLines(lines, id), [],
          `${what}: no cancel line for ${id}`);
      }
    };

    // A dry run: bin/nff jobs square without --apply.
    const dry = squareWith([ORDERS.ok, ORDERS.two]);
    const report = await sweepSquareOrders(testStores(), {
      env: ENV, now: NOW, fetchImpl: dry.fetchImpl, cancel: false,
      by: "cli",
    });

    assert.deepEqual(report.map((o) => o.cancelled), [false, false]);
    assert.deepEqual(puts(dry.calls), [], "a dry run changes nothing");
    none("a dry run");

    // The kill switch in the environment, on the scheduled run.
    const killed = squareWith([ORDERS.ok, ORDERS.two]);
    const r = await scheduled(testStores(), killed.square,
      { ...ENV, SQUARE_DELETION_KILL_SWITCH: "1" });

    assert.deepEqual(r.squareOpen.map((o) => o.cancelled), [false, false],
      "the switch keeps the sweep report-only");
    assert.deepEqual(puts(killed.calls), []);
    none("the kill switch in the environment");

    // The kill switch in the store (bin/nff square deletions pause).
    const stores = testStores();
    const paused = squareWith([ORDERS.ok]);

    await setPause(stores, true, { by: "test" });
    await scheduled(stores, paused.square);
    assert.deepEqual(puts(paused.calls), []);
    none("the kill switch in the store");

    // Orders the sweep refuses, beside one it cancels.
    const mixed = testStores();

    await saveCheckout(mixed, {
      // Started an hour ago, so the checkout sweep keeps it.
      key: "k950", attempt: 1, paypalOrderId: "PPO950",
      at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      order: { id: ORDERS.waiting.ref },
    });

    const refuses = squareWith([
      ORDERS.ok, ORDERS.paid, ORDERS.closed, ORDERS.waiting,
    ]);
    const swept = await scheduled(mixed, refuses.square);

    assert.deepEqual(swept.squareOpen.map((o) => [o.orderId, o.cancelled]), [
      [ORDERS.ok.ref, true], [ORDERS.paid.ref, false],
      [ORDERS.closed.ref, false],
    ], "the paid and closed orders refused, the waiting one passed by");
    for (const o of [ORDERS.paid, ORDERS.closed, ORDERS.waiting]) {
      assert.deepEqual(cancelLines(lines, o.id), [],
        `no cancel line for ${o.ref} (${o.get})`);
    }
  });

  it("The line holds no payment detail, token, or unmasked email " +
    "address, phone number or street address", async (t) => {
    const lines = capture(t);
    const { square } = squareWith([ORDERS.ok]);

    await scheduled(testStores(), square);

    const line = assertLine(lines, ORDERS.ok, JOB);
    const text = JSON.stringify(line);

    assert.ok(!text.includes(TOKEN), "no token");
    assert.doesNotMatch(text, /Bearer|EAAA/, "no token");
    for (const detail of RECIPIENT) {
      assert.ok(!text.includes(detail), `no ${detail}`);
    }
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/,
      "no email address");
    assert.doesNotMatch(text, /\+1\s*\(?555/, "no phone number");
    assert.deepEqual(keys(line).filter((k) => PRIVATE.test(k)), [],
      "no payment or contact field");
    assert.doesNotMatch(text, /PAYMENT_ID|FINGERPRINT|VISA/,
      "no payment detail");
  });
});
