// The Blobs answers its client retries after a 5 s sleep are logged by
// store and status, so a slow staging call shows why (#516).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { watchedFetch } from "../netlify/functions/lib/store.mjs";

const answer = (status, headers = {}) => async () =>
  new Response(null, { status, headers });

describe("watchedFetch", () => {
  const watch = (t) => {
    const lines = [];

    t.mock.method(console, "warn", (text) => {
      lines.push(JSON.parse(text));
    });

    return lines;
  };

  it("logs a 429 or a 5xx with the store and status, never the URL",
    async (t) => {
      const lines = watch(t);
      const url = "https://blobs.test/customers/customer/pat@example.com";

      const limited = await watchedFetch("customers",
        answer(429, { "X-RateLimit-Reset": "1" }))(url, { method: "delete" });
      const down = await watchedFetch("orders", answer(503))(url);

      assert.equal(limited.status, 429);
      assert.equal(down.status, 503);
      assert.deepEqual(lines.map((l) => [
        l.event, l.store, l.method, l.status, l.rateLimitReset,
      ]), [
        ["blobs.retryable", "customers", "delete", 429, true],
        ["blobs.retryable", "orders", "get", 503, false],
      ]);
      assert.ok(!JSON.stringify(lines).includes("blobs.test"));
    });

  it("passes a good answer through unlogged", async (t) => {
    const lines = watch(t);
    const res = await watchedFetch("jobs", answer(200))("https://b.test/");

    assert.equal(res.status, 200);
    assert.deepEqual(lines, []);
  });

  it("logs a request that got no answer and throws it on", async (t) => {
    const lines = watch(t);
    const fail = async () => {
      throw new Error("socket hang up");
    };

    await assert.rejects(watchedFetch("auth", fail)("https://b.test/"),
      /socket hang up/);
    assert.deepEqual(lines.map((l) => [l.store, l.status, l.error]),
      [["auth", null, "socket hang up"]]);
  });
});
