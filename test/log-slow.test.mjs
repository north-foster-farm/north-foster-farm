// A slow or failed answer leaves one line naming its path and the e2e
// test it came from (#507), so a failed staging run finds its own.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SLOW_MS, testOf, withLog } from "../netlify/functions/lib/log.mjs";

const SCOPE = "run1234-desktop-0-abcdef";

// -> the warn lines a call wrote, parsed.
const warned = async (fn) => {
  const real = console.warn;
  const out = [];

  console.warn = (text) => out.push(JSON.parse(text));
  try {
    await fn();
  } finally {
    console.warn = real;
  }

  return out;
};

// A clock that moves `ms` between the start and the answer.
const clock = (ms) => {
  let t = 0;

  return () => {
    const at = t;

    t += ms;

    return at;
  };
};

const request = (cookie) => new Request(
  "https://stg.example/api/staging/e2e?token=secret",
  { method: "POST", headers: cookie ? { cookie } : {} },
);
const quiet = { flushImpl: async () => 0, onCrash: null };

describe("function.slow", () => {
  it("logs an answer past SLOW_MS with path, status, time and test",
    async () => {
      const handler = withLog("staging", async () => new Response("ok"),
        { ...quiet, now: clock(SLOW_MS + 1) });
      const lines = await warned(() => handler(
        request(`a=b; nff_stock_scope=${SCOPE}`), {}));
      const slow = lines.find((l) => l.event === "function.slow");

      assert.ok(slow);
      assert.equal(slow.function, "staging");
      assert.equal(slow.path, "/api/staging/e2e");
      assert.equal(slow.method, "POST");
      assert.equal(slow.status, 200);
      assert.equal(slow.ms, SLOW_MS + 1);
      assert.equal(slow.test, SCOPE);
      assert.ok(!JSON.stringify(slow).includes("secret"));
    });

  it("logs a quick 5xx, and nothing for a quick answer", async () => {
    const failing = withLog("staging",
      async () => new Response("no", { status: 503 }),
      { ...quiet, now: clock(10) });
    const fine = withLog("staging", async () => new Response("ok"),
      { ...quiet, now: clock(10) });

    const bad = await warned(() => failing(request(), {}));
    const good = await warned(() => fine(request(), {}));

    assert.equal(bad.filter((l) => l.event === "function.slow").length, 1);
    assert.equal(bad[0].test, null);
    assert.equal(good.filter((l) => l.event === "function.slow").length, 0);
  });

  it("takes only a well-formed scope as the test", () => {
    assert.equal(testOf(request(`nff_stock_scope=${SCOPE}`)), SCOPE);
    assert.equal(testOf(request("nff_stock_scope=a<b")), null);
    assert.equal(testOf(request()), null);
    assert.equal(testOf(undefined), null);
  });
});
