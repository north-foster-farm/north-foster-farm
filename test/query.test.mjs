import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  linkedMethod, withoutParam,
} from "../assets/scripts/order/lib/query.mjs";

const METHODS = ["delivery", "scituate", "onfarm"];

describe("the way a link to the order page chooses", () => {
  it("reads each of the form's ways", () => {
    for (const method of METHODS) {
      assert.equal(linkedMethod(`?method=${method}`, METHODS), method);
    }
  });

  it("reads it beside ?add=", () => {
    assert.equal(
      linkedMethod("?add=EGG-DOZ:2&method=onfarm", METHODS), "onfarm"
    );
  });

  it("ignores an unknown, empty or missing way", () => {
    for (const search of [
      "?method=pickup", "?method=ONFARM", "?method=", "", "?add=EGG-DOZ:1",
    ]) {
      assert.equal(linkedMethod(search, METHODS), null, search);
    }
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
