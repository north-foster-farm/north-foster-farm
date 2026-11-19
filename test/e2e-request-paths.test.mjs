// Criteria tests for #665's added box (2026-11-19), written by a test
// agent before the fix: an error for a request to a relative URL, as
// most of the suite's own requests are ("/api/dates" against the base
// URL), names its path, still without the query, and still holds no
// header, cookie or token; and a URL that cannot be read at all does
// not make the error builder throw. One test per way in, each named
// for it. Held out of npm test as e2e-request-paths.criteria.mjs
// until the fix; turned on by its rename, with the fix.
//
// Ways in: the wrapper (watchRequests) on a request context with a
// baseURL, as Playwright's `request` fixture is; route.fetch() given
// a relative `url`; followLink() given a relative link, as page.goto
// takes one against the context's baseURL. op() is not here: it
// always sends to `${BASE_URL}/api/staging/e2e`, which is absolute,
// and takes no URL of its own.
//
// The wrapper and route.fetch() make real requests through
// Playwright's request context to a local server that never answers
// or drops the connection. followLink()'s page is a stand-in whose
// goto() throws what Playwright's threw, in the shape recorded from
// Playwright 1.62.1 on 2026-11-19 (e2e-link-errors.test.mjs has the
// recording); for a relative link Playwright navigates to, and logs,
// the link resolved against the base URL. Every value is made up and
// matches nothing real.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { inspect } from "node:util";

import { request } from "@playwright/test";

import { COOKIE as SESSION } from "../netlify/functions/lib/auth.mjs";

const COOKIE_VALUE = "madeup-cookie-665-paths";
const AUTH_VALUE = "madeup-auth-665-paths";
const TOKEN = "madeup-token-665-paths";
const SECRETS = [COOKIE_VALUE, AUTH_VALUE, TOKEN];

// /api/drop... closes the connection unanswered; anything else is
// held and never answered.
const server = createServer((req) => {
  if (req.url.startsWith("/api/drop")) req.socket.destroy();
});

let base;
let watchRequests;
let watchContext;
let requestError;
let followLink;

before(async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.E2E_BASE_URL = base;
  ({ watchRequests, watchContext } = await import(
    "../e2e/support/counted.mjs"
  ));
  ({ requestError, followLink } = await import(
    "../e2e/support/request-error.mjs"
  ));
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const printed = (error) => [
  String(error && error.message), String(error && error.stack),
  inspect(error, { depth: 10 }),
].join("\n");

const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("the request did not fail");
};

const TIMED_OUT = /time(d)?\s?out/i;
const DROPPED = /hang\s?up|closed|reset|refused/i;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The box: "METHOD /path: kind", the path with no query, and none of
// the values the request carried anywhere an error can be printed.
const namesPath = (error, { method, path, kind }) => {
  const text = printed(error);

  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), "the error holds a value it was " +
      `sent with:\n${text.replaceAll(secret, "<a value>")}`);
  }
  assert.match(String(error.message),
    new RegExp(`\\b${method} ${escape(path)}: `),
    `names the method and the path "${path}"`);
  assert.ok(!String(error.message).includes("?"), "no query");
  assert.match(String(error.message), kind, "names the kind of failure");
};

const sent = { cookie: `${SESSION}=${COOKIE_VALUE}`,
  authorization: `Bearer ${AUTH_VALUE}` };

describe("a request to a relative URL names its path (#665)", () => {
  test("through the wrapper, a relative URL that times out or fails " +
    "names its path without the query and holds no header", async () => {
    const api = watchRequests(
      await request.newContext({ baseURL: base }), "test"
    );

    try {
      namesPath(await rejection(api.get(`/api/dates?scope=${TOKEN}`, {
        headers: sent, timeout: 300,
      })), { method: "GET", path: "/api/dates", kind: TIMED_OUT });

      namesPath(await rejection(api.post(`/api/drop?token=${TOKEN}`, {
        headers: sent, data: { a: 1 }, timeout: 5_000,
      })), { method: "POST", path: "/api/drop", kind: DROPPED });
    } finally {
      await api.dispose();
    }
  });

  test("through route.fetch(), a relative URL names its path without " +
    "the query and holds no header", async () => {
    const api = await request.newContext({ baseURL: base });
    const context = new EventEmitter();
    const handlers = [];

    context.route = async (url, handler) => {
      handlers.push(handler);
    };
    context.unroute = async () => {};
    context.request = { fetch: async () => ({ status: () => 200 }) };
    context.pages = () => [];
    context.newPage = async () => ({ route: async () => {},
      unroute: async () => {} });
    context.cookies = async () => [];

    try {
      let handed;

      watchContext(context, "test");
      await context.route("**/api/**", (route) => {
        handed = route;
      });

      const req = { url: () => `${base}/api/stock`, method: () => "GET" };

      // Route.fetch resolves a relative `url` as the context's request
      // does, against its baseURL, with the browser's headers.
      await handlers[0]({
        request: () => req,
        fulfill: async () => {},
        abort: async () => {},
        fetch: (options = {}) => api.fetch(options.url || req.url(), {
          method: options.method || "GET", headers: sent, timeout: 300,
        }),
      }, req);

      namesPath(await rejection(handed.fetch({
        url: `/api/dates?scope=${TOKEN}`,
      })), { method: "GET", path: "/api/dates", kind: TIMED_OUT });
    } finally {
      await api.dispose();
    }
  });

  test("through followLink(), a relative link names its path without " +
    "the query and holds no token", async () => {
    const link = `/api/auth/verify?token=${TOKEN}`;
    const page = {
      goto: async (url) => {
        const resolved = new URL(url, base).href;
        const error = new Error("page.goto: Timeout 300ms exceeded.\n" +
          "Call log:\n\u001b[2m  - navigating to " +
          `"${resolved}", waiting until "load"\u001b[22m\n`);

        error.name = "TimeoutError";
        throw error;
      },
    };

    namesPath(await rejection(followLink(page, link)), {
      method: "GET", path: "/api/auth/verify",
      kind: /timed out after 300 ms/,
    });
  });

  test("a URL that cannot be read at all does not make the error " +
    "builder throw", () => {
    const first = Object.assign(new Error("Timeout 300ms exceeded."),
      { name: "TimeoutError" });
    const unreadable = [
      undefined, null, "", 42, {}, Symbol("url"),
      `http://[::1?token=${TOKEN}`,
      `http://exa mple.com/x?token=${TOKEN}`,
      { toString() { throw new Error(TOKEN); } },
      { [Symbol.toPrimitive]() { throw new Error(TOKEN); } },
    ];

    for (const url of unreadable) {
      let made;

      assert.doesNotThrow(() => {
        made = requestError("GET", url, first);
      }, `requestError threw for ${typeof url} ${
        typeof url === "symbol" ? "symbol" : "value"}`);
      assert.ok(made instanceof Error, "returns an error");
      assert.ok(!printed(made).includes(TOKEN), "holds no token");
      assert.match(made.message, /^GET /, "names the method");
      assert.match(made.message, TIMED_OUT, "names the kind of failure");
    }
  });
});
