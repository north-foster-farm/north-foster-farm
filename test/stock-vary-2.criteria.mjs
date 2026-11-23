// Criteria tests for #994, second part: two ways around the cache key
// that security found reading the implementation on PR #996
// (2026-11-23), one test per criterion, each named for its box.
//
// 1. A repeated parameter. The function read the first `final` value,
//    so `?final=0&final=1` was answered as browsing, with the edge
//    cache headers, and Netlify's documentation does not say how a
//    repeated parameter keys: that answer might be stored under the
//    key of the real `?final=1`. The issue's rule is that the check
//    before paying is never stored, so any query carrying `final` at
//    all is never stored.
// 2. The pin cookie. Cookie values are part of the cache key, and
//    anyone can send `nff_stock_scope=<random>` to force a miss, yet
//    pins are never allowed in production. So `Netlify-Vary` names the
//    cookie only where pins are allowed, and is `query=final` alone
//    anywhere else. The test drives that through the env the function
//    reads (lib/stock-pins.mjs's pinsAllowed: SITE_CONTEXT or CONTEXT
//    in PIN_CONTEXTS and SQUARE_ENV not production), and checks each
//    env it uses against pinsAllowed so a change there shows here.
//
// The second revises the first criteria file's production expectation
// (test/stock-vary.criteria.mjs, box 1) to `query=final` alone, in the
// same commit.
//
// Provisional, as the first file: the header is read as Netlify's
// caching overview describes it ("Cache key variation"), comma-
// separated `kind=list` instructions with pipe-delimited lists, in
// either order.
//
// Held out of npm test by its name until the change lands: renamed to
// stock-vary-2.test.mjs. The seam: the function's handle() takes a
// Request, `env` and `ip`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edgeSeconds } from "./edge-cache.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { pinsAllowed } from "../netlify/functions/lib/stock-pins.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const ORIGIN = "https://www.northfosterfarm.com";
const PRODUCTION = { CONTEXT: "production" };

let address = 0;

// A fresh address per request, so no rate limit is reached.
const ask = (path, env = PRODUCTION, headers = {}) =>
  handle(new Request(`${ORIGIN}${path}`, { headers }), {
    stores: testStores(), env, ip: `198.51.100.${++address}`,
    inventory: async () => null,
  });

// Netlify-Vary as { kind: [names] }, every instruction kept.
const varyOf = (headers) => {
  const out = {};

  for (const part of (headers.get("netlify-vary") || "").split(",")) {
    const [kind, list = ""] = part.trim().split("=");

    if (!kind) continue;

    (out[kind.trim().toLowerCase()] ||= []).push(...list.split("|")
      .map((name) => name.trim()).filter(Boolean));
  }

  for (const kind of Object.keys(out)) out[kind].sort();

  return out;
};

describe("/api/stock's edge cache key, second part (#994)", () => {
  it("A request whose query carries final at all, in any form, gets no "
    + "edge cache header; only a request with no final parameter is "
    + "cacheable", async () => {
    const carrying = [
      "?final=1",
      "?final=0",
      "?final",
      "?final=",
      "?final=yes",
      "?final=0&final=1",
      "?final=1&final=0",
      "?final=0&final=0",
      "?anything=random&final=0",
      "?final=0&anything=random",
      "?anything=random&final=1&other=2",
      "?fin%61l=0",
    ];

    for (const query of carrying) {
      const res = await ask(`/api/stock${query}`);

      assert.equal(res.status, 200, query);
      assert.equal(edgeSeconds(res.headers), 0, `${query} is never stored`);
      const cdn = res.headers.get("netlify-cdn-cache-control");

      assert.equal(cdn, null, `${query}: Netlify-CDN-Cache-Control was ${cdn}`);
      assert.equal(res.headers.has("cdn-cache-control"), false, query);
      assert.equal(res.headers.has("netlify-vary"), false,
        `${query}: Netlify-Vary was ${res.headers.get("netlify-vary")}`);
      assert.equal(res.headers.get("cache-control"), "no-store", query);
    }

    for (const query of ["", "?anything=random", "?finally=1", "?x=final"]) {
      const res = await ask(`/api/stock${query}`);

      assert.equal(res.status, 200, query || "no query");
      assert.equal(edgeSeconds(res.headers), 15,
        `${query || "no query"} is kept at the edge for 15 s`);
    }
  });

  it("Netlify-Vary names the nff_stock_scope cookie only where pins are "
    + "allowed; where they are not, it is query=final alone", async () => {
    const allowed = [
      { SITE_CONTEXT: "branch-deploy", SQUARE_ENV: "sandbox" },
      { SITE_CONTEXT: "deploy-preview", SQUARE_ENV: "sandbox" },
      { SITE_CONTEXT: "dev", SQUARE_ENV: "sandbox" },
    ];
    const refused = [
      PRODUCTION,
      { SITE_CONTEXT: "production", SQUARE_ENV: "production" },
      { SITE_CONTEXT: "production", SQUARE_ENV: "sandbox" },
      { SITE_CONTEXT: "branch-deploy", SQUARE_ENV: "production" },
    ];
    const sides = [
      [allowed, true, { cookie: ["nff_stock_scope"], query: ["final"] }],
      [refused, false, { query: ["final"] }],
    ];

    for (const [envs, pins, keyed] of sides) {
      for (const env of envs) {
        const name = JSON.stringify(env);

        assert.equal(pinsAllowed(env), pins, `pins allowed under ${name}`);

        for (const cookie of [undefined, "nff_stock_scope=random-1234567"]) {
          const res = await ask("/api/stock?anything=random", env,
            cookie ? { cookie } : {});

          assert.equal(res.status, 200, name);
          assert.equal(edgeSeconds(res.headers), 15,
            `${name} is kept at the edge for 15 s`);
          const vary = res.headers.get("netlify-vary");

          assert.deepEqual(varyOf(res.headers), keyed,
            `${name}, cookie ${cookie}: Netlify-Vary was ${vary}`);
        }
      }
    }
  });
});
