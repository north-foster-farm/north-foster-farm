// The pressed Card button keeps its focus ring (#284): its inset line
// is a box-shadow, and so is Bootstrap's ring, so the one used to
// replace the other.

import { OrderPage, expect, test } from "./support/order.mjs";

test("the pressed Card button shows a focus ring", async ({ page }) => {
  await new OrderPage(page).open({ eggs: 2 });
  await page.locator("#payment").scrollIntoViewIfNeeded();

  const card = page.locator("[data-card-choose]");

  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  // A key press, so the focus that follows is keyboard focus.
  await page.keyboard.press("Shift");
  await card.focus();
  await expect(card).toBeFocused();

  // The ring is the second shadow, once the button's transition ends.
  const ring = /inset, rgba\([^)]*\) 0px 0px 0px [1-9]/;

  await expect.poll(() => card.evaluate((el) =>
    getComputedStyle(el).boxShadow)).toMatch(ring);
});
