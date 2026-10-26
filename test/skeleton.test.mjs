// The loading skeleton's timing (#271): scripts/utils/skeleton.js
// against stand-in elements and a mocked clock.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  GIVE_UP_MS, HOLD_MS, SHOW_AFTER_MS, whileLoading,
} from "../assets/scripts/utils/skeleton.js";

// Just what the helper touches: data-load, aria-busy and a retry link.
const region = () => {
  const attrs = {};
  const link = { onclick: null };

  return {
    nodeType: 1,
    dataset: {},
    link,
    attrs,
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: (name) => { delete attrs[name]; },
    querySelectorAll: () => [link],
  };
};

// Lets the promise chain run between clock ticks.
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const tick = async (ms) => {
  mock.timers.tick(ms);
  await flush();
};

// A request that answers when told.
const held = () => {
  let answer;
  const promise = new Promise((resolve) => { answer = resolve; });

  return { request: () => promise, answer };
};

describe("the loading skeleton", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("never shows the bars for a quick answer", async () => {
    const el = region();
    const { request, answer } = held();
    const rendered = [];
    const done = whileLoading(el, request, { render: (r) => rendered.push(r) });

    assert.equal(el.dataset.load, "wait");
    assert.equal(el.attrs["aria-busy"], "true");
    await tick(SHOW_AFTER_MS - 50);
    answer({ ok: true });
    await flush();
    await tick(0);

    assert.deepEqual(await done, { ok: true });
    assert.deepEqual(rendered, [{ ok: true }]);
    assert.equal(el.dataset.load, undefined);
    assert.equal(el.attrs["aria-busy"], undefined);
  });

  it("shows them after the delay and holds them the minimum", async () => {
    const el = region();
    const { request, answer } = held();
    let rendered = false;

    whileLoading(el, request, { render: () => { rendered = true; } });
    await tick(SHOW_AFTER_MS);
    assert.equal(el.dataset.load, "shown");

    answer({ ok: true });
    await tick(HOLD_MS - 100);
    assert.equal(rendered, false);
    assert.equal(el.dataset.load, "shown");

    await tick(100);
    assert.equal(rendered, true);
    assert.equal(el.dataset.load, undefined);
  });

  it("fails on an error, and Try again runs the retry", async () => {
    const el = region();
    let retried = 0;
    const result = await whileLoading(el, () => Promise.reject(new Error()), {
      retry: () => { retried += 1; },
    });

    assert.equal(result, null);
    assert.equal(el.dataset.load, "failed");
    assert.equal(el.attrs["aria-busy"], undefined);
    el.link.onclick({ preventDefault() {} });
    assert.equal(retried, 1);
  });

  it("fails on an answer it refuses", async () => {
    const el = region();

    assert.equal(await whileLoading(el, async () => ({ ok: false })), null);
    assert.equal(el.dataset.load, "failed");
  });

  it("gives up after the limit, and a late answer still lands", async () => {
    const el = region();
    const { request, answer } = held();
    let rendered = null;
    const done = whileLoading(el, request, {
      render: (r) => { rendered = r; },
    });

    await tick(GIVE_UP_MS);
    assert.equal(await done, null);
    assert.equal(el.dataset.load, "failed");

    answer({ ok: true, late: true });
    await flush();
    await tick(HOLD_MS);
    assert.deepEqual(rendered, { ok: true, late: true });
    assert.equal(el.dataset.load, undefined);
  });

  it("drops an answer a retry has overtaken", async () => {
    const el = region();
    const first = held();
    const second = held();
    const rendered = [];
    const render = (r) => rendered.push(r);

    whileLoading(el, first.request, { render });
    await tick(GIVE_UP_MS);
    whileLoading(el, second.request, { render });
    first.answer({ ok: true, n: 1 });
    await flush();
    await tick(HOLD_MS);
    assert.deepEqual(rendered, []);
    assert.equal(el.dataset.load, "shown");

    second.answer({ ok: true, n: 2 });
    await flush();
    await tick(HOLD_MS);
    assert.deepEqual(rendered, [{ ok: true, n: 2 }]);
  });
});
