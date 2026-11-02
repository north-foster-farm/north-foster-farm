// An order page open since before a sign-in elsewhere learns of it
// (#521): session/watch.js tells the page when the stamp cookie is new
// as the customer comes back to it, or another tab saves the draft.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { watchSignIn } from "../assets/scripts/session/watch.js";

// Just enough of a page: its cookie, and the listeners added.
const page = (cookie = "") => {
  const on = { document: {}, window: {} };
  const add = (where) => (type, fn) => {
    (on[where][type] ||= []).push(fn);
  };

  globalThis.document = {
    cookie, visibilityState: "visible",
    addEventListener: add("document"),
  };
  globalThis.window = { addEventListener: add("window") };

  const fire = (where, type, event = {}) => {
    for (const fn of on[where][type] || []) fn(event);
  };

  return { fire };
};

describe("watchSignIn (#521)", () => {
  it("tells a sign-in once, on focus, a shown page or Back", () => {
    const { fire } = page();
    const told = [];

    watchSignIn((stamp) => told.push(stamp));
    fire("window", "focus");
    assert.deepEqual(told, [], "nothing changed");

    document.cookie = "nff_signed_in=abc";
    document.visibilityState = "hidden";
    fire("document", "visibilitychange");
    assert.deepEqual(told, [], "not while the page is hidden");

    document.visibilityState = "visible";
    fire("document", "visibilitychange");
    fire("window", "focus");
    fire("window", "pageshow");
    assert.deepEqual(told, ["abc"], "once per new stamp");

    document.cookie = "nff_signed_in=def";
    fire("window", "pageshow");
    assert.deepEqual(told, ["abc", "def"]);
  });

  it("hears the draft's own key from another tab, and no other", () => {
    const { fire } = page();
    const told = [];

    watchSignIn((stamp) => told.push(stamp), { key: "nff-order-draft" });
    document.cookie = "nff_signed_in=abc";
    fire("window", "storage", { key: "something-else" });
    assert.deepEqual(told, []);
    fire("window", "storage", { key: "nff-order-draft" });
    assert.deepEqual(told, ["abc"]);
  });

  it("tells nothing when the stamp goes", () => {
    const { fire } = page("nff_signed_in=abc");
    const told = [];

    watchSignIn((stamp) => told.push(stamp));
    document.cookie = "";
    fire("window", "focus");
    assert.deepEqual(told, []);
  });
});
