// Criteria tests for #708 (Record the live Venmo responses as PayPal
// fixtures), one per box of its "Done when" that a test can check,
// each named for its box. Written before the recorder exists, by a
// test agent; the implementer turns the file on by renaming it to
// paypal-recorder.test.mjs and builds to the seam below.
//
// The seam these tests name:
//
// - netlify/functions/lib/recorder.mjs exports `recordInto(store)`,
//   the CLI's record mode (bin/nff --record passes stores.recordings;
//   null turns it off), and `prune(store, { now })`, which deletes
//   every record older than 7 days and which the jobs run.
// - Every PayPal call in lib/paypal.mjs (createOrder, getOrder,
//   captureOrder, refundCapture, getRefund, verifyWebhook) takes a
//   `recordings` option: a store, or null for none. Its default is
//   stores(env).recordings on Netlify, and off Netlify the store
//   recordInto set, else none. The window is checked at call time.
// - paypal-webhook.mjs's handle() saves each event it accepts, with
//   its answer, into stores.recordings.
// - bin/recorder.mjs exports `recordCommand(action, { stores, flags,
//   out, root, now })` for `bin/nff record open [--minutes 60]`,
//   `record close` and `record pull`; pull writes
//   <root>/.ignored/fixtures-raw/<name>.json.
// - The Blobs store is `recordings`, private, named per context like
//   the others, and the window lives in it too, so a store alone
//   says whether to record. A record is { name, service: "paypal", status,
//   request: { method, path, headers, body }, response, at }.
// - Log events: paypal.record_opened, paypal.record_closed,
//   paypal.records_pulled (by: "cli") and, on a failed save,
//   paypal.record_failed.
//
// PayPal is a fetch stub here, as in test/paypal.test.mjs: no test
// calls PayPal, sandbox or live.

// PayPal's bodies are snake_case, as eslint.config.js allows its other
// tests; here, so the rule holds under either name.
/* eslint camelcase: ["error", { "properties": "never" }] */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  captureOrder, createOrder, forgetTokens, getOrder, getRefund,
  refundCapture, verifyWebhook,
} from "../netlify/functions/lib/paypal.mjs";
import { handle } from "../netlify/functions/paypal-webhook.mjs";
import { memoryStore, testStores } from "../netlify/functions/lib/store.mjs";

// Loaded in each test, so each fails on its own while they are missing.
const recorder = () => import("../netlify/functions/lib/recorder.mjs");
const cli = () => import("../bin/recorder.mjs");

const CLIENT_ID = "CLIENT-ID-4f2a";
const CLIENT_SECRET = "CLIENT-SECRET-9c1e";
const ACCESS_TOKEN = "ACCESS-TOKEN-7b3d";
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

const env = {
  PAYPAL_CLIENT_ID: CLIENT_ID,
  PAYPAL_CLIENT_SECRET: CLIENT_SECRET,
  PAYPAL_ENV: "sandbox",
  PAYPAL_WEBHOOK_ID: "WH-1",
};
const T0 = new Date("2026-11-21T14:00:00Z");
const at = (minutes) => new Date(T0.getTime() + minutes * 60_000);
const KEY = "0123456789abcdef0123456789abcdef";
const PAYER = "payer.person@example.com";

const order = () => ({
  id: "NFF-2611-ABCD",
  customer: { name: "Pat Payer", email: PAYER },
  totals: { total: 100 },
});

// Answers in PayPal's shape, as in test/paypal.test.mjs.
const ANSWERS = {
  "/v1/oauth2/token": { access_token: ACCESS_TOKEN, expires_in: 3600 },
  "/v2/checkout/orders": { id: "PPO", status: "CREATED" },
  "/v2/checkout/orders/PPO": {
    id: "PPO", status: "APPROVED", update_time: "2026-11-21T14:01:00Z",
  },
  "/v2/checkout/orders/PPO/capture": {
    id: "PPO",
    status: "COMPLETED",
    payer: {
      email_address: PAYER,
      name: { given_name: "Pat", surname: "Payer" },
    },
    purchase_units: [{
      payments: {
        captures: [{
          id: "CAP", status: "COMPLETED", amount: { value: "1.00" },
        }],
      },
    }],
  },
  "/v2/payments/captures/CAP/refund": {
    id: "REF", status: "COMPLETED", amount: { value: "1.00" },
  },
  "/v2/payments/refunds/REF": {
    id: "REF", status: "COMPLETED", amount: { value: "1.00" },
  },
  "/v1/notifications/verify-webhook-signature": {
    verification_status: "SUCCESS",
  },
};

