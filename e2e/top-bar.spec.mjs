// The thin bar above the header that names the next pop-up (#139),
// from data/events.json. The build picks the event; the page drops a
// bar whose end has passed. docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

// The event on staging today, and when it ends in the farm's zone.
const EVENT = {
  short: "Pop-up at The Village Family Fitness, Sun, Oct 18",
  long: "Pop-up at The Village Family Fitness in Warwick, Sunday, " +
    "October 18, 10:00 AM – 2:00 PM",
  href: "https://www.instagram.com/thevillagefitnessri/",
  ends: "2026-10-18T14:00:00-04:00",
};

const bar = (page) => page.locator("[data-top-bar]");

test.describe("top bar (#139)", () => {
  test("one line above the header, short on a phone, linking out",
    async ({ page }) => {
      await page.goto("/");

      for (const [width, text] of [
        [1500, EVENT.long], [990, EVENT.long], [576, EVENT.long],
        [575, EVENT.short], [390, EVENT.short],
      ]) {
        await page.setViewportSize({ width, height: 800 });

        const link = bar(page).locator("a");
        const m = await link.evaluate((a) => ({
          text: a.innerText.trim(),
          height: a.getBoundingClientRect().height,
          clipped: a.scrollWidth > a.clientWidth,
        }));
        const at = `${width}px`;

        expect(m.text, at).toBe(text);
        expect(m.height, `${at} one line`).toBe(30);
        if (width >= 390) expect(m.clipped, `${at} no ellipsis`).toBe(false);
        await expect(link).toHaveAttribute("href", EVENT.href);
        await expect(link).toHaveAttribute("target", "_blank");

        const below = await page.evaluate(() => {
          const b = document.querySelector("[data-top-bar]");
          const h = document.querySelector("header");

          return h.getBoundingClientRect().top -
            b.getBoundingClientRect().bottom;
        });

        expect(below, `${at} the header sits right under it`).toBe(0);
      }

      // A narrow phone keeps the one line, with an ellipsis if need be.
      await page.setViewportSize({ width: 320, height: 568 });
      expect((await bar(page).boundingBox()).height).toBe(30);
    });

  test("every page carries it", async ({ page }) => {
    for (const path of ["/order/", "/about/", "/contact/", "/news/",
      "/delivery-policy/", "/login/"]) {
      await page.goto(path);
      await expect(bar(page), path).toBeVisible();
    }
  });

  test("the page drops the bar once the pop-up has ended",
    async ({ page }) => {
      const at = async (time) => {
        await page.clock.setFixedTime(new Date(time));
        await page.goto("/");
      };

      await page.clock.install({ time: new Date("2026-10-18T13:59:00-04:00") });
      await at("2026-10-18T13:59:00-04:00");
      await expect(bar(page)).toBeVisible();

      await at("2026-10-18T14:01:00-04:00");
      await expect(bar(page)).toHaveCount(0);

      // With no bar the hero reserves only the header's height.
      const reserve = await page.locator(".home-hero").evaluate(
        (el) => getComputedStyle(el).getPropertyValue("--top-bar-height")
      );

      expect(["", "0rem", "0"]).toContain(reserve.trim());
    });
});
