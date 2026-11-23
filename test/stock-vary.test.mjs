// Criteria tests for #994 (key the stock cache only on the final flag
// and the pin cookie), a follow-up to #908, one per box of "Done when"
// marked (test), each named for its box.
//
// /api/stock's browsing answer is kept at Netlify's edge for 15
// seconds (#908, rule 7). Netlify keys a cached answer on every query
// parameter by default, so a random one bypasses the cache. The fix
// keys it only on what varies the answer.
//
// Provisional, written to the issue's proposal:
// - the header is `Netlify-Vary: query=final,cookie=nff_stock_scope`.
//   The test reads it as Netlify's caching overview describes it
//   ("Cache key variation"): comma-separated instructions, each
//   `kind=list` with a pipe-delimited list. It holds the header to one
//   `query` instruction naming only `final` and one `cookie`
//   instruction naming only `nff_stock_scope`, and no other kind, in
//   either order;
// - the issue leaves two things to settle on staging: how a request
//   with both a listed and an unlisted parameter is keyed, and whether
//   query and cookie combine as the comma rule implies. Neither can be
//   settled in a unit test; these tests take the comma rule as given.
//
// Boxes 2 and 3 say the existing tests pass unedited: those are
// test/stock-follow.test.mjs ("The check right before paying gets a
// fresh answer, not the edge's cached one") and
// test/stock-pay-cap.test.mjs (the 429's no-store). The tests here for
// those boxes are guards restating them from the issue's words, and
// pass before and after the change.
//
// The staging check and security's review are not unit tests.
//
// Held out of npm test by its name until the change lands: renamed to
// stock-vary.test.mjs. The seam: the function's handle() takes a
// Request, `now`, `ip` and `env`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edgeSeconds } from "./edge-cache.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const ORIGIN = "https://www.northfosterfarm.com";
const PRODUCTION = { CONTEXT: "production" };
const BROWSING_LIMIT = 240;
const PAYING_LIMIT = 60;

const ask = (path, ip) => handle(new Request(`${ORIGIN}${path}`), {
  stores: testStores(), env: PRODUCTION, ip,
  inventory: async () => null,
});

// Netlify-Vary as { kind: [names] }, every instruction kept.
const varyOf = (headers) => {
  const out = {};

  for (const part of (headers.get("netlify-vary") || "").split(",")) {
    const text = part.trim();

    if (!text) continue;

    const at = text.indexOf("=");
    const kind = (at < 0 ? text : text.slice(0, at)).trim().toLowerCase();
    const names = at < 0 ? [] : text.slice(at + 1).split("|")
      .map((name) => name.trim()).filter(Boolean);

    (out[kind] ||= []).push(...names);
  }

  for (const kind of Object.keys(out)) out[kind].sort();

  return out;
};

const KEYED = { cookie: ["nff_stock_scope"], query: ["final"] };

// Whether the answer leaves anything at the edge.
const stored = (headers) => edgeSeconds(headers) > 0
  || headers.has("netlify-cdn-cache-control")
  || headers.has("cdn-cache-control");

describe("/api/stock's edge cache key (#994)", () => {
  it("The browsing answer from /api/stock carries Netlify-Vary naming "
    + "only the final query parameter and the nff_stock_scope cookie",
  async () => {
    for (const path of ["/api/stock", "/api/stock?anything=random"]) {
      const res = await ask(path, "198.51.100.71");

      assert.equal(res.status, 200, path);
      assert.equal(edgeSeconds(res.headers), 15,
        `${path} is still kept at the edge for 15 s`);
      assert.deepEqual(varyOf(res.headers), KEYED,
        `${path}: Netlify-Vary was ${res.headers.get("netlify-vary")}`);
    }
  });

  it("The check before paying (?final=1) still carries no cache header "
    + "and is never stored", async () => {
    const res = await ask("/api/stock?final=1", "198.51.100.72");

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(stored(res.headers), false,
      "no header keeps it at the edge");
  });

  it("A refusal (429) is still never stored", async () => {
    let browsing;

    for (let i = 0; i <= BROWSING_LIMIT; i++) {
      browsing = await ask("/api/stock?anything=random", "198.51.100.73");
    }

    let paying;

    for (let i = 0; i <= PAYING_LIMIT; i++) {
      paying = await ask("/api/stock?final=1", "198.51.100.74");
    }

    for (const [name, res] of [["browsing", browsing], ["paying", paying]]) {
      assert.equal(res.status, 429, `${name} is refused`);
      assert.equal(res.headers.get("cache-control"), "no-store", name);
      assert.equal(stored(res.headers), false,
        `${name}'s refusal is not kept at the edge`);
    }
  });
});
