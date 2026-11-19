// Criteria tests for #665, written by a test agent from the issue's
// spec and "Done when" list before the fix: the e2e suite must not
// print request headers when a request of its own fails or times out,
// and masks a session cookie when it obtains one. One test per
// criterion, each named for it. Held out of npm test by this file's
// name; renaming it to test/e2e-request-errors.test.mjs turns it on.
//
// Every request goes to a local server of this test's own, through
// Playwright's real request context and Node's real fetch, so each
// error is the one the suite would meet. The header values are made
// up and match nothing real.
//
// The contract the fix meets, beyond the issue's words:
// - e2e/support/counted.mjs exports `watchRequests(api, spec)` and
//   `watchContext(context, spec)`, the watchers it already has.
// - "The kind of failure" is said in words a person can act on: a
//   timeout says it timed out; a dropped connection says so ("socket
//   hang up", "closed", "reset", "refused").
// - The mask is the runner's: `::add-mask::<value>` on a line of its
//   own on process.stdout, written only when GITHUB_ACTIONS is
//   "true", by the time the response that set the cookie is handed
//   back. Off GitHub the value is not written at all.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { inspect } from "node:util";

import { request } from "@playwright/test";

import { COOKIE as SESSION } from "../netlify/functions/lib/auth.mjs";

// Made-up values, never a real one.
const COOKIE_VALUE = "madeup-cookie-665-c0ffee";
const AUTH_VALUE = "madeup-auth-665-decaf";
const TOKEN = "madeup-token-665-feed";
const SESSION_VALUE = "madeup-session-665-beef";

