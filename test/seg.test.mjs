// The segmented control (#392): one pattern, .seg, used by the Show
// switcher (radios) and the cart's count and total (buttons, .seg-lg).
// The first shared design (7e8cea1e, e412bca0) left the Show switcher
// dead on staging, and no test could see it. These hold what makes it
// work: the radios restock.js reads, a fill that cannot take a tap, an
// input that covers its label, and a fill that moves when the second
// radio is checked.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PARTIAL = read("layouts/partials/order/seg.html");
const FORM = read("layouts/partials/order/form.html");
const CART = read("layouts/partials/order/cart.html");
const RESTOCK = read("assets/scripts/order/restock.js");
const SCSS = read("assets/styles/components/_order.scss")
  .replace(/\/\/.*$/gm, "");

// -> the declarations of the first rule whose selector is exactly this.
const rule = (selector) => {
  const flat = SCSS.replace(/\s+/g, " ");
  const start = flat.indexOf(` ${selector} {`);

  assert.notEqual(start, -1, `no rule for ${selector}`);

  return flat.slice(flat.indexOf("{", start) + 1, flat.indexOf("}", start));
};

describe("segmented control markup", () => {
  it("is one partial, used by the Show switcher", () => {
    assert.match(FORM, /partial "order\/seg\.html"/);
    assert.doesNotMatch(FORM, /type="radio"/);
  });

  it("renders real radios in a radio group, with the script's hooks", () => {
    assert.match(PARTIAL, /role="radiogroup"/);
    assert.match(PARTIAL, /<input class="seg-input" type="radio"/);
    assert.match(PARTIAL, /<label class="seg-option">/);
    assert.match(PARTIAL, /class="seg-fill" aria-hidden="true"/);
    // The script finds the radios by data-show and value.
    assert.match(RESTOCK, /\[data-show\]\[value='stock'\]/);
    assert.match(RESTOCK, /\[data-show\]\[value='all'\]/);
    assert.match(FORM, /"value" "stock"[^)]*"hook" "data-show"/);
    assert.match(FORM, /"value" "all"[^)]*"hook" "data-show"/);
  });

  it("is the cart's markup too, with a size modifier", () => {
    assert.match(CART, /class="seg seg-lg order-cart-seg"/);
    assert.match(CART, /class="seg-fill order-cart-seg-fill"/);
    assert.equal(CART.match(/class="seg-option /g).length, 2);
  });
});

describe("segmented control styles", () => {
  it("moves the fill when the second radio is checked", () => {
    const moved = rule('.seg:has(.seg-input[value="all"]:checked) .seg-fill');

    assert.match(moved, /transform: translateX\(/);
  });

  it("keeps the fill from taking a tap", () => {
    assert.match(rule(".seg-fill"), /pointer-events: none/);
  });

  it("covers each label with its unseen, tappable radio", () => {
    const input = rule(".seg-input");

    assert.match(input, /position: absolute/);
    assert.match(input, /inset: 0/);
    assert.match(input, /opacity: 0/);
    assert.doesNotMatch(input, /pointer-events: none|display: none/);
    assert.match(rule(".seg-option"), /position: relative/);
    assert.doesNotMatch(rule(".seg-option"), /pointer-events: none/);
  });

  it("shows the focus ring on the label of a focused radio", () => {
    assert.match(SCSS, /\.seg-option:has\(\.seg-input:focus-visible\)/);
  });

  it("sizes the cart's by a modifier alone", () => {
    const lg = rule(".seg-lg");

    assert.match(lg, /max-width: 20rem/);
    assert.match(
      SCSS, /\.seg-lg \{[^}]*\.seg-option \{[^}]*min-height: 2\.5rem/
    );
  });
});
