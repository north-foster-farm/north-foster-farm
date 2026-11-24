// Criteria tests for #673 (A market's address is cut off on the home
// page on a phone), one per tested box, and one for the spec's rule on
// where an address may wrap. #340 and #348 set each address line not
// to wrap inside ("164 Danielson / Pike" broke mid-street), so a long
// line ran past the block's edge at 390 px and was clipped there.
// Held out of every run by its name until the change lands: renamed to
// market-address.spec.mjs, the phone widths run in the phone project
// and 768 px and up in the desktop project; each test skips itself in
// the other.
//
// The clock is set to a day every market but the winter one runs, so
// the home page's band shows all three (the band is hidden while only
// the winter market runs; #544, #568).
//
// The seam, what the tests rely on:
// - On the home page each market is a visible `.place` in
//   `[data-season-band]`, its address in `.place-where`.
// - On /about/ each market is a `.market`, its address the link to
//   Google Maps.
// - An address reads its venue (when the place has one), then
//   "street, town, state ZIP" from data/locations.json.
// Each word is measured on its own, so a line that runs past the
// block's edge is caught even where the block clips it.

import locationData from "../data/locations.json" with { type: "json" };
import seriesData from "../data/series.json" with { type: "json" };
import { expect, test } from "./support/order.mjs";

const PHONES = [320, 375, 390];
const WIDE = [768, 1024, 1500];
const HEIGHT = 800;

const markets = seriesData.series.filter((s) => s.kind === "market");
const streets = markets.map((m) => {
  const p = locationData.locations.find((l) => l.code === m.location);

  return `${p.street}, ${p.city}, ${p.state} ${p.zip}`;
});

// Noon farm time on the first day every summer market runs.
const SUMMER = (() => {
  const runs = markets.filter((m) => !m.winter);
  const from = runs.map((m) => m.start).sort().at(-1);
  const until = runs.map((m) => m.end).sort()[0];

  if (from > until) throw new Error("no day runs every summer market");

  return new Date(`${from}T16:00:00Z`);
})();

const flat = (s) => s.replace(/\s+/g, " ").trim();

// Every address on the page: its words, each with its box, the lines
// they fall on, and the box of the market that holds it.
const addresses = (page, item, address) => page.locator(item)
  .evaluateAll((els, sel) => els
    .filter((el) => el.checkVisibility())
    .map((el) => {
      const where = el.querySelector(sel);
      const walker = document.createTreeWalker(where,
        NodeFilter.SHOW_TEXT);
      const words = [];

      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (const m of n.data.matchAll(/\S+/g)) {
          const range = document.createRange();

          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);

          const r = range.getClientRects()[0];

          if (r) {
            words.push({ text: m[0], top: r.top, left: r.left,
              right: r.right });
          }
        }
      }

      const lines = [];

      for (const w of words) {
        const line = lines.at(-1);

        if (line && Math.abs(line.top - w.top) <= 2) line.words.push(w);
        else lines.push({ top: w.top, words: [w] });
      }

      const box = el.getBoundingClientRect();

      return {
        name: el.querySelector(".place-name, strong")?.textContent.trim(),
        box: { left: box.left, right: box.right },
        view: document.documentElement.clientWidth,
        words,
        lines: lines.map((l) => l.words.map((w) => w.text).join(" ")),
      };
    }), address);

// The words of an address that the block or the screen cuts off.
const clipped = (a) => a.words.filter((w) => w.left < a.box.left - 0.5 ||
  w.right > a.box.right + 0.5 || w.left < 0 || w.right > a.view + 0.5)
  .map((w) => w.text);

const home = (page) => addresses(page, "[data-season-band] .place",
  ".place-where");
const about = (page) => addresses(page, ".markets-list .market",
  "a[href*='google.com/maps']");

const onlyIn = (testInfo, project) => test.skip(
  testInfo.project.name !== project, `runs in the ${project} project`);

test.describe("market addresses (#673)", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(SUMMER);
  });

  test("on the home page at 320, 375 and 390 px every market's address "
    + "is fully visible, with no text clipped at the block's edge",
  async ({ page }, testInfo) => {
    onlyIn(testInfo, "phone");
    for (const width of PHONES) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto("/");
      await expect(page.locator("[data-season-band]")).toBeVisible();

      const found = await home(page);

      expect(found.length, `${width} px: the summer markets`)
        .toBe(markets.filter((m) => !m.winter).length);
      for (const a of found) {
        expect(clipped(a), `${width} px, ${a.name}: nothing cut off`)
          .toEqual([]);
      }
    }
  });

  test("at 768 px and up the addresses look as they do today",
    async ({ page }, testInfo) => {
      onlyIn(testInfo, "desktop");
      for (const width of WIDE) {
        await page.setViewportSize({ width, height: HEIGHT });
        await page.goto("/");
        await expect(page.locator("[data-season-band]")).toBeVisible();

        for (const a of await home(page)) {
          const text = flat(a.lines.join(" "));
          const street = streets.find((s) => text.endsWith(s));

          expect(street, `${width} px, ${a.name}: its address`)
            .toBeTruthy();

          const venue = flat(text.slice(0, -street.length));

          expect(a.lines, `${width} px, ${a.name}: the venue, then `
            + "the street, town and ZIP on one line")
            .toEqual(venue ? [venue, street] : [street]);
          expect(clipped(a), `${width} px, ${a.name}: nothing cut off`)
            .toEqual([]);
        }
      }
    });

  test("/about/'s list shows the same check passing at 320 px",
    async ({ page }, testInfo) => {
      onlyIn(testInfo, "phone");
      await page.setViewportSize({ width: 320, height: HEIGHT });
      await page.goto("/about/");

      const found = await about(page);

      expect(found.length, "every market").toBe(markets.length);
      for (const a of found) {
        expect(clipped(a), `${a.name}: nothing cut off`).toEqual([]);
      }
    });

  // From the spec, not a box: it wraps at a sensible place, before the
  // town or before the state and ZIP, never inside the street or town.
  test("an address wraps only before the town or the state and ZIP",
    async ({ page }, testInfo) => {
      onlyIn(testInfo, "phone");
      for (const width of PHONES) {
        await page.setViewportSize({ width, height: HEIGHT });
        await page.goto("/");
        await expect(page.locator("[data-season-band]")).toBeVisible();

        for (const a of await home(page)) {
          const text = flat(a.lines.join(" "));
          const street = streets.find((s) => text.endsWith(s));
          const count = street.split(" ").length;
          const tail = a.words.slice(-count);

          tail.slice(1).forEach((w, i) => {
            if (Math.abs(w.top - tail[i].top) > 2) {
              expect(tail[i].text, `${width} px, ${a.name}: a break `
                + `after "${tail[i].text}"`).toMatch(/,$/);
            }
          });
        }
      }
    });
});
