import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { answerFor } from "../assets/scripts/zip-check/main.js";

const area = terms.area;
const fees = {
  fee: terms.money.deliveryFee,
  extra: terms.money.outsideAreaFee,
};
const base = `$${fees.fee}`;
const away = `$${fees.fee + fees.extra}`;

// What the map's tag shows, said to a screen reader: what we deliver
// there and the price, with no prose around it (#214).
describe("the map's ZIP field", () => {
  it("names the town, both groups and the price for a listed ZIP", () => {
    const a = answerFor("02825", area, fees);

    assert.equal(a.tone, "ok");
    assert.equal(a.text, `We deliver eggs and chicken to Foster for ${base}.`);
    assert.equal(answerFor(" 029-03 ", area, fees).text,
      `We deliver eggs and chicken to Providence for ${base}.`,
      "digits only, however typed");
  });

  it("says eggs only where the state takes only eggs", () => {
    const ct = answerFor("06239", area, fees);

    assert.equal(ct.tone, "ok");
    assert.equal(ct.text,
      `We deliver eggs to Danielson for ${base}, but not chicken.`);
  });

  it("gives the higher price nearby and refuses a distant ZIP", () => {
    const near = answerFor("02895", area, fees); // Woonsocket: unlisted.
    const far = answerFor("01234", area, fees);

    assert.equal(near.tone, "wait");
    assert.equal(near.text,
      `We deliver eggs and chicken to 02895 for ${away}.`);
    assert.equal(far.tone, "no");
    assert.equal(far.text, "No delivery to 01234.");
  });

  it("asks for five digits otherwise", () => {
    for (const bad of ["", "0282", "abc", "0282x"]) {
      assert.deepEqual(answerFor(bad, area, fees),
        { tone: "", text: "Enter a five-digit ZIP code." }, bad);
    }
  });
});
