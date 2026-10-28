// The site's JSON calls give up on a stalled connection (#507).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { API_TIMEOUT_MS, api } from "../assets/scripts/utils/api.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// A fetch that never answers, but stops when its signal does.
const stalled = (seen) => (url, init) => new Promise((resolve, reject) => {
  seen.push(init);
  init.signal.addEventListener("abort", () => reject(init.signal.reason));
});

describe("api", () => {
  it("rejects a request that never answers once its time is up",
    async () => {
      const seen = [];

      globalThis.fetch = stalled(seen);
      await assert.rejects(api("/api/me", { timeoutMs: 20 }),
        (error) => error.name === "TimeoutError");
      assert.equal(seen.length, 1);
    });

  it("gives every request a bound past Netlify's 30 s", async () => {
    const seen = [];

    globalThis.fetch = async (url, init) => {
      seen.push(init);

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const got = await api("/api/me");

    assert.ok(API_TIMEOUT_MS > 30_000);
    assert.ok(seen[0].signal instanceof AbortSignal);
    assert.equal(got.ok, true);
    assert.deepEqual(got.data, { ok: true });
  });
});
