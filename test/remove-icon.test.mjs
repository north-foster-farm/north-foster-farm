// A cart line's remove control (James, 2026-11-12, #560): Tabler's
// circle-x in a muted brick, the X in a light stroke leading, the ring
// a paler brick that only frames it. The X carries the control, so it
// alone is held to 3:1 against the pane at rest and on hover (WCAG
// 1.4.11); the ring stays paler than the X. The picture is
// e2e/remove-icon.spec.mjs's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { contrast } from "./contrast.mjs";

const read = (path) => readFileSync(path, "utf8");
const variables = read("assets/styles/_variables.scss");
const cart = read("assets/styles/components/_cart.scss");
const svg = read("assets/images/icons/circle-x.svg");

const scss = (name) => {
  const m = variables.match(new RegExp(`^\\$${name}: +(#[0-9a-f]{3,6});`,
    "im"));

  assert.ok(m, `$${name} in _variables.scss`);

  return m[1];
};

// The pane is the page's background, Bootstrap's default white
// (_cart.scss sets var(--bs-body-bg); _variables.scss leaves $body-bg).
const PANE = scss("white");

const rgb = (hex) => {
  const h = hex.length === 4
    ? [...hex.slice(1)].map((c) => c + c).join("")
    : hex.slice(1);

  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

// A colour at an opacity over the pane, as the ring is drawn.
const over = (hex, alpha, pane = PANE) => {
  const [a, b] = [rgb(hex), rgb(pane)];

  return `rgb(${a.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)))
    .join(", ")})`;
};

// The ring's and the X's paths in icons/circle-x.svg.
const paths = [...svg.matchAll(/<path ([^>]*)\/>/g)].map((m) => m[1]);
const ring = paths.find((p) => /a9 9 0 1 0 18 0/.test(p));
const cross = paths.find((p) => /m10 10 4 4m0-4-4 4/.test(p));
const ringOpacity = Number(ring?.match(/stroke-opacity="([\d.]+)"/)?.[1]);

describe("the remove control's colour (_variables.scss)", () => {
  for (const name of ["cart-remove", "cart-remove-hover"]) {
    const tint = scss(name);
    const ratio = contrast(tint, PANE);

    it(`the X in $${name} ${tint} is ${ratio.toFixed(2)}:1`, () => {
      assert.ok(ratio >= 3, `${ratio.toFixed(2)}:1`);
    });
  }

  it("deepens on hover, never fades", () => {
    assert.ok(contrast(scss("cart-remove-hover"), PANE)
      > contrast(scss("cart-remove"), PANE));
  });

  it("is the brick alone: no other tint, no staging switch", () => {
    assert.doesNotMatch(variables, /\$cart-remove-(brick|green)/);
    assert.doesNotMatch(cart, /remove-tint/);
    assert.doesNotMatch(read("postcss.config.js"), /remove-tint/);
    assert.doesNotMatch(read("assets/scripts/staging/main.js"), /tint/i);
  });

  it("is neither the body's gray nor Bootstrap's danger red", () => {
    const block = cart.slice(cart.indexOf("  .order-cart-remove {"),
      cart.indexOf("  .order-cart-item-name {"));

    assert.doesNotMatch(block, /--bs-(secondary-color|danger|body-color)/);
    for (const rule of [
      "color: $cart-remove;",
      "color: $cart-remove-hover;",
    ]) {
      assert.ok(block.includes(rule), rule);
    }
  });
});

describe("the remove control's icon (icons/circle-x.svg)", () => {
  it("is a ring and an X, drawn in the button's colour", () => {
    assert.ok(ring, "the ring's path");
    assert.ok(cross, "the X's own path");
    assert.match(svg, /stroke="currentColor"/);
  });

  it("draws the X lighter than Tabler's 2 at 24 px", () => {
    const width = Number(svg.match(/stroke-width="([\d.]+)"/)?.[1]);

    assert.ok(width <= 1.5 && width >= 1, `stroke-width ${width}`);
    assert.doesNotMatch(cross, /stroke-(width|opacity)/);
  });

  it("draws the ring paler than the X, so the X leads", () => {
    assert.ok(ringOpacity > 0 && ringOpacity < 1, `ring at ${ringOpacity}`);
    for (const name of ["cart-remove", "cart-remove-hover"]) {
      const x = contrast(scss(name), PANE);
      const r = contrast(over(scss(name), ringOpacity), PANE);

      assert.ok(r < x, `${name}: ring ${r.toFixed(2)}:1, X ${x.toFixed(2)}:1`);
      // Still there to frame it.
      assert.ok(r > 1.5, `${name}: ring ${r.toFixed(2)}:1`);
    }
  });

  it("sits in the button, hidden from screen readers", () => {
    const template = read("layouts/partials/order/cart.html");

    assert.ok(template.includes([
      `<button type="button" class="order-cart-remove" data-remove>`,
      `{{ partial "svg.html" (dict "src" "icons/circle-x" `,
      `"aria-hidden" "true") }}</button>`,
    ].join("")));
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
