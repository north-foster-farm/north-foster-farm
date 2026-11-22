// Site search in the header (#402): a light field in the header row at
// 992 px and up, a magnifier that opens a bar under the header below
// that. The criteria tests are e2e/site-search.spec.mjs and
// test/search-index.test.mjs; this keeps a regression the palette
// (#142) had, rewritten for the field.
// docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

const ui = (page) => {
  const field = page.getByRole("combobox", { name: /search/i });
  const region = page.getByRole("search").filter({ has: field });

  return {
    field,
    listbox: region.getByRole("listbox"),
    magnifier: page.getByRole("banner")
      .getByRole("button", { name: /search/i }),
  };
};

test.describe("search (#402)", () => {
  // Found by QA, 2026-09-24, on the palette: a close left a timer that
  // closed it again, so reopening at once failed. Still a customer's
  // move: close, change your mind, open again.
  test("it reopens right after it closes", async ({ page }) => {
    await page.goto("/about/");

    const s = ui(page);
    const wide = page.viewportSize().width >= 992;

    if (wide) {
      await s.field.click();
      await s.field.fill("eggs");
      await expect(s.listbox).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(s.listbox).toBeHidden();
      await page.waitForTimeout(250);
      await s.field.fill("wings");
      await page.waitForTimeout(700);
      await expect(s.listbox, "open 700 ms after reopening").toBeVisible();
    } else {
      await s.magnifier.click();
      await expect(s.field).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(s.field).toBeHidden();
      await page.waitForTimeout(250);
      await s.magnifier.click();
      await page.waitForTimeout(700);
      await expect(s.field, "open 700 ms after reopening").toBeVisible();
      await expect(s.field).toBeFocused();
    }
  });
});
