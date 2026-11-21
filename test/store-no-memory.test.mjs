// With `{ memory: false }`, stores() refuses the memory fallback
// (#713): the implementer's own test of the helper, beside the
// criteria tests in context-guard.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blobsMissing, stores } from "../netlify/functions/lib/store.mjs";

describe("stores without the memory fallback (#713)", () => {
  it("names what is missing, in order", () => {
    assert.deepEqual(blobsMissing({}),
      ["NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"]);
    assert.deepEqual(blobsMissing({ NETLIFY_AUTH_TOKEN: "t" }),
      ["NETLIFY_SITE_ID"]);
    assert.deepEqual(blobsMissing({ NETLIFY_SITE_ID: "s" }),
      ["NETLIFY_AUTH_TOKEN"]);
    assert.deepEqual(blobsMissing({
      NETLIFY_SITE_ID: "s", NETLIFY_AUTH_TOKEN: "t",
    }), []);
  });

  it("throws, naming the site ID, rather than fall back", () => {
    assert.throws(() => stores({ NETLIFY_AUTH_TOKEN: "t" },
      { memory: false }), /^Error: No NETLIFY_SITE_ID: refusing memory/);
  });

  it("still falls back to memory by default", () => {
    assert.equal(stores({}).persistent, false);
  });

  it("opens Blobs stores when both are set", () => {
    const s = stores({ NETLIFY_SITE_ID: "s", NETLIFY_AUTH_TOKEN: "t" },
      { memory: false });

    assert.equal(s.persistent, true);
  });
});
