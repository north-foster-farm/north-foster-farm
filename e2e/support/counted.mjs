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
import {
  challengeError, checkResponse, takeChallenges,
} from "./challenge.mjs";
import {
  maskSessions, requestError, retryLine, transportFailure,
} from "./request-error.mjs";
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
  // Playwright's Route.fetch goes to the context's request straight,
  // past the wrapper in watchRequests, and its error prints the
  // browser's own headers, the cookie among them (#665).
  route.fetch = async (options = {}) => {
    const url = options.url || route.request().url();

    countCall(url, BASE_URL, spec);
    try {
      return await fetch.call(route, options);
    } catch (error) {
      throw requestError(
        options.method || route.request().method(), url, error
      );
    }
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

// Whether a URL is the site's own: only its responses set a session.
const ORIGIN = new URL(BASE_URL).origin;

const ownSite = (url) => {
  try {
    return new URL(url, BASE_URL).origin === ORIGIN;
  } catch {
    return false;
  }
};

// Masks the session cookies `holder` has now (request-error.mjs).
// `list` answers its cookies. Never fails a test: the mask is the
// second guard, behind errors that hold no header.
const maskHeld = async (holder, list) => {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  try {
    maskSessions(holder, await list());
  } catch {
    // A context already closed has nothing left to print.
  }
};

// A GET or HEAD that fails at the transport (a reset, a hang-up: no
// HTTP answer) is sent again, up to RETRIES times, a little longer
// apart each time, and each retry prints a line (#681). A request that
// got an answer, a 500 among them, is never sent again, nor is any
// other method: a POST may have done its work before the line dropped.
const RETRIED = ["GET", "HEAD"];
const RETRIES = 2;
const PAUSE_MS = 250;

const pause = (ms) => new Promise((done) => {
  setTimeout(done, ms);
});

export const watchRequests = (api, spec) => {
  if (watched.has(api)) return api;
  watched.add(api);

  const { fetch } = api;

  // Its get(), post() and the rest call this.fetch.
  api.fetch = async (urlOrRequest, options) => {
    const url = typeof urlOrRequest === "string"
      ? urlOrRequest : urlOrRequest.url();
    const method = String((options && options.method)
      || (typeof urlOrRequest === "string"
        ? "GET" : urlOrRequest.method())).toUpperCase();
    let res;

    // Once, however many times it is sent.
    countCall(url, BASE_URL, spec);
    for (let retry = 0; !res; retry += 1) {
      try {
        res = await fetch.call(api, urlOrRequest, options);
      } catch (error) {
        if (retry < RETRIES && RETRIED.includes(method)
          && transportFailure(error)) {
          console.warn(retryLine(method, url, error, retry + 1, RETRIES));
          await pause(PAUSE_MS * (retry + 1));
          continue;
        }
        // Playwright's error prints the request's headers (#665).
        throw requestError(method, url, error);
      }
    }

    // Before the response is handed back, so before anything can
    // print a cookie it set.
    if (ownSite(url)) {
      await maskHeld(api, async () => (await api.storageState()).cookies);
    }
    await checkResponse(res.status(), url, () => res.text());

    return res;
  };

  return api;
};

const watchPage = (page, spec) => watchRoutes(page, spec);

const contexts = new WeakSet();

export const watchContext = (context, spec = specNow()) => {
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
  context.on("response", (res) => checkResponse(
    res.status(), res.url(), () => res.text()
  ));
  // A sign-in's response sets the session, and the context holds it.
  context.on("response", (res) => {
    if (ownSite(res.url())) maskHeld(context, () => context.cookies());
  });
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
  // A test that met Netlify's bot challenge fails naming it, whatever
  // else went wrong (challenge.mjs).
  // Playwright's fixture form.
  // eslint-disable-next-line no-empty-pattern -- #791 c7105461370
  netlifyChallenge: [async ({}, use) => {
    takeChallenges();
    await use();

    const urls = takeChallenges();

    if (urls.length) {
      throw challengeError(
        `${urls.length} request(s), first ${new URL(urls[0]).pathname}`,
        403
      );
    }
  }, { auto: true }],
});
