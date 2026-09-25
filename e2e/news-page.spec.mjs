// The news list (#143): posts under a heading per year, a picture or
// a leaf card on each, ten a page, the next page appended as the
// reader nears the end, and the pager for anyone without scripts.
// Captions sit plainly under framed photos (83de703).
// docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

const items = (page) => page.locator("[data-news-years] .news-item");

const hrefs = (page) => items(page).evaluateAll((els) => els.map(
  (el) => new URL(el.querySelector(".news-item-title a").href).pathname
));

// Every post, in order, by walking the pager with scripts off.
const byPager = async (browser, baseURL) => {
  const context = await browser.newContext({
    baseURL, javaScriptEnabled: false,
  });
  const page = await context.newPage();
  const all = [];
  let pages = 0;

  await page.goto("/news/");
  for (;;) {
    pages += 1;
    all.push(...await hrefs(page));

    const older = page.locator("[data-news-next]");

    if (!await older.count()) break;
    await older.click();
  }
  await context.close();

  return { all, pages };
};

test.describe("news page (#143)", () => {
  test("without scripts, the pager walks every post, ten a page",
    async ({ browser, baseURL }) => {
      const { all, pages } = await byPager(browser, baseURL);

      expect(pages).toBeGreaterThan(1);
      expect(all.length).toBeGreaterThan(10);
      expect(all.length).toBeLessThanOrEqual(pages * 10);
      expect(new Set(all).size, "no post twice").toBe(all.length);
    });

  test("scrolling loads every post once, one heading per year",
    async ({ page, browser, baseURL }) => {
      const { all } = await byPager(browser, baseURL);
      const failed = [];

      page.on("response", (res) => {
        if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
      });
      await page.goto("/news/");
      await expect(page.locator("[data-news-pager]")).toBeHidden();

      for (let i = 0; i < 20; i += 1) {
        if ((await items(page).count()) >= all.length) break;
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(500);
      }

      expect(await hrefs(page)).toEqual(all);
      await expect(page.locator("[role='status']").filter({
        hasText: /older posts? loaded\./,
      })).toHaveCount(1);

      const years = await page.locator(".news-year").evaluateAll(
        (els) => els.map((el) => el.dataset.year)
      );

      expect(new Set(years).size, "each year once").toBe(years.length);
      expect([...years].sort().reverse()).toEqual(years);
      for (const year of years) {
        await expect(page.locator(`.news-year[data-year='${year}'] h2`))
          .toHaveText(year);
      }

      // Every post's date sits under its own year.
      const misplaced = await page.locator(".news-year").evaluateAll(
        (els) => els.flatMap((el) => [...el.querySelectorAll("time")]
          .filter((t) => !t.dateTime.startsWith(el.dataset.year))
          .map((t) => t.dateTime))
      );

      expect(misplaced).toEqual([]);
      expect(failed, "nothing the appended posts ask for is missing")
        .toEqual([]);
    });

  test("a failed fetch brings the pager back, pointing at that page",
    async ({ page }) => {
      await page.route("**/news/page/2/", (route) => route.fulfill({
        status: 500, body: "",
      }));
      await page.goto("/news/");

      const pager = page.locator("[data-news-pager]");

      await page.mouse.wheel(0, 20_000);
      await expect(pager).toBeVisible();
      await expect(pager.locator("[data-news-next]"))
        .toHaveAttribute("href", /\/news\/page\/2\/$/);
      await expect(items(page)).toHaveCount(10);
    });

  test("each post has a picture or a leaf, and a leaf stays put",
    async ({ page }) => {
      const leaves = async () => {
        await page.goto("/news/");

        return items(page).evaluateAll((els) => els.map((el) => ({
          href: el.querySelector(".news-item-title a").getAttribute("href"),
          img: !!el.querySelector(".news-thumb img"),
          leaf: el.querySelector(".news-leaf svg")?.outerHTML || null,
        })));
      };
      const first = await leaves();

      for (const post of first) {
        expect(post.img || !!post.leaf, post.href).toBe(true);
      }
      expect(first.some((p) => p.img), "some posts have pictures")
        .toBe(true);
      expect(first.some((p) => p.leaf), "some posts have leaves")
        .toBe(true);
      expect(await leaves()).toEqual(first);

      // Pictures are 4:3 and load.
      for (const img of await page.locator(".news-thumb img").all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate(
          (el) => el.complete && el.naturalWidth > 0
        )).toBe(true);

        const ratio = await img.evaluate(
          (el) => el.naturalWidth / el.naturalHeight
        );

        expect(Math.abs(ratio - 4 / 3)).toBeLessThan(0.02);
      }
    });

  test("captions sit plainly under framed photos", async ({ page }) => {
    for (const path of ["/about/", "/news/2026-09-22-september-update/"]) {
      await page.goto(path);

      const captions = page.locator("main figcaption");

      expect(await captions.count(), path).toBeGreaterThan(0);
      for (const caption of await captions.all()) {
        await expect(caption, path).toHaveCSS(
          "background-color", "rgba(0, 0, 0, 0)"
        );
      }
    }
  });
});
