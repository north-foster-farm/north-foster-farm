// The sign-in page (#399): the block is centered, the button reads
// "Send a sign-in link", and the invalid ring wraps the field and the
// button only, never the message under them. Nothing is sent: an empty
// submit fails in the page.

import { expect, test } from "./support/order.mjs";

const WIDTHS = [390, 768, 1280];

for (const width of WIDTHS) {
  test.describe(`/login at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("centered; the ring excludes the message", async ({ page }) => {
      await page.goto("/login/");

      const button = page.locator("#login-submit");
      await expect(button).toHaveAccessibleName("Send a sign-in link");

      await button.click();
      const message = page.locator("#err-login-email");
      await expect(message).toBeVisible();

      const group = page.locator("#login-form .input-group");
      const ring = await group.evaluate(
        (node) => getComputedStyle(node).boxShadow);
      expect(ring, "the group draws the ring").not.toBe("none");

      const box = await group.boundingBox();
      const note = await message.boundingBox();
      expect(note.y, "the message is below the ring's box")
        .toBeGreaterThanOrEqual(box.y + box.height);

      const middle = box.x + box.width / 2;
      expect(Math.abs(middle - width / 2), "centered on the page")
        .toBeLessThanOrEqual(8);
    });
  });
}
