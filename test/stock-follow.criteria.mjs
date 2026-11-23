// Criteria tests for #908 (Order page: follow stock within seconds
// while a customer is browsing), one per tested box, named for it,
// with the clock faked. Box 1 is James's choice; box 6, search and the
// order page agreeing, needs search running in a page and is
// e2e/stock-follow.criteria.mjs.
//
// Provisional, as James has not yet picked among the issue's choices,
// written to its proposal:
// - the chosen time is 15 seconds (EVERY): a visible order page asks
//   /api/stock at least that often, the server's own floor (today
//   every two minutes);
// - "a household with several tabs" is TABS = 5 open order pages from
//   one address, each asking at that rhythm, plus a return to each tab,
//   over the limit's ten-minute window (today's limit, 120, allows
//   three);
// - what the customer is told is today's notice (lib/stock-notice.mjs):
//   the item's name and why.
//
// Held out of npm test by its name until the change lands: renamed to
// stock-follow.test.mjs.
//
// The seam, what the tests rely on: the order page's Stock class
// (assets/scripts/order/stock.js) as the page builds it, with start();
// it asks with fetch("/api/stock") and reads document.visibilityState,
// "visibilitychange" on document, setTimeout or setInterval. A row is
// an `.order-item` holding a `[data-qty]` input; out of stock marks it
// `data-out`. The function's handle() takes `now` and `ip`.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { Stock } from "../assets/scripts/order/stock.js";
import { element as region } from "./stock-page.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const EVERY = 15_000;
const TABS = 5;
const WINDOW = 10 * 60_000;

const EGGS = "NFF-CHK-EGG-LG";
const NAME = "Eggs, Grade A · Large";

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

// The least of an order page with one row: the eggs, `qty` in the cart.
const pageWith = (qty) => {
  const attrs = new Set();
  const note = { textContent: "" };
  const add = { disabled: false };
  const row = {
    dataset: {},
    hidden: false,
    hasAttribute: (name) => attrs.has(name),
    toggleAttribute: (name, on) => {
      if (on) attrs.add(name);
      else attrs.delete(name);
    },
    querySelector: (s) => (s === "label" ? { textContent: "Large" }
      : s === "[data-stock-note]" ? note : null),
    querySelectorAll: (s) => (s === "[data-step]" ? [add] : []),
  };
  const input = {
    dataset: { qty: EGGS }, value: String(qty), disabled: false,
    closest: () => row,
  };
  const form = {
    toggleAttribute() {},
    querySelector: () => null,
    querySelectorAll: (s) => (s === "[data-qty]" ? [input]
      : s === ".order-item" ? [row] : []),
  };

  return { form, row, input };
};

