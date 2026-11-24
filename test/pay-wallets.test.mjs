// Criteria tests for #870, phase 4 of the split of order/pay.js
// (docs/refactors/pay.md, "Phase 4: the wallets"), written by the test
// agent before the implementation, one test per box marked (test),
// each named for its box. Held out of `npm test` as
// pay-wallets.criteria.mjs until the implementer renames it to
// pay-wallets.test.mjs, a pure rename.
//
// `Wallets` (assets/scripts/order/pay/wallets.js) is driven as
// test/stock-ready.test.mjs drives `Stock`: with stand-ins for Square's
// payments object and its three wallets, for the section and for the
// checkout port, and with window.nffReport catching what report.js
// sends. Nothing here loads an SDK.
//
// Provisional: the design names the part and what it does, not how it
// is built, so the shape below is the test agent's proposal, written
// from section 2 of the design ("Section is the one writer of the
// section's DOM state and holds its two flags"; "checkout is the
// form, narrowed"; "card.attach(), wallets.attach(), venmo.attach()"):
//
//   const wallets = new Wallets({ root, section, checkout });
//   await wallets.attach(payments);  // the request and the 3 wallets
//   wallets.setAmount(cents);
//
// It is built the way phase 3's criteria test builds `Card` (#869,
// test/pay-card.criteria.mjs on lane/cloud-869), so the parts match.
// What it is given:
//
//   root     the payment section's root; the buttons are found in it
//             by [data-apple-pay], [data-google-pay], [data-cash-app-pay]
//   section   { busy, setBusy(on), fail(message), clearError(),
//             showWallets() }
//   checkout  { amount(), label(), prepare(), pay(payload, source),
//             referenceId() }
//   payments  Square's payments object: paymentRequest(), applePay(),
//             googlePay(), cashAppPay()
//
// The expected words are today's, byte for byte, from pay.js's
// tokenMessage and finishWallet.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// Imported in each test, so the file loads before the module exists
// and each box fails on its own.
const load = async () => (await import(
  "../assets/scripts/order/pay/wallets.js")).Wallets;

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

const PAYLOAD = { order: "the form's payload" };

// An element with listeners. A click on a container arrives from the
// SDK's own button inside it, so it runs the container's capture
// listeners, then the SDK's (its sheet), then the container's bubbling
// ones, and stopPropagation() ends it where it is. A click on an
// element of our own (Apple Pay's) is at its target, where every
// listener runs: there stopPropagation() stops no other listener.
const element = (name) => {
  const listeners = [];

  return {
    name,
    hidden: true,
    sdkButton: null,
    listeners,
    addEventListener(type, fn, options) {
      const capture = options === true || !!(options && options.capture);

      listeners.push({ type, fn, capture });
    },
    removeEventListener() {},
  };
};

const click = () => ({
  type: "click",
  stopped: false,
  defaultPrevented: false,
  stopPropagation() { this.stopped = true; },
  stopImmediatePropagation() { this.stopped = true; },
  preventDefault() { this.defaultPrevented = true; },
});

const run = (el, event, capture) => {
  for (const l of el.listeners) {
    if (l.type !== "click" || l.capture !== capture) continue;
    if (el.sdkButton && event.stopped) return;
    l.fn(event);
  }
};

const press = (el) => {
  const event = click();

  run(el, event, true);
  if (el.sdkButton && !event.stopped) el.sdkButton(event);
  if (!el.sdkButton || !event.stopped) run(el, event, false);

  return event;
};