const paypalFetch = () => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;

    calls.push({ path, method: init.method || "GET" });

    return new Response(JSON.stringify(ANSWERS[path] || {}), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };

  return { impl, calls };
};

const HOOK_HEADERS = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "TX-1",
  "paypal-transmission-sig": "good",
  "paypal-transmission-time": "2026-11-21T14:02:00Z",
};
// An event the handler answers without touching an order.
const EVENT = {
  id: "WH-EVT-1",
  event_type: "CHECKOUT.ORDER.APPROVED",
  resource: { id: "PPO", payer: { email_address: PAYER } },
};
const hook = (stores, now, extra = {}) => handle(
  new Request("https://example.com/api/paypal/webhook", {
    method: "POST", headers: HOOK_HEADERS, body: JSON.stringify(EVENT),
  }),
  { stores, env, now, verify: async () => true, ...extra },
);

// Every saved record in a store, whatever its key: anything with a
// service. The window, wherever it is kept, has none.
const recordsIn = async (store) => {
  const out = [];

  for (const { key } of await store.list("")) {
    const value = await store.get(key);

    if (value && typeof value === "object" && "service" in value) {
      out.push(value);
    }
  }

  return out;
};

const pathOf = (record) => record.request && record.request.path;
const notToken = (record) => pathOf(record) !== "/v1/oauth2/token";

// Every PayPal call the site and the CLI make, once each.
const everyCall = async (options) => {
  await createOrder(order(), KEY, options);
  await getOrder("PPO", options);
  await captureOrder("PPO", KEY, options);
  await refundCapture({
    paypalCaptureId: "CAP", amount: 100, key: KEY, note: "Test",
  }, options);
  await getRefund("REF", options);
  await verifyWebhook(new Headers(HOOK_HEADERS), JSON.stringify(EVENT),
    options);
};

const testRoot = () => mkdtempSync(join(tmpdir(), "nff-recorder-"));

const command = async (action, { stores, flags = {}, root, now }) => {
  const { recordCommand } = await cli();
  const said = [];

  await recordCommand(action, {
    stores, flags, root: root || testRoot(), now, out: (s) => said.push(s),
  });

  return said;
};

const withRecordings = () => ({ ...testStores(), recordings: memoryStore() });

// Log lines as lib/log.mjs writes them, parsed.
const captureLog = (t) => {
  const lines = [];
  const keep = (...args) => {
    for (const a of args) {
      try {
        lines.push(JSON.parse(a));
      } catch {
        // Not a log line.
      }
    }
  };

  t.mock.method(console, "info", keep);
  t.mock.method(console, "warn", keep);
  t.mock.method(console, "error", keep);

  return lines;
};

// A store that refuses everything, and one that never answers.
const failing = () => {
  const no = async () => {
    throw new Error("Blobs is down");
  };

  return {
    get: no, set: no, create: no, getTagged: no, swap: no, delete: no,
    list: no,
  };
};
const hanging = () => {
  const never = () => new Promise(() => {});

  return {
    get: never, set: never, create: never, getTagged: never, swap: never,
    delete: never, list: never,
  };
};

beforeEach(() => forgetTokens());
afterEach(async () => {
  try {
    (await recorder()).recordInto(null);
  } catch {
    // Not built yet: the tests say so themselves.
  }
});

