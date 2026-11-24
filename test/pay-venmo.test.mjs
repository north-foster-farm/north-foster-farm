// Criteria tests for #871, phase 5 of the split of order/pay.js
// (docs/refactors/pay.md, "Phase 5: Venmo"), written from the issue's
// "Done when" boxes marked (test), before the implementation: one test
// per box, named for it. Held out of the suite as
// pay-venmo.criteria.mjs until the implementer renames it to
// pay-venmo.test.mjs.
//
// Provisional: phases 1 to 4 had not landed when this was written, so
// the shape of the `Venmo` part is this file's, drawn from the design
// (section 2, "How state moves") and built as phase 3's criteria
// build `Card`. They have landed since (2026-11-23): the constructor
// and the port match `Card` and `Wallets` in pay/card.js and
// pay/wallets.js, and attach(cfg) and `button` are still this file's:
//
//   import { Venmo } from "../assets/scripts/order/pay/venmo.js";
//   const venmo = new Venmo({ root, section, checkout });
//   await venmo.attach(cfg);        // cfg: /api/checkout/config's paypal
//   venmo.button                    // the PayPal button when it is a way
//                                   // to pay, otherwise null
//
// - root: the payment section's root; its querySelector answers
//   [data-venmo-cell], [data-venmo] and [data-venmo-soon], and so does
//   the cell's, so either way of finding them works.
// - section: the part that owns the section's state (pay/section.js):
//   busy, fail(message), clearError(), setBusy(on), showWallets().
// - checkout: the form, narrowed: prepare(), prepareAsync(),
//   stockLocked(), venmoCreate(payload),
//   venmoCapture(payload, orderID, { restart }).
// `attached()` below is the one place the part is built and attached,
// so the implementer may fit it to the real constructor; the
// expectations stay as written.
//
// The tests drive the part through what it hands PayPal: the options
// object given to a stand-in for paypal.Buttons, whose six callbacks
// are run as PayPal runs them. That does not care whether each is a
// method of Venmo's, so the box about methods is the implementer's.
// The SDK's script loads through a stand-in document whose head fires
// onload, reports go to a stand-in window.nffReport, and the dark
// launch reads a stand-in localStorage and location.search, as
// venmoEnabled does today.
//
// The refusals are written out here byte for byte, not imported from
// pay/words.mjs, since the wording must not change (section 4).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { Venmo } from "../assets/scripts/order/pay/venmo.js";

const SDK_URL = "https://www.paypal.com/sdk/js?client-id=test";
const FAILED = "Venmo didn't go through. Try again, or pay another way.";
const STOCK_LOCKED = "Ordering isn't available right now.";
const CHECK_FORM = "Check the form and try again.";
const PAYLOAD = { customer: { firstName: "Pat" } };

const element = () => {
  const el = {
    hidden: true,
    inert: false,
    dataset: {},
    children: {},
    querySelector: (selector) => el.children[selector] || null,
    setAttribute() {},
    addEventListener() {},
  };

  return el;
};

// The payment section as far as Venmo reaches: the cell, the button's
// container and "Coming soon", reachable from the root or the cell.
const venmoDom = () => {
  const root = element();
  const cell = element();
  const container = element();
  const soon = element();
  const inner = {
    "[data-venmo]": container, "[data-venmo-soon]": soon,
  };

  Object.assign(cell.children, inner);
  Object.assign(root.children, inner, { "[data-venmo-cell]": cell });

  return { root, cell, container, soon };
};

const sectionStub = () => ({
  busy: false,
  fails: [],
  busied: [],
  fail(message) { this.fails.push(message); },
  clearError() {},
  setBusy(on) {
    this.busy = on;
    this.busied.push(on);
  },
  showWallets() {},
});

const checkoutStub = (over = {}) => ({
  prepared: 0,
  created: [],
  captured: [],
  prepare() {
    this.prepared += 1;

    return PAYLOAD;
  },
  prepareAsync: async () => PAYLOAD,
  stockLocked: () => false,
  async venmoCreate(payload) {
    this.created.push(payload);

    return "PPO-1";
  },
  async venmoCapture(payload, orderID, options) {
    this.captured.push({ payload, orderID, options });

    return { kind: "paid" };
  },
  ...over,
});

