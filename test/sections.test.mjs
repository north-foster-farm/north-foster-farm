import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLIVER, namingRow, showing,
} from "../assets/scripts/order/lib/sections.mjs";

// A phone's catalog under a bar whose lower edge is at 120px: the
// last Tenders row, then Drumsticks' heading (a 44px gap and a 40px
// title), its two rows, then Wings. Rows are 96px tall.
const EDGE = 120;
const page = (scroll) => [
  { cat: "Tenders", top: 0, bottom: 96 },
  { cat: "Drumsticks", top: 180, bottom: 276 },
  { cat: "Drumsticks", top: 276, bottom: 372 },
  { cat: "Wings", top: 456, bottom: 552 },
].map((row) => ({
  ...row, top: row.top + EDGE - scroll, bottom: row.bottom + EDGE - scroll,
}));
const named = (scroll) => {
  const rows = page(scroll);

  return rows[namingRow(rows, EDGE)]?.cat;
};

describe("namingRow", () => {
  it("names Drumsticks over a sliver of Tenders (#561)", () => {
    // James's screenshot: a few pixels of Tenders under the bar, then
    // all of Drumsticks.
    assert.equal(named(90), "Drumsticks");
    assert.equal(named(80), "Drumsticks");
  });

  it("keeps Tenders while half its row shows", () => {
    assert.equal(named(0), "Tenders");
    assert.equal(named(47), "Tenders");
  });

  it("switches once no more than half the row shows", () => {
    assert.equal(named(48), "Drumsticks");
  });

  it("names the section a jump lands on", () => {
    // The menu brings Drumsticks' heading to 12px under the bar.
    assert.equal(named(180 - 40 - 12), "Drumsticks");
  });

  it("stays in a section from row to row", () => {
    assert.equal(named(276 + 47), "Drumsticks");
    assert.equal(named(276 + 48), "Wings");
  });

  it("finds no row once every one is above the bar", () => {
    assert.equal(namingRow(page(600), EDGE), -1);
  });
});

describe("showing", () => {
  it("lets a tall row go once a sliver of it shows", () => {
    const tall = { top: 0, bottom: 300 };

    assert.equal(showing(tall, 300 - SLIVER - 1), true);
    assert.equal(showing(tall, 300 - SLIVER), false);
  });

  it("needs more than 8px of a short row", () => {
    const short = { top: 0, bottom: 12 };

    assert.equal(showing(short, 3), true);
    assert.equal(showing(short, 4), false);
  });

  it("skips a hidden row, which measures zero", () => {
    assert.equal(showing({ top: 0, bottom: 0 }, 0), false);
  });
});
