// The remove control's two candidate tints (James, 2026-11-12, #560),
// for James to pick from: three lines in the cart at 390 px, one
// picture of the lines in each tint, saved to
// test-results/remove-icon-tints/ and attached to the report, so the
// coordinator can post them. Nothing is asserted but the 3:1 contrast
// (WCAG 1.4.11) of the ring and X against the pane, at rest and with
// the hover's colour (here through :focus-visible, which shares it,
// since a phone has no hover).
//
// The brick is the default. On staging ?tint=green sets the green
// (scripts/staging/tint.js, test/remove-tint.test.mjs); a local build
// carries no staging bundle, so this sets the same attribute itself.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { contrast } from "../test/contrast.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";

const OUT = join(import.meta.dirname, "..", "test-results",
  "remove-icon-tints");

test.use({ viewport: { width: 390, height: 844 } });

// The colour the ring and X are drawn in (stroke="currentColor"), and
// the first solid background behind the button: the pane's.
const colours = (button) => button.evaluate((el) => {
  let at = el;
  let pane = "rgb(255, 255, 255)";

  while (at) {
    const bg = getComputedStyle(at).backgroundColor;

    if (bg && !/rgba\(.*, 0\)$|transparent/.test(bg)) {
      pane = bg;
      break;
    }
    at = at.parentElement;
  }

  return {
    stroke: getComputedStyle(el.querySelector("svg")).stroke,
    colour: getComputedStyle(el).color,
    pane,
  };
});

for (const tint of ["brick", "green"]) {
  test(`the lines with the ${tint} tint`, async ({ page }, testInfo) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 1, wings: 1, thighs: 1 });
    if (tint !== "brick") {
      await page.evaluate((t) => {
        document.documentElement.dataset.removeTint = t;
      }, tint);
    }
    await settleCart(order);

    const removes = order.cart.locator("[data-remove]");

    await expect(removes).toHaveCount(3);
    await expect(removes.first().locator("svg")).toBeVisible();

    const rest = await colours(removes.first());

    expect(rest.stroke).toBe(rest.colour);
    expect(contrast(rest.colour, rest.pane)).toBeGreaterThanOrEqual(3);

    // The picture, at rest, before anything takes the focus.
    const lines = order.cart.locator("[data-part='lines']");
    const file = join(OUT, `${tint}-${testInfo.project.name}.png`);

    mkdirSync(OUT, { recursive: true });
    // Past the colour's transition.
    await page.waitForTimeout(300);
    await lines.screenshot({ path: file, animations: "disabled" });
    await testInfo.attach(`remove icon, ${tint}`, {
      path: file, contentType: "image/png",
    });

    // The hover's colour: a key press makes the next focus visible.
    await page.keyboard.press("Shift");
    await removes.first().focus();
    await page.waitForTimeout(300);

    const hover = await colours(removes.first());

    expect(contrast(hover.colour, hover.pane)).toBeGreaterThanOrEqual(3);
    testInfo.annotations.push({
      type: "contrast",
      description: `${tint}: ${rest.colour} at ${
        contrast(rest.colour, rest.pane).toFixed(2)}:1, hover ${
        hover.colour} at ${contrast(hover.colour, hover.pane).toFixed(2)}:1`
        + ` against ${rest.pane}`,
    });
  });
}
