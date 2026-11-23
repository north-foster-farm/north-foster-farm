// Criteria tests for #867, phase 1 of the split of order/pay.js
// (docs/refactors/pay.md, "Phase 1: words and decisions"), held out
// of `npm test` until the phase lands: the pre-commit hook runs the
// suite, and these fail on `next`, where order/pay/ does not exist.
//
// Turn it on, in the commit that moves the code:
//   git mv test/pay-decisions.criteria.mjs test/pay-decisions.test.mjs
//
// All fourteen criteria are of the new-module kind: they fail on
// `next` and pass once the phase draws the four modules out. Nothing
// retires.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice, plain data so
// that the modules stay pure; the call shape may be adapted, the
// expected values may not). The words are today's, byte for byte.
//
//   dollarsOf(cents)                                pay/words.mjs
//     -> "12.50"
//   tokenMessage(result)                            pay/words.mjs
//     result  Square's token result, or nothing: `errors[0]` has
//             `field` and `message`
//     ->      the words for the customer
//   venmoRefusal(locked)                            pay/words.mjs
//     locked  the stock gate is shut (the form's stock.locked)
//     ->      the words createOrder throws
//
//   endState({ card, venmo })                       pay/states.mjs
//     card, venmo  the attached card and the rendered, unlocked
//                  Venmo button, or null
//     ->           "ready", "venmo-only" or "unavailable"
//   submitHidden({ cardOpen, covered })             pay/states.mjs
//     ->      whether #order-submit is hidden
//   cardFieldOf(event)                              pay/states.mjs
//     event   a CardInputEvent: { detail: { field, currentState } },
//             or that detail as the event itself
//     ->      { field, valid } with `valid` a boolean, or null when
//             the event says nothing of a field
//   cardDone(fields)                                pay/states.mjs
//     fields  { [field]: boolean }, as cardFieldOf fills it
//     ->      boolean
//   sectionComplete({ amount, covered, card, cardOpen, done })
//                                                   pay/states.mjs
//     amount  the total in cents; card  there is a card; cardOpen
//     the card is chosen; done  cardDone, as the caller has it
//     ->      boolean
//
//   cardRequest(cents, billing)                     pay/requests.mjs
//     billing  the form's billing(payload)
//     ->       what card.tokenize() is given
//   billingContact(billing)                         pay/requests.mjs
//     ->       the verification's billingContact
//
//   clickAllowed({ locked, busy }, prepare)         pay/venmo-flow.mjs
//     prepare  the form's prepare(), called only when the button is
//              neither locked nor busy, as today, since it shows the
//              form's errors
//     ->       boolean
//   shouldRestart({ restarted, outcome, actions })  pay/venmo-flow.mjs
//     restarted  this sheet restarted already; outcome  the form's
//     venmoCapture answer; actions  onApprove's
//     ->         boolean
//
// What Square is given is compared as it crosses into the SDK's
// frame, through JSON, so a key left undefined and a key left out
// are the same. The test of purity comes from the design's module
// table (section 2: all four modules are listed as pure), not from a
// box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  billingContact, cardRequest,
} from "../assets/scripts/order/pay/requests.mjs";
import {
  cardDone, cardFieldOf, endState, sectionComplete, submitHidden,
} from "../assets/scripts/order/pay/states.mjs";
import {
  clickAllowed, shouldRestart,
} from "../assets/scripts/order/pay/venmo-flow.mjs";
import {
  dollarsOf, tokenMessage, venmoRefusal,
} from "../assets/scripts/order/pay/words.mjs";
import { validField } from "../assets/scripts/utils/field-errors.mjs";
import { assertPure } from "./pure-module.mjs";

const PAY = new URL("../assets/scripts/order/pay/", import.meta.url);

const GENERAL = "Check your card details and try again.";
const sent = (value) => JSON.parse(JSON.stringify(value));
const fail = (error) => ({ status: "Invalid", errors: [error] });
const without = (object, ...keys) => Object.fromEntries(
  Object.entries(object).filter(([key]) => !keys.includes(key))
);

const BILLING = {
  firstName: "Pat", lastName: "Doe", email: "pat@example.com",
  phone: "6175550123", address1: "1 Main St", address2: "Apt 2",
  town: "Foster", state: "RI", zip: "02825",
};
const CONTACT = {
  givenName: "Pat", familyName: "Doe", email: "pat@example.com",
  phone: "6175550123", countryCode: "US",
  addressLines: ["1 Main St", "Apt 2"], city: "Foster", state: "RI",
  postalCode: "02825",
};

