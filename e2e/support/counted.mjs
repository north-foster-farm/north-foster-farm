// Playwright's `test`, counting every function call a test makes
// (#519, e2e/support/calls.mjs). Every spec's `test` starts here,
// through e2e/support/order.mjs or directly.
//
// It watches what the test drives without adding a request or
// changing one:
//
//   browser contexts  the default one and any made by hand: every
//                     request their pages send that reaches the
//                     network, and every route.fetch(); a request a
//                     route fulfills or aborts never left the browser
//   request contexts  the request fixture, page.request and any made
//                     with playwright.request.newContext()
//   the back office   op() in e2e/support/staging.mjs, the stock pins
//                     among it, counts itself
//
// A context is charged to the spec it was made in, and a back-office
// call to the spec running when it was sent.

import { relative } from "node:path";

import { test as base, expect } from "@playwright/test";

import {
  NO_SPEC, countCall, setChargeTo, workerTally, writeWorker,
} from "./calls.mjs";
import { BASE_URL } from "./staging.mjs";

export { expect };

let lastSpec = NO_SPEC;

// The spec of the test or hook running now, else the last one.
const specNow = () => {
  try {
    lastSpec = relative(process.cwd(), base.info().file);
  } catch {
    // Between tests: the last spec is the one still tearing down.
  }

  return lastSpec;
};

setChargeTo(specNow);

const watched = new WeakSet();
// Requests a route answered or dropped itself: they reached no
// function.
const stubbed = new WeakSet();

const watchRoute = (route, spec) => {
  if (watched.has(route)) return route;
  watched.add(route);

  const { abort, fetch, fulfill } = route;

  route.fulfill = (...args) => {
    stubbed.add(route.request());

    return fulfill.apply(route, args);
  };
  route.abort = (...args) => {
    stubbed.add(route.request());

    return abort.apply(route, args);
  };
  route.fetch = (options = {}) => {
    countCall(options.url || route.request().url(), BASE_URL, spec);

    return fetch.call(route, options);
  };

  return route;
};

// A page's or a context's routes, each handler handed the watched
// route. unroute() finds a handler by the one the spec passed.
const watchRoutes = (target, spec) => {
  if (watched.has(target)) return target;
  watched.add(target);

  const { route, unroute } = target;
  const handlers = new WeakMap();

  target.route = (url, handler, options) => {
    const own = (r, request) => handler(watchRoute(r, spec), request);

    handlers.set(handler, own);

    return route.call(target, url, own, options);
  };
  target.unroute = (url, handler) => unroute.call(
    target, url, handler && (handlers.get(handler) || handler)
  );

  return target;
};

const watchRequests = (api, spec) => {
  if (watched.has(api)) return api;
  watched.add(api);

  const { fetch } = api;

  // Its get(), post() and the rest call this.fetch.
  api.fetch = (urlOrRequest, options) => {
    countCall(typeof urlOrRequest === "string"
      ? urlOrRequest : urlOrRequest.url(), BASE_URL, spec);

    return fetch.call(api, urlOrRequest, options);
  };

  return api;
};

const watchPage = (page, spec) => watchRoutes(page, spec);

const contexts = new WeakSet();

const watchContext = (context, spec = specNow()) => {
  if (contexts.has(context)) return context;
  contexts.add(context);

  const done = (request) => {
    if (!stubbed.has(request)) countCall(request.url(), BASE_URL, spec);
  };
  const { newPage } = context;

  watchRoutes(context, spec);
  watchRequests(context.request, spec);
  context.on("requestfinished", done);
  context.on("requestfailed", done);
  context.on("page", (page) => watchPage(page, spec));
  for (const page of context.pages()) watchPage(page, spec);
  context.newPage = async (...args) => watchPage(
    await newPage.apply(context, args), spec
  );

  return context;
};

// Swaps `name` on `owner` for `wrap(original)` and -> the undo.
const swap = (owner, name, wrap) => {
  const original = owner[name];

  owner[name] = wrap(original);

  return () => {
    owner[name] = original;
  };
};

export const test = base.extend({
  // For the whole worker, so contexts made in a beforeAll are watched
  // too, and its tally written when the worker stops.
  functionCalls: [async ({ playwright, browser }, use, info) => {
    const undo = [
      swap(playwright.request, "newContext", (newContext) => async (...a) =>
        watchRequests(await newContext.apply(playwright.request, a),
          specNow())),
      swap(browser, "newContext", (newContext) => async (...a) =>
        watchContext(await newContext.apply(browser, a))),
      swap(browser, "newPage", (newPage) => async (...a) => {
        const page = await newPage.apply(browser, a);

        watchContext(page.context());

        return page;
      }),
    ];

    await use(workerTally());

    for (const fn of undo) fn();
    writeWorker(workerTally(), `${info.workerIndex}-${process.pid}`);
  }, { scope: "worker", auto: true }],
});
