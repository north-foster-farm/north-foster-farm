// Each test's own stock counts (#507, James in #453 6458262765). No
// test depends on a stock count it didn't set itself: not the
// sandbox's, not production's, not whatever the store holds. A test
// that needs a count pins it here, for its own scope, and the pin is
// removed in teardown, which runs even when the test fails. The TTL
// (15 minutes) is the backstop for a run that dies, and the sweep
// (bin/e2e/sweep.mjs) removes what lapsed.
//
// The scope is one test's id, sent as the nff_stock_scope cookie on
// the deploy's host, beside the gate cookie, by its browser context
// and its request fixture. The deploy lays the scope's pins over every
// other source for those requests alone (netlify/functions/lib/
// stock-pins.mjs), so tests never see each other's, James's browsing
// never sees any, and parallel shards keep apart.
//
//   test.use({ stockPins: { [SKU.eggs]: 0 } })   a spec's own counts,
//                                                over the suite's
//   await stock.pin({ [sku]: 1 })                one test's, from then
//                                                on, over the rest
//
// Pins are the server's answer, so the page, /api/stock, the order
// check and the edit check all agree.

import { BASE_URL, op } from "./staging.mjs";
import { SCOPE_COOKIE } from "../../netlify/functions/lib/stock-pins.mjs";

export { SCOPE_COOKIE };

export const TTL_SECONDS = 15 * 60;

// A count high enough that no spec meets a cap or a low-stock line.
export const PLENTY = 99;

// -> a scope id for one test: unique per run, project, retry and test,
// in the cookie's charset, 64 characters at most.
export const scopeFor = (info) => [
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 8),
  info.project.name,
  info.testId,
  info.retry,
].join("-").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

// The scope cookie for the deploy's own host, as the gate cookie is
// set (playwright.config.mjs): never for another site the page calls.
export const scopeCookie = (scope, base = BASE_URL) => {
  const url = new URL(base);
  const secure = url.protocol === "https:";

  return {
    name: SCOPE_COOKIE, value: scope, domain: url.hostname, path: "/",
    httpOnly: true, secure, sameSite: "Lax", expires: -1,
  };
};

// Cookies kept from another test, with this test's scope in place of
// whatever scope they carried: for a context or request made by hand.
export const withScope = (cookies, scope, base = BASE_URL) => [
  ...(cookies || []).filter((c) => c.name !== SCOPE_COOKIE),
  scopeCookie(scope, base),
];

// One test's pins: `pin` lays counts over what the scope already pins
// and sends the whole set; `unpin` removes them all. -> the handle.
export const stockFor = (scope, { ops = op } = {}) => {
  let counts = {};

  return {
    scope,
    get counts() {
      return { ...counts };
    },
    pin: async (more, { ttlSeconds = TTL_SECONDS } = {}) => {
      counts = { ...counts, ...more };
      await ops("stock.pin", { scope, counts, ttlSeconds });
    },
    unpin: async () => {
      const had = Object.keys(counts).length > 0;

      counts = {};
      // Bounded: two tries of 15 s at most, then it fails with its
      // cause, well inside the test timeout. The pins' TTL and the
      // sweep are the backstop for one left behind.
      if (had) {
        await ops("stock.unpin", { scope }, { tries: 2, timeoutMs: 15_000 });
      }
    },
  };
};

// The fixtures, for a `test.extend`: the scope, its cookie on the
// browser context and the request fixture, and the pins, set before
// the test and removed after it whatever happened. `stockPins` is the
// spec's option: the counts every test of it starts with.
export const stockFixtures = {
  stockPins: [{}, { option: true }],
  // eslint-disable-next-line no-empty-pattern
  stockScope: async ({}, use, info) => {
    await use(scopeFor(info));
  },
  // Every test, so the pins are in place before its body runs. A
  // plain auto fixture never runs for a beforeAll or afterAll hook, so
  // the context and the request fixture ask for it too: a hook that
  // places an order with either has the spec's pins for that hook.
  stock: [async ({ stockScope, stockPins }, use) => {
    const handle = stockFor(stockScope);

    try {
      if (stockPins && Object.keys(stockPins).length) {
        await handle.pin(stockPins);
      }
      await use(handle);
    } finally {
      await handle.unpin();
    }
  }, { auto: true }],
  // The browser's context carries the scope, so every page of the test
  // does.
  // eslint-disable-next-line no-unused-vars
  context: async ({ context, stock, stockScope, baseURL }, use) => {
    await context.addCookies([scopeCookie(stockScope, baseURL)]);
    await use(context);
  },
  // The request fixture made again with the scope beside the gate
  // cookie, from the config's own storage state.
  request: async ({
    // eslint-disable-next-line no-unused-vars
    playwright, baseURL, storageState, stockScope, stock,
  }, use) => {
    const state = storageState && typeof storageState === "object"
      ? storageState : { cookies: [], origins: [] };
    const request = await playwright.request.newContext({
      baseURL,
      storageState: {
        cookies: withScope(state.cookies, stockScope, baseURL),
        origins: state.origins || [],
      },
    });

    await use(request);
    await request.dispose();
  },
};
