import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FIRST_DELAYS, OPEN_EVERY, SHUT_EVERY, StockGate, withBackoff,
} from "../assets/scripts/order/lib/stock-gate.mjs";

describe("withBackoff", () => {
  const run = (answers, options = {}) => {
    const slept = [];
    let calls = 0;

    return withBackoff(async () => {
      const answer = answers[calls++];

      if (answer instanceof Error) throw answer;

      return answer;
    }, { sleep: async (ms) => slept.push(ms), ...options })
      .then((result) => ({ result, slept, calls }));
  };

  it("waits about 2, 5 and 15 seconds between four attempts", () => {
    assert.deepEqual(FIRST_DELAYS, [2000, 5000, 15000]);
  });

  it("answers at once when the first attempt does", async () => {
    const { result, slept, calls } = await run([{ a: 1 }]);

    assert.deepEqual(result, { a: 1 });
    assert.deepEqual(slept, []);
    assert.equal(calls, 1);
  });

  it("retries after a null and after a throw, with the delays", async () => {
    const { result, slept, calls } = await run([
      null, new Error("down"), { a: 1 },
    ]);

    assert.deepEqual(result, { a: 1 });
    assert.deepEqual(slept, [2000, 5000]);
    assert.equal(calls, 3);
  });

  it("gives up with null after the last delay", async () => {
    const { result, slept, calls } = await run([
      null, null, null, null, { a: 1 },
    ]);

    assert.equal(result, null);
    assert.deepEqual(slept, [2000, 5000, 15000]);
    assert.equal(calls, 4);
  });

  it("takes an empty answer as an answer", async () => {
    const { result, calls } = await run([{}]);

    assert.deepEqual(result, {});
    assert.equal(calls, 1);
  });
});

describe("StockGate", () => {
  it("is locked until stock has answered", () => {
    const gate = new StockGate();

    assert.equal(gate.locked, true);
    assert.equal(gate.down, false);
    gate.good();
    assert.equal(gate.locked, false);
  });

  it("shuts when the first check fails, once, and asks every 30 s", () => {
    const gate = new StockGate();

    assert.equal(gate.bad(), true);
    assert.equal(gate.bad(), false);
    assert.equal(gate.down, true);
    assert.equal(gate.locked, true);
    assert.equal(gate.every, SHUT_EVERY);
  });

  it("opens on the first good answer, and says so once", () => {
    const gate = new StockGate();

    gate.bad();
    assert.equal(gate.good(), true);
    assert.equal(gate.good(), false);
    assert.equal(gate.locked, false);
    assert.equal(gate.every, OPEN_EVERY);
  });

  it("keeps the last known stock through a failed refresh", () => {
    const gate = new StockGate();

    gate.good();
    assert.equal(gate.bad(), false);
    assert.equal(gate.down, false);
    assert.equal(gate.locked, false);
  });

  it("shuts when the check before a submission fails", () => {
    const gate = new StockGate();

    gate.good();
    assert.equal(gate.bad({ final: true }), true);
    assert.equal(gate.locked, true);
    assert.equal(gate.every, SHUT_EVERY);
    assert.equal(gate.good(), true);
    assert.equal(gate.locked, false);
  });
});
