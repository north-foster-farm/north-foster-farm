import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  enterField, fieldError, validField,
} from "../assets/scripts/utils/field-errors.mjs";

describe("field errors", () => {
  it("asks for a field that is empty, with the right article", () => {
    assert.equal(enterField("email"), "Please enter an email address.");
    assert.equal(enterField("phone"), "Please enter a phone number.");
    assert.equal(enterField("zip"), "Please enter a ZIP code.");
    assert.equal(enterField("card"), "Please enter a card number.");
    assert.equal(enterField("expiration"),
      "Please enter an expiration date.");
  });

  it("asks for a valid one when it is filled in wrong", () => {
    assert.equal(validField("email"),
      "Please enter a valid email address.");
    assert.equal(validField("expiration"),
      "Please enter a valid expiration date.");
  });

  it("picks by case", () => {
    assert.equal(fieldError("email", ""), enterField("email"));
    assert.equal(fieldError("email", "   "), enterField("email"));
    assert.equal(fieldError("email", undefined), enterField("email"));
    assert.equal(fieldError("email", "ada@"), validField("email"));
    assert.equal(fieldError("zip", "028"), validField("zip"));
  });
});
