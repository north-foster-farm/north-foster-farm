import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  linkedMethod, withoutParam,
} from "../assets/scripts/order/lib/query.mjs";

const METHODS = ["delivery", "scheduled", "onfarm"];
const DROP = "VFVQ";
const scheduled = (series) => ({ method: "scheduled", series });

describe("the way a link to the order page chooses", () => {
  it("reads each of the form's ways", () => {
    for (const method of METHODS) {
      assert.deepEqual(
        linkedMethod(`?method=${method}`, METHODS, DROP),
        { method, series: null }
      );
    }
  });

  it("reads it beside ?add=", () => {
    assert.deepEqual(
      linkedMethod("?add=EGG-DOZ:2&method=onfarm", METHODS, DROP),
      { method: "onfarm", series: null }
    );
  });

  it("reads the series a scheduled link names", () => {
    assert.deepEqual(
      linkedMethod("?method=scheduled&series=WAC5", METHODS, DROP),
      scheduled("WAC5")
    );
    assert.deepEqual(
      linkedMethod("?series=WAC5&add=A:1&method=scheduled", METHODS, DROP),
      scheduled("WAC5")
    );
  });

  it("reads the old drop-site link as the drop site's series", () => {
    assert.deepEqual(
      linkedMethod("?method=scituate", METHODS, DROP), scheduled(DROP)
    );
    assert.deepEqual(
      linkedMethod("?method=scituate&series=WAC5", METHODS, DROP),
      scheduled(DROP)
    );
  });

  it("gives only scheduled pickup a series", () => {
    assert.deepEqual(
      linkedMethod("?method=delivery&series=WAC5", METHODS, DROP),
      { method: "delivery", series: null }
    );
  });

  it("ignores an unknown, empty or missing way", () => {
    for (const search of [
      "?method=market", "?method=pickup", "?method=ONFARM", "?method=", "",
      "?add=EGG-DOZ:1",
      "?series=WAC5",
    ]) {
      assert.equal(linkedMethod(search, METHODS), null, search);
    }
  });

  it("ignores scituate when the form has no scheduled pickup", () => {
    assert.equal(
      linkedMethod("?method=scituate", ["onfarm"], DROP), null
    );
  });
});

describe("clearing a parameter from the query", () => {
  it("leaves nothing when it was the only one", () => {
    assert.equal(withoutParam("?method=onfarm", "method"), "");
  });

  it("keeps the others", () => {
    assert.equal(
      withoutParam("?method=onfarm&add=EGG-DOZ%3A2", "method"),
      "?add=EGG-DOZ%3A2"
    );
    assert.equal(withoutParam("?add=A%3A1&x=1", "add"), "?x=1");
  });
});