// PayPal's actions object, counting what the part asks of it.
const actionsStub = () => {
  const asked = { disable: 0, resolve: 0, reject: 0, restart: 0 };

  return {
    asked,
    disable() { asked.disable += 1; },
    enable() {},
    resolve: async () => { asked.resolve += 1; },
    reject: async () => { asked.reject += 1; },
    restart: async () => { asked.restart += 1; },
  };
};

describe("Venmo (pay/venmo.js)", () => {
  const saved = {};
  let paypal;
  let reports;
  let crumbs;
  let stored;

  beforeEach(() => {
    for (const name of ["window", "document", "location"]) {
      saved[name] = globalThis[name];
    }
    paypal = { eligible: true, options: null, rendered: [] };
    reports = [];
    crumbs = [];
    stored = {};

    const report = (kind, detail) => { reports.push({ kind, ...detail }); };

    report.crumb = (name) => { crumbs.push(name); };
    report.sdk = () => {};
    globalThis.window = {
      nffReport: report,
      localStorage: {
        getItem: (key) => (key in stored ? stored[key] : null),
        setItem: (key, value) => { stored[key] = String(value); },
        removeItem: (key) => { delete stored[key]; },
      },
      paypal: {
        FUNDING: { VENMO: "venmo" },
        Buttons: (options) => {
          paypal.options = options;

          return {
            isEligible: () => paypal.eligible,
            render: async (target) => { paypal.rendered.push(target); },
          };
        },
      },
    };
    globalThis.document = {
      createElement: () => ({}),
      head: {
        appendChild: (script) => {
          queueMicrotask(() => script.onload && script.onload());
        },
      },
      getElementById: () => null,
      querySelector: () => null,
    };
    globalThis.location = { search: "", href: "https://x/order/" };
    mock.method(console, "error", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    for (const [name, value] of Object.entries(saved)) {
      globalThis[name] = value;
    }
  });

  // A Venmo part attached with the config's dark-launch flag. The cell
  // and "Coming soon" start hidden, as payment.html has them; `shown`
  // starts the cell shown, so hiding it is something the part did.
  const attached = async ({ hidden = false, checkout, shown } = {}) => {
    const dom = venmoDom();
    const section = sectionStub();

    if (shown) dom.cell.hidden = false;
    const port = checkout || checkoutStub();
    const venmo = new Venmo({ root: dom.root, section, checkout: port });

    await venmo.attach({ sdkUrl: SDK_URL, hidden });
    assert.ok(paypal.options, "PayPal's button was asked for");

    return { ...dom, section, checkout: port, venmo, options: paypal.options };
  };

  const paypalErrors = () => reports.filter(
    (r) => r.kind === "error" && r.where === "paypal.error"
  );

  it("A locked button is inert, disabled at init, rejects a click, " +
    "and never counts as a way to pay", async () => {
    const { container, soon, venmo, options } = await attached({
      hidden: true,
    });
    const actions = actionsStub();

    assert.equal(container.inert, true, "inert");
    await options.onInit({}, actions);
    assert.equal(actions.asked.disable, 1, "disabled at init");
    await options.onClick({ fundingSource: "venmo" }, actions);
    assert.equal(actions.asked.reject, 1, "the click is rejected");
    assert.equal(actions.asked.resolve, 0);
    assert.equal(venmo.button ?? null, null, "not a way to pay");
    assert.equal(soon.hidden, false, "over Coming soon");

    // The same button unlocked, by ?venmo, is all of those things.
    globalThis.location.search = "?venmo";

    const open = await attached({ hidden: true });
    const more = actionsStub();

    assert.equal(open.container.inert, false);
    await open.options.onInit({}, more);
    assert.equal(more.asked.disable, 0);
    assert.ok(open.venmo.button, "a way to pay once unlocked");
    assert.equal(open.soon.hidden, true);
  });

  it("A click on a busy section, or on a form that does not validate, " +
    "is rejected", async () => {
    const busy = await attached();
    const first = actionsStub();

    busy.section.busy = true;
    await busy.options.onClick({ fundingSource: "venmo" }, first);
    assert.equal(first.asked.reject, 1, "busy: rejected");
    assert.equal(first.asked.resolve, 0);

    const invalid = await attached({
      checkout: checkoutStub({ prepare: () => null }),
    });
    const second = actionsStub();

    await invalid.options.onClick({ fundingSource: "venmo" }, second);
    assert.equal(second.asked.reject, 1, "invalid form: rejected");
    assert.equal(second.asked.resolve, 0);

    // Idle, with a form that validates: the click goes on.
    const valid = await attached();
    const third = actionsStub();

    await valid.options.onClick({ fundingSource: "venmo" }, third);
    assert.equal(third.asked.resolve, 1);
    assert.equal(third.asked.reject, 0);
    assert.equal(valid.checkout.prepared, 1, "the form was validated");
  });

  it("Creating the order with a form that does not prepare throws " +
    "venmoRefusal's words", async () => {
    const locked = await attached({
      checkout: checkoutStub({
        prepareAsync: async () => null, stockLocked: () => true,
      }),
    });

    await assert.rejects(locked.options.createOrder({}, actionsStub()),
      (error) => error.message === STOCK_LOCKED);
    assert.deepEqual(locked.checkout.created, [], "no PayPal order");

    const invalid = await attached({
      checkout: checkoutStub({ prepareAsync: async () => null }),
    });

    await assert.rejects(invalid.options.createOrder({}, actionsStub()),
      (error) => error.message === CHECK_FORM);
    assert.deepEqual(invalid.checkout.created, [], "no PayPal order");
  });

  it("An order found already paid stops PayPal with an error that " +
    "onError then keeps quiet about, once", async () => {
    const { section, options } = await attached({
      checkout: checkoutStub({ venmoCreate: async () => null }),
    });
    let stopped = null;

    await assert.rejects(
      Promise.resolve().then(() => options.createOrder({}, actionsStub())),
      (error) => {
        stopped = error;

        return error instanceof Error;
      },
      "PayPal is stopped"
    );
    options.onError(stopped);
    assert.deepEqual(paypalErrors(), [], "nothing reported");
    assert.deepEqual(section.fails, [], "nothing said");
    assert.equal(section.busy, false, "not left busy");

    // Once: the next error is a real one.
    options.onError(new Error("popup closed by the network"));
    assert.equal(paypalErrors().length, 1, "the next is reported");
    assert.deepEqual(section.fails, [FAILED]);
  });

  it("A first decline for the funding source restarts the sheet, " +
    "and a second does not", async () => {
    const checkout = checkoutStub({
      async venmoCapture(payload, orderID, opts) {
        this.captured.push({ payload, orderID, options: opts });

        return { kind: "declined", code: "INSTRUMENT_DECLINED" };
      },
    });
    const { section, options } = await attached({ checkout });
    const actions = actionsStub();

    assert.equal(await options.createOrder({}, actionsStub()), "PPO-1");
    await options.onApprove({ orderID: "PPO-1" }, actions);
    assert.equal(actions.asked.restart, 1, "the sheet opens again");
    await options.onApprove({ orderID: "PPO-1" }, actions);
    assert.equal(actions.asked.restart, 1, "not a second time");
    assert.deepEqual(checkout.captured.map((c) => c.orderID),
      ["PPO-1", "PPO-1"], "the same PayPal order");
    assert.deepEqual(checkout.captured.map((c) => c.options),
      [{ restart: false }, { restart: true }]);
    assert.deepEqual(checkout.captured.map((c) => c.payload),
      [PAYLOAD, PAYLOAD], "the payload createOrder prepared");
    assert.deepEqual(crumbs.filter((c) => c === "venmo.restart"),
      ["venmo.restart"]);
    assert.equal(section.busy, false, "not left busy");
  });

  it("Any other error reports paypal.error and tells the customer " +
    "to try again or pay another way", async () => {
    const { section, options } = await attached();
    const error = new Error("Window closed before response");

    section.setBusy(true);
    options.onError(error);

    const reported = paypalErrors();

    assert.equal(reported.length, 1);
    assert.equal(reported[0].error, error);
    assert.deepEqual(section.fails, [FAILED]);
    assert.equal(section.busy, false, "not left busy");
  });

  it("A button that is not eligible hides its cell", async () => {
    paypal.eligible = false;

    const { cell, venmo } = await attached({ shown: true });

    assert.equal(cell.hidden, true);
    assert.deepEqual(paypal.rendered, [], "never rendered");
    assert.equal(venmo.button ?? null, null, "not a way to pay");
  });
});