describe("#708: recording PayPal's live responses", () => {
  it("With no recording window open, no PayPal exchange is saved " +
    "anywhere, on Netlify or by the CLI", async () => {
    const { recordInto } = await recorder();
    const stores = withRecordings();
    const { impl } = paypalFetch();

    // On Netlify: the functions' calls and a webhook.
    await everyCall({ env, fetchImpl: impl, now: T0,
      recordings: stores.recordings });
    const res = await hook(stores, T0);

    assert.equal(res.status, 200);

    // On the Mac: the CLI in record mode.
    const cliStores = withRecordings();

    recordInto(cliStores.recordings);
    forgetTokens();
    await everyCall({ env, fetchImpl: impl, now: T0 });

    // A window that was opened and closed is no window.
    await command("open", { stores, flags: { minutes: "30" }, now: T0 });
    await command("close", { stores, now: at(1) });
    forgetTokens();
    await everyCall({ env, fetchImpl: impl, now: at(2),
      recordings: stores.recordings });
    await hook(stores, at(2));

    assert.deepEqual(await recordsIn(stores.recordings), []);
    assert.deepEqual(await recordsIn(cliStores.recordings), []);
  });

  it("While a window is open, each request lib/paypal.mjs sends to " +
    "PayPal on Netlify and each PayPal webhook event received is saved " +
    "with its response", async () => {
    const stores = withRecordings();
    const { impl, calls } = paypalFetch();

    await command("open", { stores, flags: { minutes: "60" }, now: T0 });
    await everyCall({ env, fetchImpl: impl, now: at(1),
      recordings: stores.recordings });

    const records = await recordsIn(stores.recordings);
    const sent = calls.filter((c) => c.path !== "/v1/oauth2/token");
    const saved = records.filter(notToken);

    assert.deepEqual(saved.map((r) => [r.request.method, pathOf(r)]).sort(),
      sent.map((c) => [c.method, c.path]).sort());
    for (const r of saved) {
      assert.equal(r.service, "paypal");
      assert.equal(r.status, 200, pathOf(r));
      assert.deepEqual(r.response, ANSWERS[pathOf(r)], pathOf(r));
      assert.equal(typeof r.name, "string");
    }

    const refund = saved.find((r) => /\/refund$/.test(pathOf(r)));

    assert.deepEqual(refund.request.body, {
      amount: { currency_code: "USD", value: "1.00" },
      note_to_payer: "Test",
    });

    // A refused call is saved with PayPal's status and answer.
    const refusal = {
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "REFUND_FAILED_INSUFFICIENT_FUNDS" }],
    };
    const refusing = async (url) => (/\/refund$/.test(new URL(url).pathname)
      ? new Response(JSON.stringify(refusal), { status: 422 })
      : impl(url));

    await assert.rejects(refundCapture({
      paypalCaptureId: "CAP", amount: 100, key: KEY,
    }, { env, fetchImpl: refusing, now: at(2),
      recordings: stores.recordings }));

    const refused = (await recordsIn(stores.recordings))
      .find((r) => r.status === 422);

    assert.ok(refused, "the 422 is saved");
    assert.deepEqual(refused.response, refusal);

    // A webhook event, as received, with the answer the site gave.
    const res = await hook(stores, at(3));
    const answer = await res.json();
    const event = (await recordsIn(stores.recordings))
      .find((r) => r.request && r.request.body
        && r.request.body.id === EVENT.id);

    assert.ok(event, "the webhook event is saved");
    assert.equal(event.service, "paypal");
    assert.equal(event.request.method, "POST");
    assert.equal(event.request.path, "/api/paypal/webhook");
    assert.deepEqual(event.request.body, EVENT);
    assert.equal(event.status, res.status);
    assert.deepEqual(event.response, answer);
  });

  it("A window closes by itself at its expiry, which is at most one " +
    "hour after it opens, and the CLI can close it early", async () => {
    const { impl } = paypalFetch();
    const refund = (stores, now) => refundCapture({
      paypalCaptureId: "CAP", amount: 100, key: KEY,
    }, { env, fetchImpl: impl, now, recordings: stores.recordings });
    const count = async (stores) =>
      (await recordsIn(stores.recordings)).filter(notToken).length;

    // Open for an hour: recorded at 59 minutes, not after 60.
    const hour = withRecordings();

    await command("open", { stores: hour, flags: { minutes: "60" }, now: T0 });
    await refund(hour, at(59));
    assert.equal(await count(hour), 1);
    await refund(hour, at(60.02));
    assert.equal(await count(hour), 1, "closed at its expiry");

    // No --minutes: still no more than an hour.
    const plain = withRecordings();

    await command("open", { stores: plain, now: T0 });
    await refund(plain, at(60.02));
    assert.equal(await count(plain), 0);

    // Asked for longer than an hour: refused, or held to an hour.
    const long = withRecordings();

    try {
      await command("open", {
        stores: long, flags: { minutes: "90" }, now: T0,
      });
    } catch {
      // Refused outright is as good.
    }
    await refund(long, at(61));
    assert.equal(await count(long), 0, "never open past an hour");

    // Closed early by the CLI.
    const early = withRecordings();

    await command("open", {
      stores: early, flags: { minutes: "60" }, now: T0,
    });
    await refund(early, at(5));
    await command("close", { stores: early, now: at(6) });
    await refund(early, at(7));
    assert.equal(await count(early), 1, "nothing after the close");
  });

  it("The CLI in record mode saves each PayPal request it sends and the " +
    "response", async () => {
    const { recordInto } = await recorder();
    const stores = withRecordings();
    const { impl, calls } = paypalFetch();

    await command("open", { stores, flags: { minutes: "60" }, now: T0 });

    // Record mode: bin/nff --record hands the CLI's PayPal calls the
    // context's store. The refund and the refund check are the CLI's.
    recordInto(stores.recordings);
    await refundCapture({
      paypalCaptureId: "CAP", amount: 100, key: KEY, note: "Test",
    }, { env, fetchImpl: impl, now: at(1) });
    await getRefund("REF", { env, fetchImpl: impl, now: at(2) });

    const saved = (await recordsIn(stores.recordings)).filter(notToken);
    const sent = calls.filter((c) => c.path !== "/v1/oauth2/token");

    assert.deepEqual(saved.map((r) => [r.request.method, pathOf(r)]).sort(),
      sent.map((c) => [c.method, c.path]).sort());
    for (const r of saved) {
      assert.equal(r.service, "paypal");
      assert.equal(r.status, 200);
      assert.deepEqual(r.response, ANSWERS[pathOf(r)]);
    }

    // Out of record mode the CLI saves nothing, window or not.
    recordInto(null);
    await getRefund("REF", { env, fetchImpl: impl, now: at(3) });
    assert.equal((await recordsIn(stores.recordings)).filter(notToken).length,
      saved.length);
  });

  it("Recording never changes, fails or slows a payment, a refund or a " +
    "webhook: a failure to save is logged and ignored", async (t) => {
    const { impl } = paypalFetch();
    const pay = (recordings, now) => captureOrder("PPO", KEY, {
      env, fetchImpl: impl, now, recordings,
    });
    const refund = (recordings, now) => refundCapture({
      paypalCaptureId: "CAP", amount: 100, key: KEY,
    }, { env, fetchImpl: impl, now, recordings });

    // The answers with nothing recorded.
    const plain = withRecordings();
    const paid = await pay(plain.recordings, T0);
    const refunded = await refund(plain.recordings, T0);
    const hooked = await hook(plain, T0);
    const hookedBody = await hooked.json();

    // The same with a window open: identical.
    const open = withRecordings();

    await command("open", { stores: open, flags: { minutes: "60" }, now: T0 });
    assert.deepEqual(await pay(open.recordings, at(1)), paid);
    assert.deepEqual(await refund(open.recordings, at(1)), refunded);

    const openHook = await hook(open, at(1));

    assert.equal(openHook.status, hooked.status);
    assert.deepEqual(await openHook.json(), hookedBody);

    // A store that fails: the same answers, and the failure logged.
    const lines = captureLog(t);
    const broken = { ...testStores(), recordings: failing() };

    try {
      assert.deepEqual(await pay(broken.recordings, at(2)), paid);
      assert.deepEqual(await refund(broken.recordings, at(2)), refunded);

      const brokenHook = await hook(broken, at(2));

      assert.equal(brokenHook.status, hooked.status);
      assert.deepEqual(await brokenHook.json(), hookedBody);
    } finally {
      t.mock.restoreAll();
    }
    assert.ok(lines.some((l) => l.event === "paypal.record_failed"),
      "a failed save is logged as paypal.record_failed");

    // A store that never answers: each call still finishes within a
    // second.
    const stuck = { ...testStores(), recordings: hanging() };
    const prompt = async (what, work) => {
      const started = Date.now();
      const result = await work();
      const took = Date.now() - started;

      assert.ok(took < 1000, `a stuck store held the ${what} ${took} ms`);

      return result;
    };

    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "error", () => {});
    try {
      assert.deepEqual(await prompt("payment",
        () => pay(stuck.recordings, at(3))), paid);
      assert.deepEqual(await prompt("refund",
        () => refund(stuck.recordings, at(3))), refunded);
      assert.equal((await prompt("webhook",
        () => hook(stuck, at(3)))).status, hooked.status);
    } finally {
      t.mock.restoreAll();
    }
  });

  it("No saved record holds a secret: no Authorization header, access " +
    "token or client secret", async () => {
    const stores = withRecordings();
    const { impl } = paypalFetch();
    const root = testRoot();

    await command("open", { stores, flags: { minutes: "60" }, now: T0 });
    await everyCall({ env, fetchImpl: impl, now: at(1),
      recordings: stores.recordings });
    await hook(stores, at(2));

    const secretFree = (text, where) => {
      assert.doesNotMatch(text, /authorization/i, where);
      assert.doesNotMatch(text, /bearer /i, where);
      for (const secret of [ACCESS_TOKEN, CLIENT_SECRET, BASIC]) {
        assert.equal(text.includes(secret), false, `${where}: ${secret}`);
      }
    };
    const records = await recordsIn(stores.recordings);

    assert.ok(records.length >= 7, "every call and the event are saved");
    for (const r of records) secretFree(JSON.stringify(r), pathOf(r));

    // Nor what the pull writes.
    await command("pull", { stores, root, now: at(3) });

    const dir = join(root, ".ignored", "fixtures-raw");

    for (const file of readdirSync(dir)) {
      secretFree(readFileSync(join(dir, file), "utf8"), file);
    }
  });

  it("A CLI command pulls the saved records into .ignored/fixtures-raw/ " +
    "in the Square recorder's shape, then deletes them from Blobs, and a " +
    "record never pulled is deleted after 7 days", async () => {
    const { prune } = await recorder();
    const stores = withRecordings();
    const { impl } = paypalFetch();
    const root = testRoot();
    const dir = join(root, ".ignored", "fixtures-raw");
    const pull = (now) => command("pull", { stores, root, now });

    await command("open", { stores, flags: { minutes: "60" }, now: T0 });
    await captureOrder("PPO", KEY, { env, fetchImpl: impl, now: at(1),
      recordings: stores.recordings });
    await refundCapture({ paypalCaptureId: "CAP", amount: 100, key: KEY },
      { env, fetchImpl: impl, now: at(2), recordings: stores.recordings });
    await hook(stores, at(3));

    const saved = await recordsIn(stores.recordings);

    await pull(at(4));

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

    assert.equal(files.length, saved.length, "one file for each record");
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));

      assert.equal(`${raw.name}.json`, file);
      assert.equal(raw.service, "paypal");
      assert.equal(typeof raw.status, "number");
      for (const key of ["method", "path"]) {
        assert.equal(typeof raw.request[key], "string", `${file} ${key}`);
      }
      assert.ok("response" in raw, file);
    }

    const capture = files.map((f) => JSON.parse(readFileSync(join(dir, f),
      "utf8"))).find((r) => /\/capture$/.test(r.request.path));

    assert.deepEqual(capture.response,
      ANSWERS["/v2/checkout/orders/PPO/capture"]);
    assert.deepEqual(await recordsIn(stores.recordings), [],
      "pulled records are gone from Blobs");

    // A second pull finds nothing and leaves the files alone.
    writeFileSync(join(dir, "square-other.json"), "{}");
    await pull(at(5));
    assert.deepEqual(readdirSync(dir).sort(),
      [...files, "square-other.json"].sort());

    // A record never pulled: kept for 7 days, then deleted.
    const later = withRecordings();

    await command("open", {
      stores: later, flags: { minutes: "60" }, now: T0,
    });
    await getRefund("REF", { env, fetchImpl: impl, now: at(1),
      recordings: later.recordings });
    assert.ok((await recordsIn(later.recordings)).length >= 1);

    await prune(later.recordings, { now: at(6 * 24 * 60) });
    assert.ok((await recordsIn(later.recordings)).length >= 1,
      "kept for 7 days");

    await prune(later.recordings, { now: at(7 * 24 * 60 + 2) });
    assert.deepEqual(await recordsIn(later.recordings), [],
      "deleted after 7 days");
  });

  it("Opening and closing a window and pulling records are logged by the " +
    "logging rule (time, who acted, action), with no customer data in " +
    "the log line", async (t) => {
    const stores = withRecordings();
    const { impl } = paypalFetch();
    const root = testRoot();

    // Records that hold a payer's details, as the live ones will.
    await command("open", { stores, flags: { minutes: "60" }, now: T0 });
    await captureOrder("PPO", KEY, { env, fetchImpl: impl, now: at(1),
      recordings: stores.recordings });
    await hook(stores, at(2));

    const lines = captureLog(t);

    try {
      await command("pull", { stores, root, now: at(3) });
      await command("close", { stores, now: at(4) });
      await command("open", { stores, flags: { minutes: "30" }, now: at(5) });
    } finally {
      t.mock.restoreAll();
    }

    for (const event of [
      "paypal.records_pulled", "paypal.record_closed",
      "paypal.record_opened",
    ]) {
      const line = lines.find((l) => l.event === event);

      assert.ok(line, `${event} is logged`);
      assert.ok(!Number.isNaN(Date.parse(line._time)), `${event}: time`);
      assert.equal(line.by, "cli", `${event}: who acted`);

      const text = JSON.stringify(line);

      for (const datum of [PAYER, "payer.person", "Pat", "Payer",
        "[email:"]) {
        assert.equal(text.includes(datum), false, `${event}: ${datum}`);
      }
    }
  });
});

// Not tests, so not here: the staging proof against PayPal's sandbox,
// security's review, and the scrubbed fixtures after James's live
// test.
