import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcile } from "../assets/scripts/video/choice.js";

describe("the videos setting between account and browser (#161)", () => {
  it("adopts the account's choice when the browser differs", () => {
    assert.deepEqual(reconcile("off", "on"), { adopt: "off" });
    assert.deepEqual(reconcile("on", "off"), { adopt: "on" });
    assert.deepEqual(reconcile("off", null), { adopt: "off" });
    assert.deepEqual(reconcile("on", null), { adopt: "on" },
      "a chosen on wins over the browser's reduced motion");
  });

  it("does nothing when they agree", () => {
    assert.deepEqual(reconcile("on", "on"), {});
    assert.deepEqual(reconcile("off", "off"), {});
  });

  it("saves a guest's choice to an account that has none", () => {
    assert.deepEqual(reconcile(null, "off"), { save: "off" });
    assert.deepEqual(reconcile(null, "on"), { save: "on" });
  });

  it("leaves both unset when neither chose", () => {
    assert.deepEqual(reconcile(null, null), {});
    assert.deepEqual(reconcile(undefined, null), {},
      "an answer from before the field");
  });
});