describe("the order page follows stock (#908)", () => {
  const saved = {};
  let listeners;
  let answers;
  let asked;
  let notices;
  let stock;
  let page;

  const answer = (items) => {
    const resolve = answers.shift();

    assert.ok(resolve, "the page asked");
    resolve({ ok: true, json: async () => ({ items }) });
  };

  const fire = (type) => {
    for (const fn of listeners[type] || []) fn(new Event(type));
  };

  // The page open and loaded, its first answer in.
  const open = async (qty, items) => {
    page = pageWith(qty);
    stock = new Stock(page.form, {
      onChange: (notice) => notices.push(notice),
      nameOf: () => NAME,
      inStockOnly: () => false,
    });
    stock.start();
    await flush();
    answer(items);
    await stock.loading;
    await flush();
  };

  // Moves the clock on by `ms`, a second at a time, answering every ask
  // with `items`.
  const pass = async (ms, items) => {
    for (let t = 0; t < ms; t += 1000) {
      mock.timers.tick(1000);
      await flush();
      while (answers.length) answer(items);
      await flush();
    }
  };

  beforeEach(() => {
    const catalog = region();

    saved.document = globalThis.document;
    saved.window = globalThis.window;
    saved.fetch = globalThis.fetch;
    listeners = {};
    globalThis.document = {
      visibilityState: "visible",
      getElementById: (id) => (id === "order-catalog" ? catalog : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => {
        (listeners[type] ||= []).push(fn);
      },
    };
    globalThis.window = { addEventListener() {} };
    answers = [];
    asked = 0;
    notices = [];
    globalThis.fetch = (url) => {
      assert.match(String(url), /\/api\/stock$/);
      asked += 1;

      return new Promise((resolve) => { answers.push(resolve); });
    };
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });

  // An ask still open gets its answer, and the page its turn to take
  // it, before the page goes.
  afterEach(async () => {
    while (answers.length) answer({});
    await flush();
    if (stock) {
      clearTimeout(stock.timer);
      clearInterval(stock.timer);
    }
    mock.timers.reset();
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  });

  it("With the order page open and visible, a change in an item's stock "
    + "shows on the page within the chosen time, without a reload",
  async () => {
    await open(0, { [EGGS]: { inStock: true, available: 12 } });
    assert.equal(page.row.hasAttribute("data-out"), false, "in stock");

    const before = asked;

    await pass(EVERY, { [EGGS]: { inStock: false, available: 0 } });
    assert.ok(asked > before, `asked again within ${EVERY / 1000} s`);
    assert.equal(page.row.hasAttribute("data-out"), true,
      "marked out on the page");
  });

  it("An item in the cart that sells out while the page is open is "
    + "taken out of the cart or cut to what is left within that time, "
    + "and the customer is told which item and why", async () => {
    await open(3, { [EGGS]: { inStock: true, available: 12 } });

    await pass(EVERY, { [EGGS]: { inStock: true, available: 1 } });
    assert.equal(page.input.value, "1", "cut to what is left");
    assert.equal(notices.length, 1, "told once");
    assert.match(notices[0], new RegExp(`${NAME}: only 1 left in stock`));

    await pass(EVERY, { [EGGS]: { inStock: false, available: 0 } });
    assert.equal(page.input.value, "0", "taken out of the cart");
    assert.equal(notices.length, 2, "told again");
    assert.match(notices[1], new RegExp(`${NAME}: out of stock`));
  });

  it("A hidden tab does not ask; it asks at once when it is shown again",
    async () => {
      await open(0, { [EGGS]: { inStock: true, available: 12 } });
      document.visibilityState = "hidden";
      fire("visibilitychange");
      await flush();
      while (answers.length) {
        answer({ [EGGS]: { inStock: true, available: 12 } });
      }

      const before = asked;

      await pass(WINDOW, { [EGGS]: { inStock: true, available: 12 } });
      assert.equal(asked, before, "no ask while hidden");

      document.visibilityState = "visible";
      fire("visibilitychange");
      await flush();
      assert.equal(asked, before + 1, "one ask the moment it shows");
    });
});

describe("the /api/stock limit fits the rhythm (#908)", () => {
  it("The rate limit on /api/stock fits the new rhythm: a household "
    + "with several tabs open is not refused", async () => {
    const env = { CONTEXT: "production" };
    const ip = "198.51.100.23";
    const start = Date.parse("2026-11-23T15:00:00Z");
    const times = [];

    // Each tab loads a second apart, then asks every EVERY ms, and is
    // returned to once, mid-window.
    for (let tab = 0; tab < TABS; tab++) {
      for (let t = tab * 1000; t < WINDOW; t += EVERY) times.push(t);
      times.push(WINDOW / 2 + tab * 1000 + 500);
    }
    times.sort((a, b) => a - b);

    const refused = [];

    for (const t of times) {
      const res = await handle(new Request("http://x/api/stock"), {
        stores: testStores(), env, ip, now: new Date(start + t),
        inventory: async () => null,
      });

      if (res.status !== 200) refused.push(t);
    }
    assert.deepEqual(refused, [],
      `${times.length} asks from ${TABS} tabs, none refused`);
  });
});
