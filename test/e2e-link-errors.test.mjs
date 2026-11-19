// The implementer's own tests for #665, beside the criteria tests in
// e2e-request-errors.test.mjs and after the security review of pull
// request 670: two more ways the suite's own requests could print a
// credential.
//
// - route.fetch(): Playwright sends it through the context's request
//   past the wrapper, with the browser's headers. Tested here with a
//   real request context against a local server that never answers
//   or drops the connection, so the first error is Playwright's own,
//   call log and all. The route is a stand-in whose fetch() makes that
//   request: a real route needs a browser, which the unit suite has
//   not got in CI.
// - followLink(): page.goto of a link with a token in its query. A
//   page needs a browser too, so the page here is a stand-in whose
//   goto() throws what Playwright's threw, recorded from Playwright
//   1.62.1 on 2026-11-19 (Chromium and WebKit, a made-up token, a
//   local server that never answers or drops the connection;
//   the port replaced). Not covered here: that a real page's error
//   has no other field holding the URL. The recording showed only
//   `name` and `message`, and followLink copies neither.
//
// Every value is made up and matches nothing real.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { inspect } from "node:util";

import { request } from "@playwright/test";

const COOKIE_VALUE = "madeup-cookie-665-route";
const AUTH_VALUE = "madeup-auth-665-route";
const TOKEN = "madeup-token-665-feed";

const server = createServer((req) => {
  if (req.url.startsWith("/api/drop")) req.socket.destroy();
});

let base;
let watchContext;
let followLink;

before(async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.E2E_BASE_URL = base;
  ({ watchContext } = await import("../e2e/support/counted.mjs"));
  ({ followLink } = await import("../e2e/support/request-error.mjs"));
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
  assert.fail("it did not fail");
};

const clean = (error, secrets, { method, path, kind }) => {
  const text = printed(error);

  for (const secret of secrets) {
    assert.ok(!text.includes(secret), "the error holds a value it was " +
      `sent with:\n${text.replaceAll(secret, "<a value>")}`);
  }
  assert.ok(!text.includes("Call log"), "no call log");
  assert.equal(error.cause, undefined, "no cause");
  assert.match(error.message, new RegExp(`\\b${method} ${
    path.replaceAll("/", "\\/")}: `), "names the method and path");
  assert.match(error.message, kind, "names the kind of failure");
};

// A browser context as the watcher needs one, whose route() hands the
// handler it was given back to the test.
const contextWithRoutes = () => {
  const context = new EventEmitter();

  context.handlers = [];
  context.route = async (url, handler) => {
    context.handlers.push(handler);
  };
  context.unroute = async () => {};
  context.request = { fetch: async () => ({ status: () => 200 }) };
  context.pages = () => [];
  context.newPage = async () => ({ route: async () => {},
    unroute: async () => {} });
  context.cookies = async () => [];

  return context;
};

describe("route.fetch() through the watcher (#665)", () => {
  // The browser's own headers, as Route.fetch sends them.
  const sent = { cookie: `nff_session=${COOKIE_VALUE}`,
    authorization: `Bearer ${AUTH_VALUE}` };

  // The route a spec's handler is handed, for a request to `url`:
  // fetch() is a real request that fails as the server makes it.
  const watchedRoute = async (api, url, method, timeout) => {
    const context = contextWithRoutes();
    let handed;

    watchContext(context, "test");
    await context.route("**/api/**", (route) => {
      handed = route;
    });

    const req = { url: () => url, method: () => method };

    await context.handlers[0]({
      request: () => req,
      fulfill: async () => {},
      abort: async () => {},
      fetch: (options = {}) => api.fetch(options.url || url, {
        method: options.method || method, headers: sent, timeout,
      }),
    }, req);

    return handed;
  };

  test("a route.fetch() that times out raises an error holding no " +
    "header and naming the method, path and kind", async () => {
    const api = await request.newContext();

    try {
      const route = await watchedRoute(api,
        `${base}/api/stock?scope=${TOKEN}`, "GET", 300);

      clean(await rejection(route.fetch()),
        [COOKIE_VALUE, AUTH_VALUE, TOKEN],
        { method: "GET", path: "/api/stock", kind: /timed out/ });
    } finally {
      await api.dispose();
    }
  });

  test("a route.fetch() whose connection drops does the same, with " +
    "the method and URL the handler asked for", async () => {
    const api = await request.newContext();

    try {
      const route = await watchedRoute(api, `${base}/api/stock`, "GET",
        5_000);

      clean(await rejection(route.fetch({
        url: `${base}/api/drop?token=${TOKEN}`, method: "POST",
      })), [COOKIE_VALUE, AUTH_VALUE, TOKEN], {
        method: "POST", path: "/api/drop",
        kind: /hang up|closed|reset|refused/,
      });
    } finally {
      await api.dispose();
    }
  });
});

describe("followLink() (#665)", () => {
  const link = (path) => `http://127.0.0.1:4010${path}?token=${TOKEN}`;
  const log = (url) => "\nCall log:\n\u001b[2m  - navigating to " +
    `"${url}", waiting until "load"\u001b[22m\n`;

  // What page.goto threw, recorded (see the header).
  const RECORDED = [
    { what: "a timeout, Chromium and WebKit", path: "/api/auth/verify",
      name: "TimeoutError", kind: /timed out after 300 ms/,
      message: (url) => `page.goto: Timeout 300ms exceeded.${log(url)}` },
    { what: "a dropped connection, Chromium", path: "/api/drop",
      name: "Error", kind: /connection closed/,
      message: (url) => `page.goto: net::ERR_EMPTY_RESPONSE at ${url}${
        log(url)}` },
    { what: "a dropped connection, WebKit", path: "/api/drop",
      name: "Error", kind: /connection closed/,
      message: (url) => `page.goto: The network connection was lost.${
        log(url)}` },
  ];

  for (const { what, path, name, kind, message } of RECORDED) {
    test(`${what}: the error holds no token and names GET, the path ` +
      "and the kind", async () => {
      const url = link(path);
      const page = {
        goto: async () => {
          const error = new Error(message(url));

          error.name = name;
          throw error;
        },
      };

      clean(await rejection(followLink(page, url)), [TOKEN],
        { method: "GET", path, kind });
    });
  }

  test("a link that opens is page.goto's own answer, options and all",
    async () => {
      const calls = [];
      const answer = { status: () => 200 };
      const page = {
        goto: async (...args) => {
          calls.push(args);

          return answer;
        },
      };
      const options = { waitUntil: "domcontentloaded" };

      assert.equal(await followLink(page, link("/x"), options), answer);
      assert.deepEqual(calls, [[link("/x"), options]]);
    });
});
