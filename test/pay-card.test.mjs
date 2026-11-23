// Criteria tests for #869, phase 3 of the split of order/pay.js
// (docs/refactors/pay.md, "Phase 3: the card"), written before the
// implementation, one per box of the issue's "Done when" list marked
// (test), each named for its box. Held out of npm test by its name
// until the implementer renames it to pay-card.test.mjs.
//
// `Card` is driven with a stand-in for Square's payments object and
// its card, as test/stock-ready.test.mjs drives `Stock`, and with
// plain stand-ins for the `Section` (phase 2) and the `checkout` port.
//
// Provisional: the design names the part's methods (attach, the field
// events, complete, tokenize) but not how it is built. These tests
// write to this reading of it:
// - `new Card({ root, section, checkout })`, the section's root, the
//   `Section` and the `checkout` object `Payment` builds;
// - `await card.attach(payments)`, with the object Square.payments()
//   returned; it calls payments.card() and attaches the card;
// - `await card.tokenize(payload)` -> { method, sourceId }, or throws
//   with a message for the customer, as tokenizeCard does today;
// - `await card.complete()` -> whether the section needs nothing more,
//   as complete does today.
// `tokenMessage` is read from pay/words.mjs, where phase 1 (#867)
// puts it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { WHERES } from "../assets/scripts/report/fields.mjs";

const ORDER = new URL("../assets/scripts/order/", import.meta.url);
const PAY_DIR = new URL("pay/", ORDER);

// Imported in each test, so the file loads before the module exists.
const load = async () => (await import(new URL("card.js", PAY_DIR))).Card;
const words = async () => import(new URL("words.mjs", PAY_DIR));

// The least of a DOM: any element the part asks for, which records
// its listeners.
const element = () => {
  const listeners = {};

  return {
    nodeType: 1,
    dataset: { cardOpen: "true", payState: "loading" },
    hidden: false,
    listeners,
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
  };
};

const rootOf = (state) => {
  const found = {};

  return {
    ...element(),
    querySelector: (selector) => {
      if (selector === "[data-pay]") return state;

      return (found[selector] ||= element());
    },
  };
};

// The Section of phase 2, as far as the card reaches it.
const sectionOf = (state) => {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };

  return {
    calls,
    covered: false,
    busy: false,
    state,
    setCardAvailable: record("setCardAvailable"),
    setCardOpen: (open) => {
      calls.push(["setCardOpen", open]);
      state.dataset.cardOpen = String(open);
    },
    setState: record("setState"),
    showWallets: record("showWallets"),
    fail: record("fail"),
    clearError: record("clearError"),
    setBusy: record("setBusy"),
  };
};

const BILLING = {
  firstName: "Pat", lastName: "Lee", email: "pat@example.com",
  phone: "4015550100", address1: "", address2: "", town: "", state: "",
  zip: "",
};

const checkoutOf = () => ({
  amount: () => 1234,
  label: () => "North Foster Farm",
  billing: () => BILLING,
  prepare: () => ({}),
  prepareAsync: async () => ({}),
  pay: async () => {},
  referenceId: () => "ref",
  venmoCreate: async () => "id",
  venmoCapture: async () => ({}),
  stockLocked: () => false,
  ready() {},
});

// Square's card: attach() as given, tokenize() answers `token`, and
// the field events go to whatever listens.
const squareCard = ({ attach = async () => {}, token } = {}) => {
  const listeners = {};

  return {
    listeners,
    attach,
    tokenize: async () => token,
    focus: async () => {},
    destroy: async () => {},
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
  };
};

const paymentsOf = (card) => ({ card: async () => card });

