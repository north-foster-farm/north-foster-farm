// Criteria tests for #872, phase 6 of the split of order/pay.js
// (docs/refactors/pay.md, "Phase 6: loading and the root"): `start`,
// `load` and `init` move to pay/loader.js, as `Loader`. One test per
// box of the issue's "Done when" list marked (test), each named for
// its box, written before the move.
//
// Pending until pay/loader.js exists: while it is missing each test
// runs as a todo, so it shows as failing without failing npm test, and
// the pre-commit hook still runs. Once the file is there they are
// ordinary tests, with nothing to rename.
//
// Provisional: the constructor. Phases 3 to 5 (Card, Wallets, Venmo)
// had not landed when this was written, so the shape of the parts the
// loader starts was not settled. The test agent chose this one, and
// build() below is the one place it is written:
//
//   new Loader({ root, section, checkout, square, paypal })
//
//   root      the section (#payment): the skeleton's #pay-card-panel
//             is found in it
//   section   pay/section.js's Section, here a stand-in that keeps
//             the state it was last given (setState)
//   checkout  the port pay.js builds from the form, here with ready()
//   square    async (config.square) -> whether the card attached;
//             Square's half, card and wallets, run by the parts
//   paypal    async (config.paypal) -> whether the Venmo button is a
//             way to pay
//
// The implementer may change build() to fit the real constructor.
// The expectations stay as written: the state the section is given,
// what reaches the reporter (window.nffReport, through report.js),
// the config request and the scripts appended, and checkout.ready().

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

const LOADER = new URL("../assets/scripts/order/pay/loader.js",
  import.meta.url);
const todo = existsSync(LOADER)
  ? false
  : "pay/loader.js is not built yet (#872)";

const SQUARE = { sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
  applicationId: "sandbox-sq0idb-x", locationId: "L1" };
const PAYPAL = { sdkUrl: "https://www.paypal.com/sdk/js?client-id=x",
  hidden: false };

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

// The least of an element the loader and the skeleton touch.
const element = () => ({
  nodeType: 1,
  dataset: {},
  hidden: false,
  setAttribute() {},
  removeAttribute() {},
  toggleAttribute() {},
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
});

// A processor's setup the test settles by hand.
const pending = () => {
  const job = { calls: [] };

  job.run = (cfg) => {
    job.calls.push(cfg);

    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
  };

  return job;
};