// /api/hold never answers; /api/drop closes the connection unanswered;
// /api/verify answers with a session cookie. The back office's path
// does as its op says: "hold" or "drop".
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const drop = () => req.socket.destroy();

  if (pathname === "/api/hold") return;
  if (pathname === "/api/drop") return drop();
  if (pathname === "/api/verify") {
    res.writeHead(200, {
      "set-cookie": `${SESSION}=${SESSION_VALUE}; Path=/; HttpOnly`,
      "content-type": "text/plain",
    });
    res.end("ok");
    return;
  }
  if (pathname === "/api/staging/e2e") {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (JSON.parse(body).op === "drop") drop();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

let base;
let watchRequests;
let watchContext;
let op;

before(async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  // The back office reads both when it loads (staging.mjs), and the
  // watchers (counted.mjs) load it.
  process.env.E2E_BASE_URL = base;
  process.env.E2E_STAGING_TOKEN = TOKEN;
  ({ op } = await import("../e2e/support/staging.mjs"));
  ({ watchRequests, watchContext } = await import(
    "../e2e/support/counted.mjs"
  ));
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// Everything a reporter could print of an error: its message, its
// stack, its own fields (Playwright's `log`) and its causes.
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

// What the criteria ask of one error: neither value, and the method,
// path and kind named.
const holdsNoSecret = (error, secrets, { method, path, kind }) => {
  const text = printed(error);
  const shown = secrets.reduce((t, s) => t.replaceAll(s, "<a value>"),
    text);

  for (const secret of secrets) {
    assert.ok(!text.includes(secret),
      `the error prints a header value it was sent with:\n${shown}`);
  }
  assert.match(String(error.message), new RegExp(`\\b${method}\\b`),
    "names the method");
  assert.ok(String(error.message).includes(path), "names the path");
  assert.match(String(error.message), kind, "names the kind of failure");
};

// Writes to process.stdout while `fn` runs, passed through as well.
const stdoutOf = async (fn) => {
  const write = process.stdout.write;
  let seen = "";

  process.stdout.write = function (chunk, ...rest) {
    seen += String(chunk);

    return write.call(this, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }

  return seen;
};

const MASKED = (value) => new RegExp(`(^|\\n)::add-mask::${value}\\r?\\n`);

describe("the e2e suite's request errors (#665)", () => {
  const sent = { cookie: `${SESSION}=${COOKIE_VALUE}`,
    authorization: `Bearer ${AUTH_VALUE}` };

  // Done when 1, and the spec's "fails or times out".
  test("a request through the wrapper that times out or fails, with a " +
    "cookie and an authorization header, raises an error holding " +
    "neither value and naming the method, path and kind of failure",
  async () => {
    const api = watchRequests(await request.newContext(), "test");

    try {
      const late = await rejection(api.get(`${base}/api/hold`, {
        headers: sent, timeout: 300,
      }));

      holdsNoSecret(late, [COOKIE_VALUE, AUTH_VALUE],
        { method: "GET", path: "/api/hold", kind: TIMED_OUT });

      const dropped = await rejection(api.post(`${base}/api/drop`, {
        headers: sent, data: { a: 1 }, timeout: 5_000,
      }));

      holdsNoSecret(dropped, [COOKIE_VALUE, AUTH_VALUE],
        { method: "POST", path: "/api/drop", kind: DROPPED });
    } finally {
      await api.dispose();
    }
  });

  // The spec's second line: op() in staging.mjs does the same.
  test("op() that times out or fails raises an error holding no token " +
    "and naming the method, path and kind of failure", async () => {
    const late = await rejection(op("hold", {},
      { tries: 1, timeoutMs: 300 }));

    holdsNoSecret(late, [TOKEN],
      { method: "POST", path: "/api/staging/e2e", kind: TIMED_OUT });

    const dropped = await rejection(op("drop", {},
      { tries: 1, timeoutMs: 5_000 }));

    holdsNoSecret(dropped, [TOKEN],
      { method: "POST", path: "/api/staging/e2e", kind: DROPPED });
  });

  // Done when 3: on a browser context, where the suite signs in, and
  // on a request context.
  test("a session cookie is registered with the runner's mask when the " +
    "suite obtains it", async () => {
    const was = process.env.GITHUB_ACTIONS;

    process.env.GITHUB_ACTIONS = "true";
    try {
      // A request context: the cookie arrives on a real response.
      const api = watchRequests(await request.newContext(), "test");
      const fromRequest = await stdoutOf(async () => {
        await api.get(`${base}/api/verify`);
      });

      await api.dispose();
      assert.match(fromRequest, MASKED(SESSION_VALUE),
        "a request context's session cookie is masked");

      // A browser context, as Playwright hands one to the watcher: the
      // sign-in's response sets the cookie and the context holds it.
      const context = fakeContext([{ name: SESSION, value: SESSION_VALUE,
        domain: "127.0.0.1", path: "/", httpOnly: true }]);
      const fromBrowser = await stdoutOf(async () => {
        watchContext(context, "test");
        context.emit("response", signInResponse(`${base}/api/verify`));
        context.emit("requestfinished", signInResponse(
          `${base}/api/verify`).request());
        for (let i = 0; i < 20; i += 1) {
          await new Promise((done) => setTimeout(done, 10));
        }
      });

      assert.match(fromBrowser, MASKED(SESSION_VALUE),
        "a browser context's session cookie is masked");
    } finally {
      if (was === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = was;
    }
  });

  // The contract, not a box: off GitHub the value is never written.
  test("off GitHub the session cookie's value is not written", async () => {
    const was = process.env.GITHUB_ACTIONS;

    delete process.env.GITHUB_ACTIONS;
    try {
      const api = watchRequests(await request.newContext(), "test");
      const out = await stdoutOf(async () => {
        await api.get(`${base}/api/verify`);
      });

      await api.dispose();
      assert.ok(!out.includes(SESSION_VALUE));
    } finally {
      if (was !== undefined) process.env.GITHUB_ACTIONS = was;
    }
  });
});

// A stand-in for a browser context and its sign-in response, with
// every accessor Playwright's own has for what the watcher reads.
const signInResponse = (url) => {
  const headers = {
    "set-cookie": `${SESSION}=${SESSION_VALUE}; Path=/; HttpOnly`,
    "content-type": "text/plain",
  };
  const array = Object.entries(headers)
    .map(([name, value]) => ({ name, value }));
  const req = {
    url: () => url, method: () => "GET", headers: () => ({}),
    allHeaders: async () => ({}), headersArray: async () => [],
    headerValue: async () => null,
  };

  return {
    url: () => url, status: () => 200, ok: () => true,
    text: async () => "ok", request: () => req,
    headers: () => ({ ...headers }), allHeaders: async () => ({ ...headers }),
    headersArray: async () => array,
    headerValue: async (name) => headers[name.toLowerCase()] ?? null,
    headerValues: async (name) => (headers[name.toLowerCase()]
      ? [headers[name.toLowerCase()]] : []),
  };
};

const fakeContext = (cookies) => {
  const context = new EventEmitter();

  context.route = async () => {};
  context.unroute = async () => {};
  context.request = { fetch: async () => ({ status: () => 200 }) };
  context.pages = () => [];
  context.newPage = async () => ({ route: async () => {},
    unroute: async () => {} });
  context.cookies = async () => cookies.map((c) => ({ ...c }));

  return context;
};