// A field of Square's card form says how it stands (CardInputEvent).
const word = (card, field, valid) => {
  const currentState = { isCompletelyValid: valid };
  const event = { detail: { field, currentState } };

  for (const fn of card.listeners.focusClassRemoved || []) fn(event);
};

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("order/pay/card.js (#869)", () => {
  const saved = {};
  let reports;
  let state;
  let parts;

  beforeEach(() => {
    saved.window = globalThis.window;
    saved.document = globalThis.document;
    reports = [];

    const nffReport = (kind, detail) => { reports.push({ kind, ...detail }); };

    nffReport.crumb = () => {};
    nffReport.sdk = () => {};
    globalThis.window = { nffReport, addEventListener() {} };
    globalThis.document = { getElementById: () => element() };
    mock.method(console, "error", () => {});
    state = element();
    parts = {
      root: rootOf(state), section: sectionOf(state), checkout: checkoutOf(),
    };
  });

  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  it("A card that fails to attach is reported as card.attach, and the " +
    "section goes on without the card", async () => {
    const Card = await load();
    const card = new Card(parts);
    const failure = new Error("The frame would not attach.");

    await assert.doesNotReject(card.attach(paymentsOf(squareCard({
      attach: async () => { throw failure; },
    }))), "the section goes on");

    assert.deepEqual(
      reports.filter((r) => r.where === "card.attach")
        .map((r) => [r.kind, r.error]),
      [["error", failure]],
      "reported once, as card.attach"
    );
    assert.ok(parts.section.calls.some(([name, on]) =>
      name === "setCardAvailable" && on === false), "the card is set aside");
    assert.equal(await card.complete(), false, "no card to complete");
    await assert.rejects(card.tokenize({}),
      { message: "Card payments aren't available right now." },
      "no card to pay with");
  });

  it("tokenize with no card throws \"Card payments aren't available " +
    "right now.\"", async () => {
    const Card = await load();
    const card = new Card(parts);

    await assert.rejects(card.tokenize({}), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Card payments aren't available right now.");

      return true;
    });
  });

  it("A token that is not OK throws tokenMessage's words", async () => {
    const Card = await load();
    const { tokenMessage } = await words();
    const results = [
      {
        status: "Invalid",
        errors: [{ field: "postalCode", type: "VALIDATION_ERROR",
          message: "Postal code is invalid." }],
      },
      {
        status: "Invalid",
        errors: [{ field: "cvv", type: "VALIDATION_ERROR",
          message: "CVV is invalid." }],
      },
      { status: "Unknown", errors: [] },
    ];

    assert.equal(tokenMessage(results[0]), "Check the ZIP code and try again.",
      "the words, byte for byte");
    for (const token of results) {
      const card = new Card(parts);

      await card.attach(paymentsOf(squareCard({ token })));
      await assert.rejects(card.tokenize({}),
        { message: tokenMessage(token) }, token.status);
    }
  });

  it("complete waits 200 ms for the last field's word before it answers " +
    "no", async () => {
    const Card = await load();
    const square = squareCard();
    const card = new Card(parts);

    await card.attach(paymentsOf(square));
    for (const field of ["cardNumber", "expirationDate", "cvv"]) {
      word(square, field, true);
    }
    mock.timers.enable({ apis: ["setTimeout"] });

    let answer;
    const silent = card.complete().then((yes) => { answer = yes; });

    await settle();
    mock.timers.tick(199);
    await settle();
    assert.equal(answer, undefined, "still waiting at 199 ms");
    mock.timers.tick(1);
    await settle();
    await silent;
    assert.equal(answer, false, "no word in 200 ms: no");

    answer = undefined;
    const late = card.complete().then((yes) => { answer = yes; });

    await settle();
    mock.timers.tick(100);
    word(square, "postalCode", true);
    mock.timers.tick(100);
    await settle();
    await late;
    assert.equal(answer, true, "the word came inside the wait: yes");
  });

  it("test/report.test.mjs reads pay.js and every file in order/pay/ for " +
    "the places reported from, and still finds at least eleven, each on " +
    "the allowlist", () => {
    const files = [new URL("pay.js", ORDER), ...readdirSync(PAY_DIR)
      .filter((name) => /\.m?js$/.test(name))
      .map((name) => new URL(name, PAY_DIR))];
    const source = files.map((url) => readFileSync(url, "utf8")).join("\n");
    const used = [...source.matchAll(
      /report(?:Error|Unavailable)\("([^"]+)"/g)].map((m) => m[1]);

    assert.ok(files.length > 1, "order/pay/ holds the moved parts");
    assert.ok(used.length >= 11, `${used.length} places`);
    for (const where of used) assert.ok(WHERES.includes(where), where);

    const test = readFileSync(new URL("report.test.mjs", import.meta.url),
      "utf8");

    assert.match(test, /readdirSync/, "report.test.mjs lists order/pay/");
    assert.match(test, /["'`][^"'`]*\bpay\/["'`]/,
      "report.test.mjs reads order/pay/");
  });
});
