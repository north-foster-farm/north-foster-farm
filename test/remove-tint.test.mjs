// A cart line's remove control (James, 2026-11-12, #560): Tabler's
// circle-x in a soft tint, at least 3:1 against the pane at rest and
// on hover (WCAG 1.4.11), the brick by default and the green on
// staging's ?tint=green. The browser half, against the pane's computed
// background, is e2e/remove-icon-tints.spec.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { applyTint, tintFrom } from "../assets/scripts/staging/tint.js";
import { contrast } from "./contrast.mjs";

const read = (path) => readFileSync(path, "utf8");
const variables = read("assets/styles/_variables.scss");
const cart = read("assets/styles/components/_cart.scss");

const scss = (name) => {
  const m = variables.match(new RegExp(`^\\$${name}: +(#[0-9a-f]{3,6});`,
    "im"));

  assert.ok(m, `$${name} in _variables.scss`);

  return m[1];
};

// The pane is the page's background, Bootstrap's default white
// (_cart.scss sets var(--bs-body-bg); _variables.scss leaves $body-bg).
const PANE = scss("white");

describe("the remove control's tints (_variables.scss)", () => {
  for (const name of ["cart-remove-brick", "cart-remove-brick-hover",
    "cart-remove-green", "cart-remove-green-hover"]) {
    const tint = scss(name);
    const ratio = contrast(tint, PANE);

    it(`$${name} ${tint} is ${ratio.toFixed(2)}:1 against the pane`, () => {
      assert.ok(ratio >= 3, `${ratio.toFixed(2)}:1`);
    });
  }

  it("deepens on hover, never fades", () => {
    for (const tint of ["brick", "green"]) {
      assert.ok(contrast(scss(`cart-remove-${tint}-hover`), PANE)
        > contrast(scss(`cart-remove-${tint}`), PANE), tint);
    }
  });

  it("is neither the body's gray nor Bootstrap's danger red", () => {
    const block = cart.slice(cart.indexOf("  .order-cart-remove {"),
      cart.indexOf("  .order-cart-item-name {"));

    assert.doesNotMatch(block, /--bs-(secondary-color|danger|body-color)/);
    for (const rule of [
      "color: var(--cart-remove-tint, #{$cart-remove-brick});",
      "color: var(--cart-remove-tint-hover, #{$cart-remove-brick-hover});",
    ]) {
      assert.ok(block.includes(rule), rule);
    }
  });

  it("takes the green only from the attribute staging sets", () => {
    assert.match(cart, new RegExp([
      String.raw`:root\[data-remove-tint="green"\] \{\s*`,
      String.raw`--cart-remove-tint: #\{\$cart-remove-green\};\s*`,
      String.raw`--cart-remove-tint-hover: #\{\$cart-remove-green-hover\};`,
    ].join("")));
    // PurgeCSS keeps the rule only if it knows the attribute and value.
    const postcss = read("postcss.config.js");

    for (const word of ["data-remove-tint", "green"]) {
      assert.ok(postcss.includes(`"${word}",`), word);
    }
  });
});

describe("staging/tint.js", () => {
  it("reads ?tint=green and nothing else", () => {
    assert.equal(tintFrom("?tint=green"), "green");
    assert.equal(tintFrom("?add=eggs&tint=green"), "green");
    assert.equal(tintFrom("?tint=brick"), null);
    assert.equal(tintFrom("?tint=red"), null);
    assert.equal(tintFrom(""), null);
  });

  it("sets the attribute on the root, and clears it for the default", () => {
    const root = { dataset: { removeTint: "green" } };

    assert.equal(applyTint(root, "?tint=green"), "green");
    assert.equal(root.dataset.removeTint, "green");
    assert.equal(applyTint(root, "?tint=nope"), null);
    assert.equal("removeTint" in root.dataset, false);
  });

  // The staging bundle is built only on the branch deploy
  // (test/staging-build.test.mjs); the site's own never reads ?tint=.
  it("is part of the staging bundle alone", () => {
    assert.match(read("assets/scripts/staging/main.js"),
      /applyTint\(document\.documentElement, window\.location\.search\);/);
    assert.doesNotMatch(read("assets/scripts/main.js"), /tint/i);
  });
});

describe("the remove control's icon", () => {
  it("is Tabler's circle-x, hidden from screen readers", () => {
    const template = read("layouts/partials/order/cart.html");

    assert.ok(template.includes([
      `<button type="button" class="order-cart-remove" data-remove>`,
      `{{ partial "svg.html" (dict "src" "icons/circle-x" `,
      `"aria-hidden" "true") }}</button>`,
    ].join("")));
    // A ring and an X, nothing more.
    const svg = read("assets/images/icons/circle-x.svg");

    assert.match(svg, /a9 9 0 1 0 18 0/);
    assert.match(svg, /stroke="currentColor"/);
  });

  it("keeps its accessible name (cart.js)", () => {
    assert.ok(read("assets/scripts/order/cart/cart.js").includes(
      '"aria-label", `Remove ${item.lineName} from your cart`'
    ));
  });

  it("is credited in NOTICE and docs/media-provenance.md", () => {
    const notice = read("NOTICE");
    const tabler = notice.slice(notice.indexOf("Tabler Icons"));

    assert.match(tabler.slice(0, 600), /circle-x/);
    assert.doesNotMatch(notice, /\btrash\b/);
    assert.match(read("docs/media-provenance.md"),
      /\| `icons\/circle-x\.svg` \| Tabler;/);
  });
});
