// The remove control as James chose it (2026-11-12, #560): Tabler's
// circle-x in the muted brick, a light X leading and a paler ring
// framing it. Three lines in the cart at 390 px, one picture of the
// lines, saved to test-results/remove-icon/ and attached to the
// report, so the coordinator can post it. Nothing is asserted but what
// the picture needs and the X's 3:1 contrast (WCAG 1.4.11) against the
// pane, at rest and with the hover's colour (here through
// :focus-visible, which shares it, since a phone has no hover). The
// colours' arithmetic is test/remove-icon.test.mjs's.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { contrast } from "../test/contrast.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";

const OUT = join(import.meta.dirname, "..", "test-results", "remove-icon");

test.use({ viewport: { width: 390, height: 844 } });

// The colour the X is drawn in (stroke="currentColor", at full
// opacity), the ring's opacity, and the first solid background behind
// the button: the pane's.
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

  const [, ring, cross] = el.querySelectorAll("svg path");

  return {
    stroke: getComputedStyle(cross).stroke,
    crossOpacity: Number(getComputedStyle(cross).strokeOpacity),
    ringOpacity: Number(getComputedStyle(ring).strokeOpacity),
    colour: getComputedStyle(el).color,
    pane,
  };
});

test("the cart lines with the remove control", async ({ page }, testInfo) => {
  const order = new OrderPage(page);

  await order.open({ eggs: 1, wings: 1, thighs: 1 });
  await settleCart(order);

  const removes = order.cart.locator("[data-remove]");

  await expect(removes).toHaveCount(3);
  await expect(removes.first().locator("svg")).toBeVisible();

  const rest = await colours(removes.first());

  expect(rest.stroke).toBe(rest.colour);
  expect(rest.crossOpacity).toBe(1);
  expect(rest.ringOpacity).toBeLessThan(1);
  expect(contrast(rest.colour, rest.pane)).toBeGreaterThanOrEqual(3);

  // The picture, at rest, before anything takes the focus.
  const lines = order.cart.locator("[data-part='lines']");
  const file = join(OUT, `cart-lines-${testInfo.project.name}.png`);

  mkdirSync(OUT, { recursive: true });
  // Past the colour's transition.
  await page.waitForTimeout(300);
  await lines.screenshot({ path: file, animations: "disabled" });
  await testInfo.attach("cart lines, remove control", {
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
    description: `X ${rest.colour} at ${
      contrast(rest.colour, rest.pane).toFixed(2)}:1, hover ${
      hover.colour} at ${contrast(hover.colour, hover.pane).toFixed(2)}:1`
      + ` against ${rest.pane}; ring at ${rest.ringOpacity} opacity`,
  });
});
