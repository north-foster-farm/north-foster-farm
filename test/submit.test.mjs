import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Submitter } from "../assets/scripts/order/submit.js";

const realFetch = globalThis.fetch;
const answer = (status, body) => {
  globalThis.fetch = async () => new Response(
    body === undefined ? null : JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } }
  );
};
const send = () => new Submitter().send({ idempotencyKey: "k" });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("what the page makes of an answer", () => {
  it("retries a 503 and a lost connection", async () => {
    answer(503, { retryable: true });
    assert.equal((await send()).kind, "retry");

    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.equal((await send()).kind, "retry");
  });

  it("does not retry a 502 or another 5xx", async () => {
    answer(502, { message: "Square said no.", retryable: false });

    const r = await send();

    assert.equal(r.kind, "failed");
    assert.equal(r.message, "Square said no.");

    answer(500, {});
    assert.equal((await send()).kind, "failed");
  });

  it("says to wait on a 429, and never retries it", async () => {
    answer(429, { message: "There have been too many tries from here." });

    const r = await send();

    assert.equal(r.kind, "busy");
    assert.match(r.message, /too many tries/);
  });

  it("never takes an empty 204 for a placed order", async () => {
    answer(204);
    assert.equal((await send()).kind, "failed");
  });

  it("takes a 200 for success", async () => {
    answer(200, { orderId: "NFF-2610-ABCD" });
    assert.deepEqual(await send(), {
      kind: "ok", data: { orderId: "NFF-2610-ABCD" },
    });
  });
});
