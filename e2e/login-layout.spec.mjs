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

    // #443: the form sits in a card; on a phone the field stacks over
    // a full-width button and the text aligns with the form.
    test("in a card; stacked and left-aligned on a phone", async ({ page }) => {
      await page.goto("/login/");

      const card = page.locator(".login-card");
      const field = page.locator("#login-email");
      const button = page.locator("#login-submit");

      await expect(card).toBeVisible();
      await expect(card.locator("#login-form")).toHaveCount(1);

      const fieldBox = await field.boundingBox();
      const buttonBox = await button.boundingBox();
      const align = await page.locator("#login-ask p").first()
        .evaluate((node) => getComputedStyle(node).textAlign);

      if (width < 576) {
        expect(buttonBox.y, "the button is under the field")
          .toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
        expect(Math.abs(buttonBox.width - fieldBox.width),
          "the button is as wide as the field").toBeLessThanOrEqual(2);
        expect(align).toBe("left");
      } else {
        expect(Math.abs(buttonBox.y - fieldBox.y), "one row")
          .toBeLessThanOrEqual(2);
        expect(align).toBe("center");
      }
    });
  });
}
