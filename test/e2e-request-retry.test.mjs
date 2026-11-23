// Criteria tests for #681, written by a test agent from the issue's
// spec and "Done when" list before the fix: the e2e request wrapper
// (watchRequests in e2e/support/counted.mjs) retries a GET or HEAD
// that failed at the transport, up to twice with a short pause, and
// counts the call once; it never retries a request that got an HTTP
// answer, and never a POST. One test per box, named for it. The third
// box ("the next full staging run passes with no request lost to a
// single reset") is a staging run, not a unit test, and has none here.
//
// Held out of `npm test` until the fix lands: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it with
//   node --import ./test/setup.mjs --test test/e2e-request-retry.criteria.mjs
// and turn it on by renaming it to test/e2e-request-retry.test.mjs.
//
// The wrapper is driven directly, on a stand-in for Playwright's
// request context: its fetch() is the one the wrapper wraps, and it
// throws a transport error a given number of times, then answers.
// The errors are Playwright's own:
// - the reset is the message the suite met on staging, as recorded in
//   test/fixtures/github/e2e-exempt-staging-44379156341.txt (line
//   1804, run 44379156341, 2026-11-18), with its call log pointed at
//   this test's base URL and its header values made up;
// - the hang-up is thrown, in before(), by Playwright 1.62.1's real
//   request context against a local server that closes the connection
//   unanswered.
//
// The contract the fix meets, beyond the issue's words:
// - watchRequests(api, spec) stays the export, and the retry happens
//   inside the api.fetch it installs, which every get(), head() and
//   post() of a real context goes through.
// - "Today's error" is the one the wrapper throws now for a failed
//   request: requestError(method, url, error) from
//   e2e/support/request-error.mjs, for the last failure.
// - The call is counted through countCall (e2e/support/calls.mjs), so
//   the worker's tally (workerTally()) is where a spec's count shows.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { request } from "@playwright/test";

const SPEC = "e2e/retry-681.spec.mjs";
const PATH = "/api/dates";

// Closes every connection unanswered: a socket hang-up for the client.
const server = createServer((req) => req.socket.destroy());

let base;
let url;
let watchRequests;
let workerTally;
let requestError;
let hangUp;

// The reset as Playwright threw it on staging (see the header).
const reset = () => new Error([
  "apiRequestContext.call: read ECONNRESET",
  "Call log:",
  `  - → GET ${url}`,
  "    - user-agent: Mozilla/5.0 (made up for #681)",
  "    - accept: */*",
  "    - accept-encoding: gzip,deflate,br",
  "",
].join("\n"));

before(async () => {
  await new Promise((done) => { server.listen(0, "127.0.0.1", done); });
  base = `http://127.0.0.1:${server.address().port}`;
  url = `${base}${PATH}`;
  // The back office and the counter read the base URL when they load.
  process.env.E2E_BASE_URL = base;
  ({ watchRequests } = await import("../e2e/support/counted.mjs"));
  ({ workerTally } = await import("../e2e/support/calls.mjs"));
  ({ requestError } = await import("../e2e/support/request-error.mjs"));

  const real = await request.newContext();

  try {
    await real.get(url);
  } catch (error) {
    hangUp = error;
  } finally {
    await real.dispose();
  }
  assert.ok(hangUp, "the local server's hang-up reached Playwright");
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// A response as the wrapper reads one.
const response = (status) => ({
  status: () => status,
  ok: () => status >= 200 && status < 300,
  statusText: () => "",
  url: () => url,
  headers: () => ({}),
  text: async () => "",
  json: async () => ({}),
  body: async () => Buffer.from(""),
});

// A stand-in request context, watched as the suite watches one. Each
// of `plan` is the outcome of one call to fetch, in turn, the last
// repeating: an Error is thrown, a number is that HTTP status.
const standIn = (plan) => {
  const calls = [];
  const api = {
    async fetch(urlOrRequest, options) {
      calls.push({ url: urlOrRequest, method: options && options.method });
      const next = plan[Math.min(calls.length - 1, plan.length - 1)];

      if (next instanceof Error) throw next;

      return response(next);
    },
    storageState: async () => ({ cookies: [] }),
  };

  watchRequests(api, SPEC);

  return { api, calls };
};

const rejection = (promise) =>
  Promise.resolve(promise)
    .then(() => assert.fail("the request did not fail"), (error) => error);

const counted = () => {
  const tally = workerTally();

  return {
    total: tally.total,
    spec: tally.specs[SPEC] || 0,
    path: tally.paths[PATH] || 0,
  };
};

describe("the e2e request wrapper's retry (#681 acceptance criteria)",
  { timeout: 60000 }, () => {
    it("1. a GET reset once then answered succeeds, a GET reset three "
      + "times fails with today's error, a POST reset once fails at "
      + "once, and an HTTP 500 is not retried", async (t) => {
      await t.test("a GET reset once, then answered, succeeds",
        async () => {
          const { api, calls } = standIn([reset(), 200]);
          const res = await api.fetch(url, { method: "GET" });

          assert.equal(res.status(), 200, "the answer is handed back");
          assert.equal(calls.length, 2, "asked once more after the reset");
        });

      await t.test("a GET that hung up once, then answered, succeeds",
        async () => {
          const { api, calls } = standIn([hangUp, 200]);
          const res = await api.fetch(url);

          assert.equal(res.status(), 200, "the answer is handed back");
          assert.equal(calls.length, 2,
            "asked once more after the hang-up");
        });

      await t.test("a GET reset three times fails with today's error",
        async () => {
          const last = reset();
          const { api, calls } = standIn([reset(), reset(), last]);
          const error = await rejection(api.fetch(url, { method: "GET" }));

          assert.equal(calls.length, 3, "the first try and two retries");
          assert.equal(error.message,
            requestError("GET", url, last).message, "today's error");
        });

      await t.test("a POST reset once fails at once", async () => {
        const failure = reset();
        const { api, calls } = standIn([failure, 200]);
        const error = await rejection(api.fetch(url, {
          method: "POST", data: { made: "up" },
        }));

        assert.equal(calls.length, 1, "never asked again");
        assert.equal(error.message,
          requestError("POST", url, failure).message, "today's error");
      });

      await t.test("an HTTP 500 is not retried", async () => {
        const { api, calls } = standIn([500, 200]);
        const res = await api.fetch(url, { method: "GET" });

        assert.equal(res.status(), 500, "the 500 is handed back");
        assert.equal(calls.length, 1, "never asked again");
      });
    });

    it("2. the request count each spec records is unchanged by a retry",
      async () => {
        const { api, calls } = standIn([reset(), hangUp, 200]);
        const was = counted();

        await api.fetch(url, { method: "GET" }).catch(() => {});

        // Not the criterion: without a retry there is nothing to test.
        assert.equal(calls.length, 3, "the call was retried twice");
        const now = counted();

        assert.equal(now.total, was.total + 1, "one call in the total");
        assert.equal(now.spec, was.spec + 1, "one call charged to the spec");
        assert.equal(now.path, was.path + 1, "one call to its path");
      });
  });
