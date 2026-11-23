// Criteria test for #908 (Order page: follow stock within seconds
// while a customer is browsing), rule 7's box: /api/stock is cached at
// Netlify's edge for 15 seconds. Its own file, so that it can wait
// apart from the rest (test/stock-follow.criteria.mjs) while James
// decides whether the edge cache may be proved on staging.
//
// Provisional: the cache may be set by any header Netlify's edge
// honors (test/edge-cache.mjs): Netlify-CDN-Cache-Control or
// CDN-Cache-Control with max-age or s-maxage 15, or Cache-Control with
// s-maxage 15.
//
// Held out of npm test by its name until the change lands: renamed to
// stock-edge.test.mjs. The seam: the function's handle() takes a
// Request, `now`, `ip` and `env`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edgeSeconds } from "./edge-cache.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

describe("/api/stock at Netlify's edge (#908)", () => {
  it("/api/stock answers with headers that cache it at Netlify's edge "
    + "for 15 seconds", async () => {
    const res = await handle(
      new Request("https://www.northfosterfarm.com/api/stock"), {
        stores: testStores(), env: { CONTEXT: "production" },
        ip: "198.51.100.25", inventory: async () => null,
      });

    assert.equal(res.status, 200);
    assert.equal(edgeSeconds(res.headers), 15,
      "kept at the edge for 15 s");
  });
});
