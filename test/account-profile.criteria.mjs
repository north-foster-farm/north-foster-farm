// Criteria tests for #838, phase 6 of the split of account/main.js
// (docs/refactors/account.md, "Phase 6: the head, the address, the
// settings"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/account-profile.criteria.mjs test/account-profile.test.mjs
//
// All eight criteria are of the new-module kind: they fail on `next`,
// where account/lib/profile.mjs does not exist, and pass once the
// phase draws the head's, address's and settings' decisions out.
// Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments or what they return; these are the test agent's
// choice; the call shape and keys may be adapted, the expected values
// may not). The words are today's, byte for byte.
//
//   emailParts(email)
//     -> the address in pieces, [[...the name's], [...the domain's]]
//        (one list when there is no @): a break goes before every
//        piece but the first, so before the @ and before each dot
//   creditLine({ member, credit })        -> "Credit: $N", or nothing
//   addressStatus(address)                -> { text, tone }, or nothing
//   addressReady(values), profileReady(values)  -> boolean
//   profileValues(customer, { browserAutoplay, reminders })
//     reminders  the reminder boxes' names
//     -> { autoplay, reminders: { name: ticked }, ... }
//   groupLine(customer, discountGroups)   -> the line, or nothing
//   profileBody(values)                   -> the PATCH's body

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  addressReady, addressStatus, creditLine, emailParts, groupLine,
  profileBody, profileReady, profileValues,
} from "../assets/scripts/account/lib/profile.mjs";
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import { assertPure } from "./pure-module.mjs";

const nothing = (x) => [null, undefined, ""].includes(x);
const pieces = (parts) => parts.flat().join("|");

// Box 1 of #838.
describe("emailParts", () => {
  it("splits the address at its last @ and marks a break before the @ and "
    + "before each dot", () => {
    assert.deepEqual(emailParts("ada@example.com"),
      [["ada"], ["@example", ".com"]]);
    assert.equal(pieces(emailParts("ada.hen@mail.example.co.uk")),
      "ada|.hen|@mail|.example|.co|.uk");
    assert.equal(pieces(emailParts("\"a@b\"@example.com")),
      "\"a@b\"|@example|.com", "the last @");
    assert.deepEqual(emailParts("nohost"), [["nohost"]]);
  });
});

// Box 2 of #838.
describe("creditLine", () => {
  it("shows a member's credit, at zero too, and without a group shows "
    + "credit only above zero", () => {
    assert.equal(creditLine({ member: { credit: 1500 }, credit: 0 }),
      `Credit: ${dollars(1500)}`);
    assert.equal(creditLine({ member: { credit: 0 }, credit: 0 }),
      `Credit: ${dollars(0)}`);
    assert.equal(creditLine({ member: null, credit: 300 }),
      `Credit: ${dollars(300)}`);
    assert.ok(nothing(creditLine({ member: null, credit: 0 })));
  });
});

// Box 3 of #838.
describe("addressStatus", () => {
  it("gives the words and tone for approved, pending and denied, and "
    + "nothing for an address with no status", () => {
    assert.deepEqual(addressStatus({ status: "approved" }),
      { text: "Approved for delivery.", tone: "ok" });
    assert.deepEqual(addressStatus({ status: "pending" }), {
      text: "This address is outside our usual area. We're checking "
        + "whether we can deliver here and will email you.", tone: "wait",
    });
    assert.deepEqual(addressStatus({ status: "denied" }), {
      text: "We can't deliver to this address. On-farm pickup and our "
        + "pick-up days are open to everyone.", tone: "no",
    });
    assert.ok(nothing(addressStatus({ address1: "1 Main St" })));
    assert.ok(nothing(addressStatus(null)));
  });
});

// Box 4 of #838.
describe("addressReady and profileReady", () => {
  it("want a street, a town and five digits of ZIP, and both names", () => {
    const at = { address1: "1 Main St", town: "Foster", zip: "02825" };

    assert.equal(addressReady(at), true);
    assert.equal(addressReady({ ...at, zip: "02825-1234" }), false,
      "nine digits");
    assert.equal(addressReady({ ...at, zip: "0282" }), false);
    assert.equal(addressReady({ ...at, zip: "02 825" }), true);
    assert.equal(addressReady({ ...at, address1: "  " }), false);
    assert.equal(addressReady({ ...at, town: "" }), false);

    assert.equal(profileReady({ firstName: "Ada", lastName: "Hen" }), true);
    assert.equal(profileReady({ firstName: "Ada", lastName: " " }), false);
    assert.equal(profileReady({ firstName: "", lastName: "Hen" }), false);
  });
});

const REMINDERS = ["delivery", "pickup"];
const values = (customer, browserAutoplay = true) => profileValues(
  { email: "ada@example.com", ...customer },
  { browserAutoplay, reminders: REMINDERS }
);

// Box 5 of #838.
describe("profileValues, the videos box", () => {
  it("ticks the videos box by the account's choice, or by the browser's "
    + "where the account has made none", () => {
    assert.equal(values({ autoplay: "on" }, false).autoplay, true);
    assert.equal(values({ autoplay: "off" }, true).autoplay, false);
    assert.equal(values({}, true).autoplay, true);
    assert.equal(values({}, false).autoplay, false);
  });
});

// Box 6 of #838.
describe("profileValues, reminders", () => {
  it("ticks a reminder unless the account turned it off", () => {
    assert.deepEqual(values({}).reminders, { delivery: true, pickup: true });
    assert.deepEqual(values({ reminders: { delivery: false } }).reminders,
      { delivery: false, pickup: true });
    assert.deepEqual(values({ reminders: { pickup: true } }).reminders,
      { delivery: true, pickup: true });
  });
});

// Box 7 of #838.
describe("groupLine", () => {
  it("names the discount group and its percent", () => {
    const groups = terms.money.discountGroups;
    const [key, group] = Object.entries(groups)[0];

    assert.equal(groupLine({ discountGroup: key }, groups), `${group.label}: `
      + `${group.percent}% off, whenever that beats the bulk discount.`);
    assert.ok(nothing(groupLine({ discountGroup: null }, groups)));
    assert.ok(nothing(groupLine({ discountGroup: "none-such" }, groups)));
  });
});

// Box 8 of #838.
describe("profileBody", () => {
  it("carries the names, the phone, the news choice and each reminder",
    () => {
      assert.deepEqual(profileBody({
        firstName: "Ada", lastName: "Hen", phone: "4015550100",
        marketing: true, reminders: { delivery: false, pickup: true },
        autoplay: true, avatar: "hen-brown",
      }), {
        firstName: "Ada", lastName: "Hen", phone: "4015550100",
        marketing: true, reminders: { delivery: false, pickup: true },
      });
    });
});

describe("design, section 2", () => {
  it("keeps account/lib/profile.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/profile.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element", "matchMedia", "localStorage"] });
  });
});
