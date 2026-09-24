// The footer as #141 lands it: the sign-up as an input group with a
// floating label and an egg spinner, one line of links, one line of
// ways to reach the farm, the copyright. The sign-up request is
// stubbed here; farm news end to end is news.spec.mjs.
// docs/qa-launch.md, "The autumn refresh".

import { expectBusy, expectIdle, holdRequests } from "./support/busy.mjs";
import { expect, test } from "./support/order.mjs";

const LINKS = [
  "About", "Account", "News", "Accessibility", "Privacy", "Delivery",
  "Contact", "Order", "llms.txt",
];

// Each dotted line's items, grouped by the row they sit on, with the
// dot each one draws before itself ("none" for no dot).
const rows = (list) => list.evaluate((ul) => {
  const byTop = new Map();

  for (const li of ul.children) {
    const top = li.offsetTop;

    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push({
      text: li.textContent.trim(),
      dot: getComputedStyle(li, "::before").content,
    });
  }

  return [...byTop.values()];
});

test.describe("footer (#141)", () => {
  test("the links, then how to reach the farm, then the copyright",
    async ({ page, request }) => {
      // Contact joins the links once its page exists (#140).
      const contact = (await request.get("/contact/")).ok();
      const expected = LINKS.filter((name) => contact || name !== "Contact");

      await page.goto("/");

      const footer = page.locator("footer.site-footer");
      const links = footer.locator("nav[aria-label='Footer'] > ul > li");
      const reach = footer.locator(".footer-contact > li");

      await expect(links).toHaveText(expected);
      await expect(reach).toHaveText([
        "(401) 578-3713", "sales@northfosterfarm.com", "@northfosterfarm",
      ]);
      await expect(reach.nth(0).locator("a"))
        .toHaveAttribute("href", "tel:+14015783713");
      await expect(reach.nth(1).locator("a"))
        .toHaveAttribute("href", "mailto:sales@northfosterfarm.com");
      await expect(reach.nth(2).locator("a"))
        .toHaveAttribute("href", /instagram\.com\/northfosterfarm$/);

      // In reading order: sign-up, links, contact line, copyright.
      const order = await footer.evaluate((el) => [
        "[data-news-signup]", "nav[aria-label='Footer']", ".footer-contact",
        "#copyright-year",
      ].map((sel) => {
        const all = [...el.querySelectorAll("*")];

        return all.indexOf(el.querySelector(sel));
      }));

      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      await expect(footer.locator("#copyright-year"))
        .toHaveText(String(new Date().getFullYear()));
    });

  test("no row of the dotted lines opens with a dot, at any width",
    async ({ page }) => {
      await page.goto("/");

      const lists = page.locator("footer.site-footer [data-dot-list]");
      let wrapped = 0;

      for (const width of [1500, 990, 575, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(200);

        for (const list of await lists.all()) {
          const lines = await rows(list);

          if (lines.length > 1) wrapped += 1;
          for (const [i, line] of lines.entries()) {
            expect(line[0].dot, `${width}px row ${i + 1} opens with ` +
              `"${line[0].text}"`).toBe("none");
            for (const item of line.slice(1)) {
              expect(item.dot, `${width}px "${item.text}"`).toBe("\"·\"");
            }
          }
        }
      }
      expect(wrapped, "some line wraps, or this proves nothing")
        .toBeGreaterThan(0);
    });

  test("a bad address is marked at the field, and fixing it clears it",
    async ({ page }) => {
      const form = page.locator("footer [data-news-signup]");
      const input = form.locator("input[type='email']");
      const note = form.locator("[data-news-note]");

      await page.goto("/");
      await expect(form.locator("label"))
        .toHaveText("Farm news by email");
      await expect(note, "nothing under the field until an answer")
        .toHaveText("");

      await form.getByRole("button").click();
      await expect(note).toHaveText("Enter your email address.");

      // A bare type="email" would let "you@farm" through.
      for (const bad of ["nope", "you@farm"]) {
        await input.fill(bad);
        await form.getByRole("button").click();
        await expect(note)
          .toHaveText("Enter a valid email address, like you@example.com.");
        await expect(input).toHaveClass(/\bis-invalid\b/);
        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(input).toBeFocused();
      }

      await input.fill("you@example.com");
      await expect(input).not.toHaveClass(/\bis-invalid\b/);
      await expect(note).toHaveText("");
    });

  test("while it sends, the button shows the egg and keeps its width",
    async ({ page }) => {
      const form = page.locator("footer [data-news-signup]");
      const button = form.locator(".busy-button");
      const hold = await holdRequests(page, "**/api/news/subscribe");

      await page.goto("/");

      const email = "qa-e2e-footer@example.com";
      const width = (await button.boundingBox()).width;

      await form.locator("input[type='email']").fill(email);
      await button.click();
      await expectBusy(page, button, { busyWord: "Submitting", width });
      await expect(form.locator("[data-news-note]")).toHaveText("");

      // A second press while it sends sends nothing more. The button is
      // only aria-disabled, so a person can still press it.
      await button.click({ force: true });
      hold.release();

      await expect(form.locator("[data-news-note]")).toHaveText(
        `Check ${email} for an email from us. One click there and you're ` +
        "on the list."
      );
      await expectIdle(button, { width });
      expect(hold.calls()).toBe(1);
    });
});
