// Criteria tests for #908 (Order page: follow stock within seconds
// while a customer is browsing), one per tested box, named for it,
// with the clock faked. Written to James's rules of 2026-11-23
// ("Decided" on the issue), which replace the 15-second timer: the
// customer's interaction drives the check, a background check runs
// once a minute while the page is active, every trigger shares one
// 15-second floor, checking stops after 5 minutes with no input, the
// limit is 240 in ten minutes, the check before paying is outside it,
// and /api/stock is cached at Netlify's edge for 15 seconds.
//
// The boxes a browser has to show are e2e/stock-follow.criteria.mjs:
// adding, changing a quantity and opening the cart each check; the
// prominent notice; search and the order page agreeing; search
// checking on focus; search reading the page's /api/stock. Box 9
// (search and the page share one reader) is tested here at the reader
// too, as the coordinator asked.
//
// Provisional:
// - "input" is what the page treats as activity: pointerdown, keydown,
//   touchstart and scroll, on the document or the window (this fake
//   sends each to both, as a real event bubbles);
// - "a household with several tabs" is TABS = 5 order pages from one
//   address at the busiest rhythm the rules allow, one check every 15
//   seconds each, plus a return to each tab;
// - the edge cache may be set by any header Netlify's edge honors:
//   Netlify-CDN-Cache-Control or CDN-Cache-Control with max-age or
//   s-maxage 15, or Cache-Control with s-maxage 15 (edgeSeconds);
// - "The check right before paying gets a fresh answer" is the
//   coordinator's reading on the issue, not James's words: that
//   check's answer is not cached at the edge, and its request is one
//   the edge cannot answer with the page's cached one (another
//   address, or a header the cached answer varies on).
//
// Held out of npm test by its name until the change lands: renamed to
// stock-follow.test.mjs.
//
// The seam, what the tests rely on: the order page's Stock class
// (assets/scripts/order/stock.js) as the page builds it, with start();
// it asks with fetch(url, init) for "/api/stock", reads
// document.visibilityState, and hears "visibilitychange", "online" and
// the input events above. The order page tells it of an interaction
// (adding, a quantity changed, the cart opened) with stock.nudge(), and
// search on the order page reads through stock.read(), which resolves
// with the items. refresh({ final: true }) is the check before paying.
// A row is an `.order-item` holding a `[data-qty]` input. The
// function's handle() takes a Request, `now`, `ip` and `env`; a check
// before paying is the page's own final request, replayed into it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { Stock } from "../assets/scripts/order/stock.js";
import { element as region, stockRow } from "./stock-page.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";

const MINUTE = 60_000;
const FLOOR = 15_000;
const IDLE = 5 * MINUTE;
const WINDOW = 10 * MINUTE;
const LIMIT = 240;
const TABS = 5;
const INPUTS = ["pointerdown", "keydown", "touchstart", "scroll"];
const PRODUCTION = { CONTEXT: "production" };
const ORIGIN = "https://www.northfosterfarm.com";

const EGGS = "NFF-CHK-EGG-LG";
const NAME = "Eggs, Grade A · Large";
const IN = { [EGGS]: { inStock: true, available: 12 } };
const OUT = { [EGGS]: { inStock: false, available: 0 } };

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

// How long Netlify's edge may keep an answer, by the headers it
// honors; 0 when it may not.
const edgeSeconds = (headers) => {
  const age = (value, keys) => {
    if (!value || /no-store|private/i.test(value)) return 0;

    for (const key of keys) {
      const m = value.match(new RegExp(`(?:^|[,\\s])${key}=(\\d+)`, "i"));

      if (m) return Number(m[1]);
    }

    return 0;
  };

  return Math.max(
    age(headers.get("netlify-cdn-cache-control"), ["s-maxage", "max-age"]),
    age(headers.get("cdn-cache-control"), ["s-maxage", "max-age"]),
    age(headers.get("cache-control"), ["s-maxage"]),
  );
};

// A page's fetch, as the function receives it.
const requestOf = ({ url, init = {} }) => new Request(
  new URL(String(url), ORIGIN),
  { method: init.method || "GET", headers: init.headers },
);

