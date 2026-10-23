// The thin bar above the header that names the next pop-up (#139),
// from data/series.json. The build picks the event; the page drops a
// bar whose end has passed. docs/qa-launch.md, "The autumn refresh".

import { events } from "./support/series.mjs";
import { expect, test } from "./support/order.mjs";

// The event the bar shows is worked out here from data/series.json as
// layouts/partials/top-bar.html does: the first by date that has not
// ended, in the farm's zone. A spec that named one event went red the
// day it ended, on every build after.
const ZONE = "America/New_York";

// The farm's offset from UTC on a date: "-04:00" or "-05:00".
const offset = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, timeZoneName: "longOffset",
}).formatToParts(new Date(`${date}T12:00:00Z`))
  .find((p) => p.type === "timeZoneName").value.replace("GMT", "");

// "14:00" -> "2:00 PM", as Hugo's "3:04 PM".
const clock = (hm) => {
  const [h, m] = hm.split(":").map(Number);
  const half = h < 12 ? "AM" : "PM";

  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${half}`;
};

const day = (date, style) => new Date(`${date}T12:00:00Z`)
  .toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: style, month: style, day: "numeric",
  });

const urlize = (text) => text.toLowerCase().replace(/[^a-z0-9\s-]/g, "")
  .trim().replace(/\s+/g, "-");

const next = [...events]
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((e) => ({
    ...e, ends: `${e.date}T${e.end || "23:59"}:00${offset(e.date)}`,
  }))
  .find((e) => new Date(e.ends) > new Date());

// A pop-up's link opens its card on the home page's map (M9 on #214),
// in the same tab; the card has no Instagram link.
const EVENT = next && {
  ...next,
  popUp: next.kind === "pop-up",
  short: `${next.name}, ${day(next.date, "short")}`,
  long: `${next.name} in ${next.address.city}, ${day(next.date, "long")}${
    next.start ? `, ${clock(next.start)} – ${clock(next.end || "23:59")}` : ""
  }`,
  href: new RegExp(`#place-${urlize(next.place)}$`),
};

const bar = (page) => page.locator("[data-top-bar]");

test.describe("top bar, with no event ahead", () => {
  test.skip(!!EVENT, "data/series.json has an event ahead");

  test("no page carries a bar", async ({ page }) => {
    for (const path of ["/", "/order/", "/about/"]) {
      await page.goto(path);
      await expect(bar(page), path).toHaveCount(0);
    }
  });
});

test.describe("top bar (#139)", () => {
  test.skip(!EVENT || !EVENT.popUp,
    "no pop-up ahead in data/series.json; these cover a pop-up");
  test("one line above the header, short on a phone, linking to the map",
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
        await expect(link).not.toHaveAttribute("target", /./);

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
      expect((await bar(page).boundingBox()).height).toBeCloseTo(30, 1);
    });

  test("the pop-up's link opens its card on the map", async ({ page }) => {
    await page.goto("/about/");
    await bar(page).locator("a").click();

    const map = page.locator("[data-map]").first();
    const card = map.locator("[data-map-card]:not([hidden])");

    await expect(page).toHaveURL(EVENT.href);
    await expect(map).toHaveAttribute("data-layer", "places");
    await expect(card).toContainText("Pop-up");
    await expect(card).toContainText(EVENT.place);
    await expect(card.getByRole("link", { name: "Instagram" }))
      .toHaveCount(0);
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

      const minute = 60_000;
      const ends = new Date(EVENT.ends).getTime();

      await page.clock.install({ time: new Date(ends - minute) });
      await at(ends - minute);
      await expect(bar(page)).toBeVisible();

      await at(ends + minute);
      await expect(bar(page)).toHaveCount(0);

      // With no bar the hero reserves only the header's height.
      const reserve = await page.locator(".home-hero").evaluate(
        (el) => getComputedStyle(el).getPropertyValue("--top-bar-height")
      );

      expect(["", "0rem", "0"]).toContain(reserve.trim());
    });
});

// #313: the farm may skip an occurrence the build still knows. The bar
// reads /api/events at view time and leaves out a pop-up the schedule
// skips; one the farm attends stays.
test.describe("top bar and the schedule (#313)", () => {
  test.skip(!EVENT || !EVENT.popUp,
    "no pop-up ahead in data/series.json; these cover a pop-up");

  const events = (list) => (route) => route.fulfill({
    json: { now: new Date().toISOString(), events: list },
  });

  test("a pop-up the schedule skips is left out", async ({ page }) => {
    await page.route("**/api/events", events([]));
    await page.goto("/");
    await expect(bar(page)).toBeHidden();
  });

  test("a pop-up the farm attends stays", async ({ page }) => {
    await page.route("**/api/events", events([{
      date: EVENT.date, series: EVENT.id, status: "attend",
      kind: "pop-up",
    }]));
    await page.goto("/");
    await expect(bar(page)).toBeVisible();
  });

  test("a pop-up beyond the two weeks is read from the build",
    async ({ page }) => {
      test.skip(
        (Date.parse(EVENT.date) - Date.now()) / 864e5 < 14,
        "the pop-up is inside the window"
      );
      await page.route("**/api/events", events([]));
      await page.goto("/");
      await expect(bar(page)).toBeVisible();
    });
});
