// Criteria tests for #651, written by a test agent from the issue's
// spec and "Done when" list before the fix: the market list on /about/
// and on the home page's markets block must not push the page down
// when "Order for pickup here" appears, after /api/dates answers.
//
// Each test holds /api/dates with page.route, so the page paints with
// no answer, measures the document's height and the footer's top,
// then answers and measures again once schedule.js has read it. The
// answer is the canned one (support/canned.mjs: dates() from the
// site's own builders, relative to today) with its scheduled pickups
// swapped for one at a market the page lists, or for none, so the
// spec does not depend on the farm's schedule. It never waits the
// dates out as support/settled.mjs does: the hold is the test.
//
// The home page shows its markets block only in season, chosen in the
// browser by date, so the home tests fix the clock on a Saturday in
// September of the season in data/series.json, as home.spec.mjs does.
//
// Held out of every project by `held` in playwright.config.mjs until
// the fix lands; deleting this spec's line there turns it on.

import { dates } from "./support/canned.mjs";
import { expect, test } from "./support/counted.mjs";

// A Saturday in September of the season in the data (home.spec.mjs's
// SEASON.september), when the home page's markets block shows.
const september = async () => {
  const { markets } = await import("./support/series.mjs");
  const last = markets.filter((m) => !m.winter).map((m) => m.closes)
    .sort().at(-1);
  let d = new Date(`${last.slice(0, 4)}-09-01T14:00:00Z`);

  while (d.getUTCDay() !== 6) d = new Date(d.getTime() + 864e5);

  return d;
};

const frames = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));

// The document's height and the footer's top in the document, once
// the fonts and the images already loading have settled.
const measure = async (page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images]
      .filter((img) => !img.complete && img.loading !== "lazy")
      .map((img) => img.decode().catch(() => {})));
  });
  await frames(page);

  return page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    footer: document.querySelector("footer.site-footer")
      .getBoundingClientRect().top + window.scrollY,
  }));
};

// Holds every /api/dates request until release(scheduled) answers it
// with the canned dates, their scheduled pickups replaced.
const holdDates = async (page) => {
  const held = [];
  let json = null;
  let arrived;
  const first = new Promise((resolve) => {
    arrived = resolve;
  });

  await page.route("**/api/dates", (route) => {
    if (json) return route.fulfill({ json });
    held.push(route);
    arrived();
  });

  return {
    first,
    release: async (scheduled) => {
      json = { ...dates(), scheduled };
      await Promise.all(held.map((route) => route.fulfill({ json })));
    },
  };
};

// One canned scheduled pickup, moved to the market `code`.
const openAt = (code, name) => {
  const [one] = dates().scheduled;

  return [{ ...one, series: code, name,
    occurrence: one.occurrence.replace(one.series, code) }];
};

const PAGES = [
  { name: "/about/", path: "/about/", lines: ".markets-list li" },
  { name: "the home page", path: "/", lines: "[data-season-band] li.place",
    clock: september },
];

for (const { name, path, lines, clock } of PAGES) {
  test.describe(`${name}'s market list (#651)`, () => {
    // Done when 1.
    test(`on ${name}, with a market open for pickup, the document's ` +
      "height and the footer's position are the same before and after " +
      "/api/dates answers", async ({ page }) => {
      if (clock) await page.clock.setFixedTime(await clock());

      const hold = await holdDates(page);

      await page.goto(path);
      await hold.first;

      // The first market the page shows; its line is the one to open.
      const market = page.locator(`${lines}:visible`).first();
      const line = market.locator("[data-pickup-for]");
      const code = await line.getAttribute("data-pickup-for");
      const label = (await market.locator("strong, .place-name").first()
        .innerText()).trim();

      expect(code, "the page lists a market with a pickup line").toBeTruthy();

      const before = await measure(page);

      await hold.release(openAt(code, label));
      await expect(line.getByRole("link",
        { name: "Order for pickup here" })).toBeVisible();

      const after = await measure(page);

      expect(after.height, "the document's height").toBe(before.height);
      expect(after.footer, "the footer's top").toBe(before.footer);
    });

    // Done when 2, its measurable part: no line shows. The gap a reader
    // would notice is the screenshots' (a recorded check).
    test(`on ${name}, with no market open, no "Order for pickup here" ` +
      "line shows and the page is not pushed down after /api/dates " +
      "answers", async ({ page }) => {
      if (clock) await page.clock.setFixedTime(await clock());

      const hold = await holdDates(page);
      const answered = page.waitForResponse("**/api/dates");

      await page.goto(path);
      await hold.first;
      await expect(page.locator(`${lines}:visible`).first()).toBeVisible();

      const before = await measure(page);

      await hold.release([]);
      await (await answered).finished();

      const after = await measure(page);

      await expect(page.getByRole("link", { name: "Order for pickup here" })
        .filter({ visible: true })).toHaveCount(0);
      expect(after.height, "the document's height").toBeLessThanOrEqual(
        before.height);
      expect(after.footer, "the footer's top").toBeLessThanOrEqual(
        before.footer);
    });
  });
}
