// Criteria test for #678, box 5 of its "Done when": the one email rule
// in assets/scripts/utils/email.js normalizes and validates. Written
// from the issue alone, before the fix (2026-11-19).
//
// Held out of `npm test` by its name until the fix lands; the
// implementer turns it on with
//
//   git mv test/email.criteria.mjs test/email.test.mjs
//
// The two exports it expects: `normalizeEmail` (new) and
// `looksLikeEmail` (the name the file already exports, which the
// contact, join, login and Farm news forms import).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as email from "../assets/scripts/utils/email.js";

describe("#678: the one email rule", () => {
  it("normalizes and validates an email address", () => {
    const { normalizeEmail, looksLikeEmail } = email;

    assert.equal(typeof normalizeEmail, "function", "no normalizeEmail");
    assert.equal(typeof looksLikeEmail, "function", "no looksLikeEmail");

    // Normalize: trim, lowercase, drop trailing periods.
    for (const [typed, want] of [
      ["pat@example.com", "pat@example.com"],
      ["  pat@example.com\t", "pat@example.com"],
      ["Pat@Example.COM", "pat@example.com"],
      ["pat@example.com.", "pat@example.com"],
      ["pat@example.com...", "pat@example.com"],
      ["  PAT@EXAMPLE.COM.  ", "pat@example.com"],
      ["p.a.t@mail.example.co.uk", "p.a.t@mail.example.co.uk"],
    ]) {
      assert.equal(normalizeEmail(typed), want, JSON.stringify(typed));
    }

    // Validate: a domain of labels of letters, digits and hyphens,
    // joined by single periods, no hyphen at either end of a label,
    // and a final label of at least two letters.
    for (const good of [
      "name@example.com",
      "name@mail.example.com",
      "name@a.b.c.example.com",
      "name@my-farm.example.com",
      "name@my--farm.example.com",
      "name+orders@example.com",
      "first.last@example.com",
      "name2@example2.com",
      "name@123.example.com",
      "name@example.co",
      "name@example.museum",
      "name@example.photography",
    ]) {
      assert.equal(looksLikeEmail(good), true, `${good} refused`);
    }
    for (const bad of [
      "",
      "name",
      "name@",
      "@example.com",
      "name@@example.com",
      "na me@example.com",
      "name@example",
      "name@example..com",
      "name@.example.com",
      "name@-example.com",
      "name@example-.com",
      "name@mail.-example.com",
      "name@mail.example-.com",
      "name@example.c",
      "name@example.c0m",
      "name@example.123",
      "name@example.co-",
      "name@exa_mple.com",
      "name@exam ple.com",
    ]) {
      assert.equal(looksLikeEmail(bad), false, `${bad} taken`);
    }
  });
});