describe("the order page follows stock (#908)", () => {
  const saved = {};
  let listeners;
  let answers;
  let calls;
  let stock;
  let opened;

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
    stock = new Stock(stockRow({ sku: EGGS, qty }).form, {
      onChange() {}, nameOf: () => NAME, inStockOnly: () => false,
    });
    stock.start();
    await flush();
    answer(items);
    await stock.loading;
    await flush();
    opened = Date.now();
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

  // The page's regular request, and its check before paying, each as a
  // maker of fresh Requests.
  const regular = () => requestOf(calls[0]);
  const finalAsk = async () => {
    const before = calls.length;
    const done = stock.refresh({ final: true });

    await flush();
    assert.equal(calls.length, before + 1, "the check before paying asks");

    const made = calls.at(-1);

    answer(IN);
    await done;

    return () => requestOf(made);
  };

  beforeEach(() => {
    const catalog = region();
    const on = (type, fn) => { (listeners[type] ||= []).push(fn); };

    saved.document = globalThis.document;
    saved.window = globalThis.window;
    saved.fetch = globalThis.fetch;
    listeners = {};
    globalThis.document = {
      visibilityState: "visible",
      getElementById: (id) => (id === "order-catalog" ? catalog : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: on,
    };
    globalThis.window = { addEventListener: on };
    answers = [];
    calls = [];
    globalThis.fetch = (url, init) => {
      assert.match(String(url), /\/api\/stock(\?|$)/);
      calls.push({ url, init, at: Date.now() });

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

  it("While the page is active, a background check runs once a minute",
    async () => {
      await open(0, IN);

      const before = calls.length;

      await pass(4 * MINUTE + 1000, IN);

      const times = calls.slice(before).map((c) => c.at - opened);

      assert.equal(times.length, 4, `four in four minutes: ${times}`);
      times.forEach((t, i) => {
        assert.ok(Math.abs(t - (i + 1) * MINUTE) <= 1000,
          `check ${i + 1} at ${t / 1000} s`);
      });
    });

  it("Every trigger shares one floor: interaction, the tab shown again, "
    + "back online and the background check together make at most one "
    + "check every 15 seconds", async () => {
    await open(0, IN);

    const triggers = [
      () => stock.nudge(),
      () => {
        document.visibilityState = "hidden";
        fire("visibilitychange");
        document.visibilityState = "visible";
        fire("visibilitychange");
      },
      () => fire("online"),
    ];

    for (let t = 0; t < 3 * MINUTE; t += 3000) {
      triggers[(t / 3000) % triggers.length]();
      await pass(3000, IN);
    }

    const times = calls.map((c) => c.at);

    assert.ok(times.length > 3, "the triggers still check");
    times.slice(1).forEach((t, i) => {
      assert.ok(t - times[i] >= FLOOR,
        `checks ${(t - times[i]) / 1000} s apart`);
    });
  });

  it("After 5 minutes with no input the page stops checking entirely; the "
    + "next input, or the tab shown again, checks at once", async () => {
    await open(0, IN);

    // Left alone past IDLE and a minute's slack, then watched.
    const quiet = async (when) => {
      await pass(IDLE + MINUTE, IN);

      const before = calls.length;

      await pass(3 * MINUTE, IN);
      assert.equal(calls.length, before, `${when}: no check once idle`);
    };
    // `act` is the input; the check may come within it, or within a
    // second.
    const checks = async (how, act) => {
      const before = calls.length;

      act();
      await pass(1000, IN);
      assert.equal(calls.length, before + 1, `${how}: checks at once`);
    };

    for (const type of INPUTS) {
      await quiet(`before ${type}`);
      await checks(type, () => fire(type));
    }
    await quiet("before the tab is hidden");
    document.visibilityState = "hidden";
    fire("visibilitychange");
    await pass(1000, IN);
    await checks("shown again", () => {
      document.visibilityState = "visible";
      fire("visibilitychange");
    });
  });

  it("A hidden tab does not ask; it asks at once when it is shown again",
    async () => {
      await open(0, IN);
      document.visibilityState = "hidden";
      fire("visibilitychange");
      await pass(1000, IN);

      const before = calls.length;

      await pass(WINDOW, IN);
      assert.equal(calls.length, before, "no ask while hidden");

      document.visibilityState = "visible";
      fire("visibilitychange");
      await flush();
      assert.equal(calls.length, before + 1, "one ask the moment it shows");
    });

  it("On the order page, search and the page share one stock reader and "
    + "its 15-second floor: search uses the page's answer when the page "
    + "checked in the last 15 seconds, and asks otherwise; search has no "
    + "polling of its own", async () => {
    await open(0, IN);

    const loaded = calls.length;

    await pass(5000, IN);
    assert.deepEqual(await stock.read(), IN, "the page's answer");
    assert.equal(calls.length, loaded, "inside 15 s: no ask");

    await pass(FLOOR, IN);

    const reading = stock.read();

    await flush();
    assert.equal(calls.length, loaded + 1, "past 15 s: one ask");
    answer(OUT);
    assert.deepEqual(await reading, OUT, "the new answer");

    // From here only the page's own background check asks: at most two
    // in the next two minutes.
    const after = calls.length;

    await pass(2 * MINUTE - 1000, IN);
    assert.ok(calls.length - after <= 2,
      `${calls.length - after} asks in two minutes`);
  });

  it("The check right before paying does not count against that limit "
    + "and is never refused by it", async () => {
    await open(0, IN);

    const final = await finalAsk();
    const start = Date.parse("2026-11-23T15:00:00Z");
    const ask = (request, t, ip) => handle(request, {
      stores: testStores(), env: PRODUCTION, ip, now: new Date(start + t),
      inventory: async () => null,
    });
    const full = "198.51.100.31";
    const spent = "198.51.100.32";

    // Never refused: with the limit used up, it still answers.
    for (let i = 0; i < LIMIT; i++) await ask(regular(), i * 1000, full);
    assert.equal((await ask(regular(), LIMIT * 1000, full)).status, 429,
      "the limit is reached");
    assert.equal((await ask(final(), LIMIT * 1000 + 1, full)).status, 200,
      "the check before paying answers");

    // Not counted: after fifty of them the whole limit is still there.
    for (let i = 0; i < 50; i++) {
      assert.equal((await ask(final(), i * 1000, spent)).status, 200);
    }
    for (let i = 0; i < LIMIT; i++) {
      assert.equal((await ask(regular(), MINUTE + i * 1000, spent)).status,
        200, `regular check ${i + 1}`);
    }
  });

  it("The check right before paying gets a fresh answer, not the edge's "
    + "cached one", async () => {
    await open(0, IN);

    const final = await finalAsk();
    const ask = (request) => handle(request, {
      stores: testStores(), env: PRODUCTION, ip: "198.51.100.33",
      inventory: async () => null,
    });
    const plain = await ask(regular());
    const fresh = await ask(final());
    const a = regular();
    const b = final();
    const vary = (plain.headers.get("vary") || "").split(",")
      .map((h) => h.trim().toLowerCase()).filter(Boolean);

    assert.equal(edgeSeconds(fresh.headers), 0, "its answer is not cached");
    assert.ok(a.url !== b.url
      || vary.some((h) => a.headers.get(h) !== b.headers.get(h)),
    "the edge cannot answer it with the page's cached one");
  });
});

describe("/api/stock's limit and cache (#908)", () => {
  const ask = (t, ip, start) => handle(new Request(`${ORIGIN}/api/stock`), {
    stores: testStores(), env: PRODUCTION, ip, now: new Date(start + t),
    inventory: async () => null,
  });

  it("The limit on /api/stock is 240 per ten minutes, and a household "
    + "with several tabs open is not refused", async () => {
    const start = Date.parse("2026-11-23T16:00:00Z");
    const times = [];

    // Each tab loads a second apart, then checks every FLOOR, and is
    // returned to once, mid-window.
    for (let tab = 0; tab < TABS; tab++) {
      for (let t = tab * 1000; t < WINDOW; t += FLOOR) times.push(t);
      times.push(WINDOW / 2 + tab * 1000 + 500);
    }
    times.sort((a, b) => a - b);

    const refused = [];

    for (const t of times) {
      if ((await ask(t, "198.51.100.23", start)).status !== 200) {
        refused.push(t);
      }
    }
    assert.deepEqual(refused, [],
      `${times.length} asks from ${TABS} tabs, none refused`);

    // The limit itself: 240 answered in ten minutes, the next refused.
    for (let i = 0; i < LIMIT; i++) {
      assert.equal((await ask(i * 1000, "198.51.100.24", start)).status,
        200, `ask ${i + 1}`);
    }
    assert.equal((await ask(LIMIT * 1000, "198.51.100.24", start)).status,
      429, `ask ${LIMIT + 1} is refused`);
  });

  it("/api/stock answers with headers that cache it at Netlify's edge "
    + "for 15 seconds", async () => {
    const res = await ask(0, "198.51.100.25", Date.now());

    assert.equal(res.status, 200);
    assert.equal(edgeSeconds(res.headers), 15,
      "kept at the edge for 15 s");
  });
});