// Box 1 of #867.
describe("dollarsOf", () => {
  it("writes cents as dollars with two decimals", () => {
    assert.equal(dollarsOf(1250), "12.50");
    assert.equal(dollarsOf(1999), "19.99");
    assert.equal(dollarsOf(5), "0.05");
    assert.equal(dollarsOf(0), "0.00");
    assert.equal(dollarsOf(100000), "1000.00");
  });
});

// Box 2 of #867.
describe("tokenMessage, no error", () => {
  it("asks the customer to check the card's details", () => {
    for (const result of [undefined, null, {}, { errors: [] }]) {
      assert.equal(tokenMessage(result), GENERAL, JSON.stringify(result));
    }
  });
});

// Box 3 of #867.
describe("tokenMessage, a field", () => {
  it("names the ZIP code, the expiration date or the security code for "
    + "an error in that field, and uses the field rule's words for the "
    + "card number", () => {
    assert.equal(tokenMessage(fail({ field: "postalCode" })),
      "Check the ZIP code and try again.");
    assert.equal(tokenMessage(fail({ field: "expirationDate" })),
      "Check the expiration date and try again.");
    assert.equal(tokenMessage(fail({ field: "cvv" })),
      "Check the security code and try again.");
    assert.equal(tokenMessage(fail({ field: "cardNumber" })),
      validField("card"));
  });
});

// Box 4 of #867.
describe("tokenMessage, any other error", () => {
  it("gives the SDK's message, or the general line where there is none",
    () => {
      assert.equal(tokenMessage(fail({
        type: "VALIDATION_ERROR", message: "The bank refused it.",
      })), "The bank refused it.");
      assert.equal(tokenMessage(fail({ type: "UNKNOWN" })), GENERAL);
      assert.equal(tokenMessage(fail({ type: "UNKNOWN", message: "" })),
        GENERAL);
    });
});

// Box 5 of #867.
describe("endState", () => {
  it("is ready with a card, Venmo only with Venmo alone, and unavailable "
    + "with neither", () => {
    const card = {};
    const venmo = {};

    assert.equal(endState({ card, venmo }), "ready");
    assert.equal(endState({ card, venmo: null }), "ready");
    assert.equal(endState({ card: null, venmo }), "venmo-only");
    assert.equal(endState({ card: null, venmo: null }), "unavailable");
  });
});

// Box 6 of #867.
describe("submitHidden", () => {
  it("hides the form's button when the card is not chosen, unless credit "
    + "covers the order", () => {
    assert.equal(submitHidden({ cardOpen: false, covered: false }), true);
    assert.equal(submitHidden({ cardOpen: true, covered: false }), false);
    assert.equal(submitHidden({ cardOpen: false, covered: true }), false);
    assert.equal(submitHidden({ cardOpen: true, covered: true }), false);
  });
});

// Box 7 of #867.
describe("cardFieldOf", () => {
  it("reads a field's name and whether it is completely valid from the "
    + "event's detail, or from the event itself", () => {
    const good = { field: "cvv", currentState: { isCompletelyValid: true } };
    const bad = { field: "postalCode", currentState: {} };

    assert.deepEqual(cardFieldOf({ detail: good }),
      { field: "cvv", valid: true });
    assert.deepEqual(cardFieldOf(good), { field: "cvv", valid: true });
    assert.deepEqual(cardFieldOf({ detail: bad }),
      { field: "postalCode", valid: false });
    for (const event of [undefined, null, {}, { detail: {} },
      { field: "cvv" }, { detail: { currentState: {} } }]) {
      assert.equal(cardFieldOf(event), null, JSON.stringify(event));
    }
  });
});

// Box 8 of #867.
describe("cardDone", () => {
  it("is true only when the number, the expiration date, the security "
    + "code and the ZIP code are all complete", () => {
    const all = {
      cardNumber: true, expirationDate: true, cvv: true, postalCode: true,
    };

    assert.equal(cardDone(all), true);
    assert.equal(cardDone({}), false);
    for (const field of Object.keys(all)) {
      assert.equal(cardDone({ ...all, [field]: false }), false, field);
      assert.equal(cardDone(without(all, field)), false, `${field} unknown`);
    }
  });
});

