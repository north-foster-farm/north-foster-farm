// Criteria tests for #824, phase 10 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 10: codes"), held out of `npm
// test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/codes.criteria.mjs test/codes.test.mjs
//
// All ten criteria are of the new-module kind: they fail on `next`,
// where form/codes.mjs, form/hash.mjs and the transitions do not
// exist, and pass once the phase draws them out. Nothing retires.
//
// Contract (the design names the functions and their modules, not
// their arguments; these are the test agent's choice; the call shape
// and key names may be adapted, the expected values may not). The
// words are today's, byte for byte. The state record is #819's
// (form/order-state.mjs): code, pass, passFee, member, groupCode,
// roundGroup, credit, ownCredit, editing.
//
//   passCode(value)                       form/codes.mjs -> or null
//   joinAsks({ answer, code, confirmed }) form/codes.mjs
//     answer     /api/group's: { group, already, elsewhere }
//     confirmed  the normalized codes said Join to
//   codeWords(result)                     form/codes.mjs
//     result  { kind: "discount", off } | { kind: "group", already,
//             elsewhere } | { kind: "pass", waivesFee, minimum } |
//             { kind: "refused", message, quiet }
//     ->      the words, or nothing (null, undefined or "")
//   codeCleared(state)                    form/order-state.mjs
//   groupUnlocked(state, answer, code)    form/order-state.mjs
//   groupDropped(state)                   form/order-state.mjs
//   sha256(text)                          form/hash.mjs -> hex, async

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  codeWords, joinAsks, passCode,
} from "../assets/scripts/order/form/codes.mjs";
import { sha256 } from "../assets/scripts/order/form/hash.mjs";
import {
  codeCleared, groupDropped, groupUnlocked, initialState,
} from "../assets/scripts/order/form/order-state.mjs";

const nothing = (words) => [null, undefined, ""].includes(words);
const GROUP = { name: "The gym", series: "36TS", location: "NR9D" };

// Box 1 of #824.
describe("passCode", () => {
  it("strips what is not a letter or digit, upper-cases, and returns "
    + "XXXX-XXXX for exactly eight characters, else null", () => {
    assert.equal(passCode("abcd1234"), "ABCD-1234");
    assert.equal(passCode("ABCD-1234"), "ABCD-1234");
    assert.equal(passCode(" ab cd 12 34 "), "ABCD-1234");
    assert.equal(passCode("ab.cd/12_34"), "ABCD-1234");
    assert.equal(passCode("abcd123"), null, "seven");
    assert.equal(passCode("abcd12345"), null, "nine");
    assert.equal(passCode(""), null);
    assert.equal(passCode(null), null);
  });
});

// Box 2 of #824.
describe("joinAsks", () => {
  it("is true only for a group found by a code the customer has not said "
    + "Join to, who is neither in it nor in another", () => {
    const found = { group: GROUP, already: false, elsewhere: false };
    const none = new Set();

    assert.equal(joinAsks({ answer: found, code: "pond22", confirmed: none }),
      true);
    assert.equal(joinAsks({ answer: found, code: "pond22",
      confirmed: new Set(["POND22"]) }), false, "said Join to");
    assert.equal(joinAsks({ answer: { ...found, already: true },
      code: "pond22", confirmed: none }), false, "in it");
    assert.equal(joinAsks({ answer: { ...found, elsewhere: true },
      code: "pond22", confirmed: none }), false, "in another");
    assert.equal(joinAsks({ answer: { group: null }, code: "pond22",
      confirmed: none }), false, "not found");
    assert.equal(joinAsks({ answer: found, code: null, confirmed: none }),
      false, "no code: a member signed in");
  });
});

// Box 3 of #824.
describe("codeWords, a discount", () => {
  it("is \"Code applied: $N off.\"", () => {
    assert.equal(codeWords({ kind: "discount", off: 10 }),
      "Code applied: $10 off.");
    assert.equal(codeWords({ kind: "discount", off: 5 }),
      "Code applied: $5 off.");
  });
});

