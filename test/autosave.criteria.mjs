// Criteria tests for #837, phase 5 of the split of account/main.js
// (docs/refactors/account.md, "Phase 5: autosave"), held out of `npm
// test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/autosave.criteria.mjs test/autosave.test.mjs
//
// All four criteria are of the new-module kind: they fail on `next`,
// where account/lib/autosave.mjs does not exist, and pass once the
// phase draws the autosave's decisions out. Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice; the call shape
// may be adapted, the expected values may not):
//
//   snapshotOf(fields)
//     fields  [{ name, value, type, checked }], the form's inputs
//     ->      a value two snapshots are compared by (===)
//   shouldSave({ snapshot, last, ready })  -> boolean
//   failureText(reason)                    -> the save line's words
//   why(data)     data: the refused save's JSON  -> the reason

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  failureText, shouldSave, snapshotOf, why,
} from "../assets/scripts/account/lib/autosave.mjs";
import { assertPure } from "./pure-module.mjs";

const text = (name, value) => ({ name, value, type: "text", checked: false });
const box = (name, checked, type = "checkbox") => ({
  name, value: "on", type, checked,
});
const form = [text("firstName", "Ada"), text("phone", "4015550100"),
  box("marketing", true), box("avatar-hen", false, "radio")];

// Box 1 of #837.
describe("snapshotOf", () => {
  it("records each field's name and value, and for a box or radio whether "
    + "it is checked", () => {
    const same = snapshotOf(form.map((f) => ({ ...f })));

    assert.equal(snapshotOf(form), same);
    assert.notEqual(snapshotOf([text("firstName", "Adele"), ...form.slice(1)]),
      same, "a value");
    assert.notEqual(snapshotOf([text("first", "Ada"), ...form.slice(1)]),
      same, "a name");
    assert.notEqual(snapshotOf([...form.slice(0, 2), box("marketing", false),
      form[3]]), same, "a box");
    assert.notEqual(snapshotOf([...form.slice(0, 3),
      box("avatar-hen", true, "radio")]), same, "a radio");
    assert.equal(snapshotOf([{ ...form[0], checked: true },
      ...form.slice(1)]), same, "a text field is no box");
  });
});

// Box 2 of #837.
describe("shouldSave", () => {
  it("is false when the snapshot matches the one last sent, and false "
    + "while the form is not ready", () => {
    const now = snapshotOf(form);
    const before = snapshotOf([text("firstName", "Al"), ...form.slice(1)]);

    assert.equal(shouldSave({ snapshot: now, last: now, ready: true }), false);
    assert.equal(shouldSave({ snapshot: now, last: before, ready: false }),
      false);
    assert.equal(shouldSave({ snapshot: now, last: before, ready: true }),
      true);
    assert.equal(shouldSave({ snapshot: now, last: null, ready: true }), true);
  });
});

// Box 3 of #837.
describe("failureText", () => {
  it("is \"We couldn't save that.\" and the reason, its first letter "
    + "capitalized", () => {
    assert.equal(failureText("enter a phone number we can call or text."),
      "We couldn't save that. Enter a phone number we can call or text.");
    assert.equal(failureText("Already capitalized."),
      "We couldn't save that. Already capitalized.");
  });
});

// Box 4 of #837.
describe("why", () => {
  it("is the first field error, else the server's error, else the "
    + "fallback", () => {
    assert.equal(why({ errors: { phone: "Phone first.", zip: "Zip." },
      error: "Server." }), "Phone first.");
    assert.equal(why({ errors: {}, error: "Server." }), "Server.");
    assert.equal(why({ error: "Server." }), "Server.");
    for (const data of [{}, null, undefined, { errors: {} }]) {
      assert.equal(why(data), "something went wrong on our side. Try again.",
        JSON.stringify(data));
    }
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/autosave.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/autosave.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element", "setTimeout"] });
  });
});
