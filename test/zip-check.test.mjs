import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { answerFor } from "../assets/scripts/zip-check/main.js";

const area = terms.area;

describe("do we deliver to you", () => {
  it("says yes, and names the town, for a listed ZIP", () => {
    const a = answerFor("02825", area);

    assert.equal(a.tone, "ok");
    assert.equal(a.text, "Yes! We deliver to Foster on Thursdays. Order by " +
      "noon on Wednesday.");
    assert.equal(answerFor(" 029-03 ", area).text.startsWith(
      "Yes! We deliver to Providence"), true, "digits only, however typed");
  });

  it("adds the state's note where there is one", () => {
    const ct = answerFor("06239", area);

    assert.equal(ct.tone, "ok");
    assert.match(ct.text, /^Yes! We deliver to Danielson on Thursdays/);
    assert.match(ct.text, /only able to deliver eggs in Connecticut/);
  });

  it("hedges for a nearby unlisted ZIP and refuses a distant one", () => {
    const near = answerFor("02895", area); // Woonsocket: near, unlisted.
    const far = answerFor("01234", area);

    assert.equal(near.tone, "wait");
    assert.match(near.text,
      /\$3 more\. If we can.t get to your address, we.ll call/);
    assert.equal(far.tone, "no");
    assert.match(far.text, /outside our delivery area/);
    assert.match(far.text, /the drop site are open/);
  });

  it("asks for five digits otherwise", () => {
    for (const bad of ["", "0282", "abc", "0282x"]) {
      assert.deepEqual(answerFor(bad, area),
        { tone: "", text: "Enter a five-digit ZIP code." }, bad);
    }
  });
});