// Box 9 of #867.
describe("sectionComplete", () => {
  it("is true with nothing to charge or with credit covering the order, "
    + "false with no card or with the card not chosen, and otherwise "
    + "whether the card is done", () => {
    const state = (more) => ({
      amount: 2500, covered: false, card: true, cardOpen: true,
      done: false, ...more,
    });

    assert.equal(sectionComplete(state({ amount: 0, card: false })), true);
    assert.equal(sectionComplete(state({ covered: true, cardOpen: false })),
      true);
    assert.equal(sectionComplete(state({ card: false, done: true })), false);
    assert.equal(sectionComplete(state({ cardOpen: false, done: true })),
      false);
    assert.equal(sectionComplete(state({ done: true })), true);
    assert.equal(sectionComplete(state({ done: false })), false);
  });
});

// Box 10 of #867.
describe("cardRequest", () => {
  it("asks for a charge of the amount in dollars, by the customer, with "
    + "the billing contact", () => {
    assert.deepEqual(sent(cardRequest(4275, BILLING)), {
      amount: "42.75",
      currencyCode: "USD",
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: CONTACT,
    });
  });
});

// Box 11 of #867.
describe("billingContact", () => {
  it("carries the name, email and phone, and the address only when there "
    + "is a street, without a state it does not know", () => {
    const stateless = without(CONTACT, "state");
    const bare = without(stateless, "addressLines", "city", "postalCode");

    assert.deepEqual(sent(billingContact(BILLING)), CONTACT);
    assert.deepEqual(sent(billingContact({ ...BILLING, address1: "" })),
      bare);
    assert.deepEqual(sent(billingContact({ ...BILLING, address2: "" })),
      { ...CONTACT, addressLines: ["1 Main St"] });
    assert.deepEqual(sent(billingContact({ ...BILLING, state: "" })),
      stateless);
  });
});

// Box 12 of #867.
describe("clickAllowed", () => {
  it("is false for a locked button, a busy section or a form that did "
    + "not validate", () => {
    const calls = [];
    const prepare = (answer) => () => {
      calls.push(answer);

      return answer;
    };

    assert.equal(clickAllowed({ locked: true, busy: false },
      prepare({})), false);
    assert.equal(clickAllowed({ locked: false, busy: true },
      prepare({})), false);
    // A locked or busy press shows no form errors: prepare() not asked.
    assert.equal(calls.length, 0);
    assert.equal(clickAllowed({ locked: false, busy: false },
      prepare(null)), false);
    assert.equal(clickAllowed({ locked: false, busy: false },
      prepare({ items: [] })), true);
  });
});

// Box 13 of #867.
describe("shouldRestart", () => {
  it("is true only for a first capture that Venmo declined for the "
    + "funding source, when PayPal offers a restart", () => {
    const declined = { kind: "declined", code: "INSTRUMENT_DECLINED" };
    const actions = { restart: () => {} };
    const first = { restarted: false, outcome: declined, actions };

    assert.equal(shouldRestart(first), true);
    for (const [why, more] of [
      ["second capture", { restarted: true }],
      ["no outcome", { outcome: null }],
      ["paid", { outcome: { kind: "paid" } }],
      ["other decline", { outcome: { kind: "declined", code: "OTHER" } }],
      ["no actions", { actions: null }],
      ["no restart", { actions: {} }],
      ["restart not a function", { actions: { restart: true } }],
    ]) {
      assert.equal(shouldRestart({ ...first, ...more }), false, why);
    }
  });
});

// Box 14 of #867.
describe("venmoRefusal", () => {
  it("says ordering isn't available when stock is locked, and to check "
    + "the form otherwise", () => {
    assert.equal(venmoRefusal(true), "Ordering isn't available right now.");
    assert.equal(venmoRefusal(false), "Check the form and try again.");
  });
});

// The design's module table: all four are pure.
describe("the phase's modules", () => {
  it("are pure: no DOM, no storage, no network, no timers, no SDK", () => {
    const banned = [
      "window", "document", "location", "localStorage", "navigator",
      "fetch", "setTimeout", "clearTimeout", "Square", "paypal",
      "querySelector", "addEventListener", "crumb", "reportError",
      "reportUnavailable",
    ];

    for (const name of [
      "words.mjs", "states.mjs", "requests.mjs", "venmo-flow.mjs",
    ]) {
      assertPure(new URL(name, PAY), { banned });
    }
  });
});
