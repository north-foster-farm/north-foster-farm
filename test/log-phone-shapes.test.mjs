// The logger's phone scrub beyond #896's criteria: an extension goes
// with its number, and a number in the 3-3-4 shape is scrubbed even
// glued to a word, where a bare run of digits would be kept as an id.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrub } from "../netlify/functions/lib/log.mjs";

const scrubbed = (text) => scrub({ detail: text }).detail;

describe("the logger's phone scrub, by shape", () => {
  it("takes an extension with its number", () => {
    for (const text of ["401-555-0100 x23", "401-555-0100x23",
      "401-555-0100 ext. 23", "401-555-0100 EXT 23"]) {
      assert.equal(scrubbed(text), "[phone]", text);
    }
  });

  it("scrubs a 3-3-4 number glued to a word", () => {
    assert.equal(scrubbed("phone-401-555-0100"), "phone-[phone]");
    assert.equal(scrubbed("abc401.555.0100"), "abc[phone]");
    assert.equal(scrubbed("401 555 0100ok"), "[phone]ok");
    assert.equal(scrubbed("401-555-0100-ext"), "[phone]-ext");
  });

  it("scrubs a number in a URL", () => {
    assert.equal(scrubbed("https://wa.me/14015550100"),
      "https://wa.me/[phone]");
    assert.equal(scrubbed("/call?p=401-555-0100&a=1"), "/call?p=[phone]&a=1");
  });

  it("keeps an id under an id key whose digits run on into a letter", () => {
    for (const id of ["inv-123456789012", "1234567890x9abc",
      "12345678-9012-4abc-8def-123456789012", "NFF-2610-23456789"]) {
      assert.equal(scrub({ id }).id, id);
      assert.equal(scrub({ "order_id": id })["order_id"], id);
    }
  });

  it("reads an id key from the key as written", () => {
    const id = "inv-1234567890ab";

    assert.equal(scrub({ idempotencyKey: id }).idempotencyKey, id);
    assert.equal(scrub({ items: [{ squareId: id }] }).items[0].squareId, id);
    assert.equal(scrub({ paid: id }).paid, "inv-[phone]ab");
    assert.equal(scrub({ valid: id }).valid, "inv-[phone]ab");
  });
});
