// A press before the first stock answer (#284). Save on a change to a
// paid order waits on no SDK, so it can come within a moment of the
// page asking /api/stock, while the gate is still unknown; refused
// then, it had nothing to say, and Save did nothing. The page waits on
// `ready()` instead: it settles once stock is known, or once the first
// load has given up and the notice is up, and at once after either.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { Stock } from "../assets/scripts/order/stock.js";

const ITEMS = { "NFF-CHK-EGG-LG": { inStock: true, available: 12 } };

// The least of a DOM the module reads: a region for the skeleton, a
// form with no rows, a document with no callout.
const element = () => ({
  nodeType: 1,
  dataset: {},
  hidden: false,
  setAttribute() {},
  removeAttribute() {},
  toggleAttribute() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
});

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe("Stock.ready()", () => {
  const saved = {};
  let answers;
  let asked;
  let stock;

  beforeEach(() => {
    const catalog = element();

    saved.document = globalThis.document;
    saved.window = globalThis.window;
    saved.fetch = globalThis.fetch;
    globalThis.document = {
      visibilityState: "visible",
      getElementById: (id) => (id === "order-catalog" ? catalog : null),
      querySelector: () => null,
      addEventListener() {},
    };
    globalThis.window = { addEventListener() {} };
    answers = [];
    asked = 0;
    globalThis.fetch = () => {
      asked += 1;

      return new Promise((resolve) => { answers.push(resolve); });
    };
    stock = new Stock(element(), { onChange() {} });
  });

  afterEach(async () => {
    // A load left pending gets its answer, so no timer outlives the test.
    while (answers.length) answer({});
    await stock.loading;
    clearTimeout(stock.timer);
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  });

  const answer = (items) => answers.shift()({
    ok: items !== null, json: async () => ({ items }),
  });

  it("settles with the items once the first answer is in", async () => {
    stock.start();
    assert.equal(stock.locked, true, "unknown until the first answer");
    assert.equal(stock.down, false, "and nothing to point at");

    let settled = false;
    const ready = stock.ready().then((items) => {
      settled = true;

      return items;
    });

    await flush();
    assert.equal(settled, false, "waits for the answer");
    assert.equal(asked, 1);

    answer(ITEMS);
    assert.deepEqual(await ready, ITEMS);
    assert.equal(stock.locked, false, "the gate is open");
    assert.deepEqual(stock.items, ITEMS);
  });

  it("settles at once, without asking again, once stock is known",
    async () => {
      stock.start();
      await flush();
      answer(ITEMS);
      await stock.ready();

      const before = asked;

      assert.deepEqual(await stock.ready(), ITEMS);
      assert.equal(asked, before);
    });

  it("settles null once the first load gives up, with the notice up",
    async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        stock.start();

        const ready = stock.ready();

        await flush();

        // Four attempts, each refused, with the backoff's waits between.
        for (const wait of [2000, 5000, 15000]) {
          answer(null);
          await flush();
          mock.timers.tick(wait);
          await flush();
        }
        answer(null);
        assert.equal(await ready, null);
        assert.equal(asked, 4);
        assert.equal(stock.down, true, "the notice is up");
        assert.equal(stock.locked, true);
      } finally {
        mock.timers.reset();
      }
    });

  it("settles at once before start(), with nothing", async () => {
    assert.equal(await stock.ready(), null);
    assert.equal(asked, 0);
  });
});