describe("pay/loader.js Loader", () => {
  const saved = {};
  let reports;
  let scripts;
  let asked;
  let config;

  beforeEach(() => {
    saved.window = globalThis.window;
    saved.document = globalThis.document;
    saved.fetch = globalThis.fetch;
    reports = [];
    scripts = [];
    asked = [];
    config = { ok: true, status: 200, body: {} };

    const report = (kind, detail) => { reports.push({ kind, ...detail }); };

    report.crumb = () => {};
    report.sdk = () => {};
    globalThis.window = { nffReport: report, addEventListener() {} };
    globalThis.document = {
      head: { appendChild: (s) => { scripts.push(s); } },
      createElement: () => element(),
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
    };
    globalThis.fetch = async (url, options) => {
      asked.push({ url: String(url), options });

      return { ok: config.ok, status: config.status,
        json: async () => config.body };
    };
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
  });

  const build = async ({ square = pending(), paypal = pending() } = {}) => {
    const { Loader } = await import(LOADER);
    const panel = element();
    const root = element();

    root.querySelector = (sel) => (sel === "#pay-card-panel" ? panel : null);

    const section = {
      state: "loading",
      states: [],
      setState(state) {
        this.state = state;
        this.states.push(state);
      },
    };
    const checkout = { readies: 0, ready() { this.readies += 1; } };
    const loader = new Loader({
      root, section, checkout, square: square.run, paypal: paypal.run,
    });

    return { loader, section, checkout, square, paypal };
  };

  const unavailable = () => reports
    .filter((r) => r.kind === "payment.unavailable")
    .map((r) => r.where);

  it("A config that says off sets the state off and loads nothing",
    { todo }, async () => {
      config.body = { off: true, square: SQUARE, paypal: PAYPAL };

      const { loader, section, checkout, square, paypal } = await build();

      await loader.load();
      assert.equal(asked.length, 1, "the config is asked for");
      assert.match(asked[0].url, /\/api\/checkout\/config$/);
      assert.equal(section.state, "off");
      assert.equal(square.calls.length, 0, "Square is not started");
      assert.equal(paypal.calls.length, 0, "PayPal is not started");
      assert.equal(scripts.length, 0, "no script is appended");
      assert.equal(checkout.readies, 0);
      assert.deepEqual(unavailable(), [], "off is not a failure");
    });

  it("A config with neither processor reports `checkout.config` and is "
    + "unavailable", { todo }, async () => {
    for (const answer of [
      { ok: true, status: 200, body: {} },
      { ok: false, status: 500, body: {} },
    ]) {
      config = answer;
      reports.length = 0;
      scripts.length = 0;

      const { loader, section, checkout, square, paypal } = await build();

      await loader.load();
      assert.deepEqual(unavailable(), ["checkout.config"],
        `HTTP ${answer.status}`);
      assert.equal(section.state, "unavailable", `HTTP ${answer.status}`);
      assert.equal(square.calls.length + paypal.calls.length, 0);
      assert.equal(scripts.length, 0);
      assert.equal(checkout.readies, 0);
    }
  });

  it("Both SDKs failing reports `sdks.gone` and is unavailable",
    { todo }, async () => {
      config.body = { square: SQUARE, paypal: PAYPAL };

      const { loader, section, checkout, square, paypal } = await build();
      const loading = loader.load();

      await flush();
      assert.deepEqual(square.calls, [SQUARE], "Square gets its config");
      assert.deepEqual(paypal.calls, [PAYPAL], "PayPal gets its config");
      square.resolve(false);
      paypal.resolve(false);
      await loading;
      assert.deepEqual(unavailable(), ["sdks.gone"]);
      assert.equal(section.state, "unavailable");
      assert.equal(checkout.readies, 0);
    });

  it("No answer in 20 s reports `checkout.init` and is unavailable, and "
    + "a late success still takes over", { todo }, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    config.body = { square: SQUARE, paypal: PAYPAL };

    const { loader, section, checkout, square, paypal } = await build();

    loader.load();
    await flush();
    assert.equal(square.calls.length, 1);
    mock.timers.tick(19_999);
    await flush();
    assert.deepEqual(unavailable(), [], "nothing before 20 s");
    assert.equal(section.state, "loading");

    mock.timers.tick(1);
    await flush();
    assert.deepEqual(unavailable(), ["checkout.init"]);
    assert.equal(section.state, "unavailable");
    assert.equal(checkout.readies, 0);

    // The SDKs answer at last: the card attached, Venmo did not.
    square.resolve(true);
    paypal.resolve(false);
    await flush();
    await flush();
    assert.equal(section.state, "ready", "the late success takes over");
    assert.equal(checkout.readies, 1);
    assert.deepEqual(unavailable(), ["checkout.init"], "reported once");
  });

  it("A second call of `load` returns the first one's promise",
    { todo }, async () => {
      config.body = { square: SQUARE, paypal: PAYPAL };

      const { loader, square, paypal } = await build();
      const first = loader.load();
      const second = loader.load();

      assert.equal(second, first, "the same promise, not a copy");
      await flush();
      square.resolve(true);
      paypal.resolve(true);
      await first;
      assert.equal(loader.load(), first, "and after it settled");
      assert.equal(asked.length, 1, "the config is asked for once");
      assert.equal(square.calls.length, 1, "Square is started once");
      assert.equal(paypal.calls.length, 1, "PayPal is started once");
    });
});