// Square's payments object, with each wallet either offered or lacked.
const square = (log, { lack = [], token = { status: "OK", token: "tok" } }) => {
  const request = {
    updates: [],
    refuse: false,
    update(options) {
      this.updates.push(options);
      if (this.refuse) throw new Error("refused");

      return true;
    },
  };
  const wallet = (method) => ({
    method,
    sheets: 0,
    tokenize() {
      log.push(`${method}.tokenize`);
      this.sheets += 1;

      return Promise.resolve(token);
    },
    async attach(container) {
      // The SDK's own button. Cash App Pay's opens its sheet itself
      // and answers in ontokenization; Google Pay's sheet is tokenize().
      container.sdkButton = () => {
        if (method !== "cashapp") return;
        log.push(`${method}.sheet`);
        this.sheets += 1;
        this.emit({ tokenResult: token });
      };
    },
    handlers: [],
    addEventListener(type, fn) { this.handlers.push({ type, fn }); },
    emit(detail) {
      for (const h of this.handlers) {
        if (h.type === "ontokenization") h.fn({ detail });
      }
    },
  });
  const made = {
    applepay: wallet("applepay"),
    googlepay: wallet("googlepay"),
    cashapp: wallet("cashapp"),
  };
  const offer = (method) => async () => {
    if (lack.includes(method)) {
      throw new Error(`${method} is not supported in this browser`);
    }

    return made[method];
  };

  return {
    request,
    made,
    paymentRequest: () => request,
    applePay: offer("applepay"),
    googlePay: offer("googlepay"),
    cashAppPay: offer("cashapp"),
  };
};

