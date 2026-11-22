// Criteria tests for #839, phase 7 of the split of account/main.js
// (docs/refactors/account.md, "Phase 7: email change, deletion,
// help"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/delete-check.criteria.mjs test/delete-check.test.mjs
//
// All three criteria are of the new-module kind: they fail on `next`,
// where account/lib/arrivals.mjs does not exist, and pass once the
// phase draws deleteDetails' check out. Nothing retires.
//
// Contract (the design names `deleteCheck` in account/lib/arrivals.mjs,
// not its arguments; these are the test agent's choice; the call shape
// may be adapted, the expected values may not). The words are today's,
// byte for byte.
//
//   deleteCheck(typed, mine)
//     typed  the field's value; mine  the account's address
//     ->     the words that refuse it, or nothing when it passes

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deleteCheck } from "../assets/scripts/account/lib/arrivals.mjs";

const MINE = "Ada.Hen@Example.com";
const nothing = (x) => [null, undefined, ""].includes(x);

// Box 1 of #839.
describe("deleteCheck, nothing typed", () => {
  it("asks for the email address", () => {
    for (const typed of ["", "   "]) {
      assert.equal(deleteCheck(typed, MINE), "Enter your email address.");
    }
  });
});

// Box 2 of #839.
describe("deleteCheck, another address", () => {
  it("says it is not this account's", () => {
    for (const typed of ["someone@example.com", "ada.hen@example.org"]) {
      assert.equal(deleteCheck(typed, MINE),
        "That isn't the email address on this account.", typed);
    }
  });
});

// Box 3 of #839.
describe("deleteCheck, the account's own", () => {
  it("passes the account's own address, whatever its case and the spaces "
    + "around it", () => {
    for (const typed of [MINE, "ada.hen@example.com", "  ADA.HEN@EXAMPLE.COM ",
      "\tAda.Hen@Example.com\n"]) {
      assert.ok(nothing(deleteCheck(typed, MINE)), JSON.stringify(typed));
    }
    assert.ok(
      nothing(deleteCheck("ada.hen@example.com", " ADA.hen@example.COM")),
      "the account's own, too"
    );
  });
});