// Box 4 of #824.
describe("codeWords, a group", () => {
  it("is the welcome, \"You're already in the group.\" for a member, and "
    + "the stays-in-your-own-group line for a member of another", () => {
    assert.equal(codeWords({ kind: "group", already: false,
      elsewhere: false }), "Code applied. Welcome to the group!");
    assert.equal(codeWords({ kind: "group", already: true,
      elsewhere: false }), "You're already in the group.");
    assert.equal(codeWords({ kind: "group", already: false,
      elsewhere: true }),
    "Code applied to this order. You stay in your own group.");
  });
});

// Box 5 of #824.
describe("codeWords, a pass", () => {
  it("is \"Applied.\" for a pass that waives the fee, and names the day's "
    + "minimum for one that does not", () => {
    assert.equal(codeWords({ kind: "pass", waivesFee: true, minimum: 40 }),
      "Applied.");
    for (const minimum of [40, 50]) {
      assert.equal(codeWords({ kind: "pass", waivesFee: false, minimum }),
        "Applied: this order can be delivered under the "
        + `$${minimum} minimum.`);
    }
  });
});

// Box 6 of #824.
describe("codeWords, a refusal", () => {
  it("says \"That code isn't valid.\" unless the server sent its own "
    + "words, and nothing when it was applied quietly", () => {
    assert.equal(codeWords({ kind: "refused", message: null, quiet: false }),
      "That code isn't valid.");
    assert.equal(codeWords({ kind: "refused", message: "Too many tries. "
      + "Please wait a few minutes.", quiet: false }),
    "Too many tries. Please wait a few minutes.");
    assert.ok(nothing(codeWords({ kind: "refused", message: null,
      quiet: true })));
    assert.ok(nothing(codeWords({ kind: "refused", message: "Words",
      quiet: true })));
  });
});

const holding = {
  ...initialState(), code: { code: "TEN", off: 10 }, pass: "ABCD-1234",
  passFee: true,
};

// Box 7 of #824.
describe("codeCleared", () => {
  it("takes the code off, and the pass too unless an order is being "
    + "changed", () => {
    const fresh = codeCleared(holding);

    assert.equal(fresh.code, null);
    assert.equal(fresh.pass, null);
    assert.equal(fresh.passFee, false);

    const editing = { id: "NFF-1", held: 1400, kept: 0 };
    const changing = codeCleared({ ...holding, editing });

    assert.equal(changing.code, null);
    assert.equal(changing.pass, "ABCD-1234");
    assert.equal(changing.passFee, true);
    assert.equal(holding.code.code, "TEN", "the old record is as it was");
  });
});

// Box 8 of #824.
describe("groupUnlocked", () => {
  it("sets the member, the code and the credit", () => {
    const s = groupUnlocked(initialState(),
      { group: GROUP, credit: 1200 }, "POND22");

    assert.deepEqual(s.member, GROUP);
    assert.equal(s.groupCode, "POND22");
    assert.equal(s.credit, 1200);

    const signedIn = groupUnlocked(initialState(), { group: GROUP }, null);

    assert.equal(signedIn.groupCode, null);
    assert.equal(signedIn.credit, 0);
  });
});

// Box 9 of #824.
describe("groupDropped", () => {
  it("clears the member, the rounds' group and the code, and puts the "
    + "account's own credit back", () => {
    const s = groupDropped({
      ...initialState(), member: GROUP, roundGroup: GROUP,
      groupCode: "POND22", credit: 1200, ownCredit: 300,
    });

    assert.equal(s.member, null);
    assert.equal(s.roundGroup, null);
    assert.equal(s.groupCode, null);
    assert.equal(s.credit, 300);
    assert.equal(groupDropped({ ...initialState(), member: GROUP,
      credit: 1200 }).credit, 0);
  });
});

// Box 10 of #824.
describe("sha256", () => {
  it("gives a known string's known digest in hex", async () => {
    assert.equal(await sha256("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(await sha256(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