describe("Wallets (#870)", () => {
  const saved = {};
  let log;
  let reports;
  let buttons;
  let section;
  let checkout;
  let valid;

  beforeEach(() => {
    log = [];
    reports = [];
    valid = true;
    saved.window = globalThis.window;
    saved.location = globalThis.location;

    const nffReport = (kind, detail) => { reports.push({ kind, ...detail }); };

    nffReport.crumb = () => {};
    nffReport.sdk = () => {};
    globalThis.window = { nffReport };
    globalThis.location = { href: "https://example.test/order/#payment",
      search: "" };

    fresh();
    section = {
      busy: false,
      failed: [],
      setBusy(on) { this.busy = on; },
      fail(message) { this.failed.push(message); },
      clearError() {},
      showWallets() {},
    };
    checkout = {
      paid: [],
      amount: () => 2500,
      label: () => "North Foster Farm",
      referenceId: () => "ref-1",
      prepare() {
        log.push("prepare");
        // Anything queued here runs only once the click's turn is over.
        queueMicrotask(() => { log.push("turn over"); });

        return valid ? PAYLOAD : null;
      },
      async pay(payload, source) { this.paid.push({ payload, source }); },
    };
  });

  afterEach(() => {
    globalThis.window = saved.window;
    globalThis.location = saved.location;
  });

  // A new section's buttons, as the page serves them: all hidden.
  function fresh() {
    buttons = {
      "[data-apple-pay]": element("applepay"),
      "[data-google-pay]": element("googlepay"),
      "[data-cash-app-pay]": element("cashapp"),
    };
  }

  const root = () => ({
    querySelector: (selector) => buttons[selector] || null,
    querySelectorAll: (selector) => (buttons[selector]
      ? [buttons[selector]] : []),
  });

  const attached = async (options = {}) => {
    const Wallets = await load();
    const payments = square(log, options);
    const wallets = new Wallets({ root: root(), section, checkout });

    await wallets.attach(payments);

    return { wallets, payments };
  };

  const WALLETS = [
    ["applepay", "[data-apple-pay]"],
    ["googlepay", "[data-google-pay]"],
    ["cashapp", "[data-cash-app-pay]"],
  ];

  it("Apple Pay calls prepare() and tokenize() in the click's own turn, " +
    "with nothing awaited between", async () => {
    await attached();

    press(buttons["[data-apple-pay]"]);
    assert.deepEqual(log, ["prepare", "applepay.tokenize"],
      "both ran in the click, prepare() first, before its turn was over");
    await flush();
    assert.equal(checkout.paid.length, 1, "and the payment went on");
    assert.deepEqual(checkout.paid[0], {
      payload: PAYLOAD, source: { method: "applepay", sourceId: "tok" },
    });
  });

  it("A press while the section is busy, or on a form that does not " +
    "validate, opens no sheet", async () => {
    const { payments } = await attached();

    for (const [method, selector] of WALLETS) {
      section.busy = true;
      valid = true;
      press(buttons[selector]);
      await flush();
      assert.equal(payments.made[method].sheets, 0, `${method}, busy`);

      section.busy = false;
      valid = false;
      press(buttons[selector]);
      await flush();
      assert.equal(payments.made[method].sheets, 0,
        `${method}, a form that does not validate`);
      assert.ok(log.includes("prepare"), `${method}: the form was asked`);
      log.length = 0;
    }
    assert.equal(checkout.paid.length, 0, "nothing was paid");

    // The guard is not a wall: a valid form, not busy, opens each.
    valid = true;
    for (const [method, selector] of WALLETS) {
      press(buttons[selector]);
      await flush();
      assert.ok(payments.made[method].sheets > 0, `${method} opens`);
    }
  });

  it("A canceled sheet says nothing and reports nothing", async () => {
    const { payments } = await attached({ token: { status: "Cancel" } });

    for (const [method, selector] of WALLETS) {
      press(buttons[selector]);
      await flush();
      assert.ok(payments.made[method].sheets > 0, `${method}'s sheet opened`);
    }
    assert.deepEqual(section.failed, [], "nothing said");
    assert.deepEqual(reports, [], "nothing reported");
    assert.equal(checkout.paid.length, 0, "nothing paid");
  });

  it("A token that is not OK reports the wallet and the status only, " +
    "never the SDK's message, and shows tokenMessage's words", async () => {
    const SECRET = "Card 4111 1111 1111 1111 declined";
    const cases = [
      // For an error in the ZIP code's field, tokenMessage names it.
      [{ status: "Invalid", errors: [{ field: "postalCode",
        message: SECRET }] }, "Check the ZIP code and try again."],
      // With no error at all, tokenMessage asks for the card's details.
      [{ status: "Error" }, "Check your card details and try again."],
    ];

    for (const [token, words] of cases) {
      reports.length = 0;
      section.failed.length = 0;
      fresh();

      await attached({ token });
      for (const [, selector] of WALLETS) {
        press(buttons[selector]);
        await flush();
      }

      assert.deepEqual(reports.map((r) => [r.kind, r.where, r.error]),
        WALLETS.map(([method]) => [
          "error", "wallet.tokenize", `${method}: ${token.status}`,
        ]), "the wallet and the status, under wallet.tokenize");
      for (const r of reports) {
        assert.equal(`${r.where} ${r.error} ${JSON.stringify(r)}`
          .includes("4111"), false, "never the SDK's message");
      }
      assert.deepEqual(section.failed, WALLETS.map(() => words));
      assert.equal(checkout.paid.length, 0, "nothing paid");
    }
  });

  it("A wallet the browser lacks leaves its button hidden", async () => {
    for (const [method] of WALLETS) {
      fresh();
      await attached({ lack: [method] });
      for (const [other, otherSelector] of WALLETS) {
        assert.equal(buttons[otherSelector].hidden, other === method,
          `${method} lacked: ${other} ${other === method ? "hidden" :
            "shown"}`);
      }
    }
  });

  it("setAmount updates the request, and a request that refuses the " +
    "update is left alone", async () => {
    const { wallets, payments } = await attached();
    const { request } = payments;

    wallets.setAmount(1234);
    assert.deepEqual(request.updates, [
      { total: { amount: "12.34", label: "North Foster Farm" } },
    ]);

    request.refuse = true;
    assert.doesNotThrow(() => wallets.setAmount(999));
    assert.equal(request.updates.length, 2, "asked once, not again");
    assert.deepEqual(section.failed, [], "nothing said");
    assert.deepEqual(reports, [], "nothing reported");
  });
});
