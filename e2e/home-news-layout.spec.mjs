// Criteria tests for #914 (Home page news previews: layout by width,
// new default image, button and eyebrow), the boxes measured in the
// browser. One test per box, named for it: boxes 1, 2, 3, 4, 7 and 9.
// Boxes 5, 6 and 8, the image and the words, are read off the built
// HTML in test/home-news-copy.criteria.mjs; box 10 is James's look.
// Positions are compared with each other and with the page container,
// never with pixel values.
//
// The desktop project measures every width a box names; the phone
// project (390 px) measures box 9 at its own width.
//
// Provisional, on the readings the issue asks James to confirm:
// - box 4 reads the hover shadow as "every thumbnail takes the
//   stronger shadow the default one shows", so it holds every
//   thumbnail's hover shadow to the default thumbnail's own (the
//   farm's mark today, the new image after), and none to no shadow;
// - box 7 reads "More from the farm" and "All news and updates" as
//   one button, the one under the previews;
// - box 9 is the "Learn more" eyebrow over "Farm news and updates"
//   only; the other bands' eyebrows are not checked.
//
// Held out of every run by its name until the change lands: renamed
// to home-news-layout.spec.mjs and added to e2e/dispatch.json beside
// home-news.spec.mjs.
//
// The seam, what the tests rely on:
// - The band is `.home-update`, its page container the `.container`
//   inside it, and the featured post the `.home-update-card`.
// - Each preview is an element marked `data-news-preview`, holding
//   its thumbnail (`.news-thumb`), its title (the heading in it) and
//   its date (`time`).
// - The button is the band's link named "All news and updates", and
//   the previews sit in `.home-news-previews`.
// - The bar is the element just before the band's h2, and draws its
//   color as its background; the header's green bar is `.site-stripe`.

import { expect, test } from "./support/order.mjs";

const BUTTON = "All news and updates";
const EASE = 400;

// The default thumbnail, a post's with no picture of its own: the
// farm's mark today, the image made from farm-news-default after.
const DEFAULT = ".news-mark, img[src*='farm-news-default']";

const desktopOnly = (info) => test.skip(info.project.name !== "desktop",
  "the desktop project measures the widths the box names");

const open = async (page, width) => {
  if (width) await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.waitForLoadState("load");

  const band = page.locator(".home-update");

  await band.scrollIntoViewIfNeeded();

  return band;
};

const rect = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    width: r.width, height: r.height };
});

const previewsOf = (band) => band.locator("[data-news-preview]")
  .filter({ visible: true });

// A preview's parts: the thumbnail, the title and the date, and the
// box around the title and date together.
const parts = (preview) => preview.evaluate((el) => {
  const box = (node) => {
    const r = node.getBoundingClientRect();

    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: r.width, height: r.height };
  };
  const thumb = box(el.querySelector(".news-thumb"));
  const titleEl = el.querySelector("h1, h2, h3, h4, h5, h6");
  const dateEl = el.querySelector("time");
  const title = box(titleEl);
  const date = box(dateEl);

  return {
    thumb, title, date,
    text: { left: Math.min(title.left, date.left),
      right: Math.max(title.right, date.right),
      top: Math.min(title.top, date.top),
      bottom: Math.max(title.bottom, date.bottom) },
    titleSize: parseFloat(getComputedStyle(titleEl).fontSize),
    dateSize: parseFloat(getComputedStyle(dateEl).fontSize),
    dateClipped: dateEl.scrollWidth > dateEl.clientWidth + 1,
  };
});

test.describe("home news previews by width (#914)", () => {
  test("In the two-column layout the featured post's right edge sits on "
    + "the page container's right edge, at every width that shows two "
    + "columns", async ({ page }, info) => {
    desktopOnly(info);
    for (const width of [1200, 1400, 1920]) {
      const band = await open(page, width);
      const card = await rect(band.locator(".home-update-card"));
      const edge = await band.locator(".container").first()
        .evaluate((el) => el.getBoundingClientRect().right
          - parseFloat(getComputedStyle(el).paddingRight));
      const previews = await previewsOf(band).all();
      const first = await rect(previews[0]);

      expect(first.right, `${width} px: two columns, the previews left`)
        .toBeLessThanOrEqual(card.left + 1);
      expect(Math.abs(card.right - edge),
        `${width} px: the card's right edge on the container's`)
        .toBeLessThanOrEqual(1);
    }
  });

  test("From 992 to 1199 px the three thumbnails sit in one row, each "
    + "with its title below it and its date in smaller text that fits "
    + "under the image", async ({ page }, info) => {
    desktopOnly(info);

    await page.goto("/news/");

    const listed = parseFloat(await page.locator(".news-item .news-date")
      .first().evaluate((el) => getComputedStyle(el).fontSize));

    for (const width of [992, 1100, 1199]) {
      const band = await open(page, width);
      const previews = await previewsOf(band).all();

      expect(previews, `${width} px: three previews`).toHaveLength(3);

      const all = [];

      for (const preview of previews) all.push(await parts(preview));

      all.slice(1).forEach((p, i) => {
        expect(Math.abs(p.thumb.top - all[i].thumb.top),
          `${width} px: the thumbnails' tops in line`)
          .toBeLessThanOrEqual(1);
        expect(p.thumb.left, `${width} px: side by side, left to right`)
          .toBeGreaterThanOrEqual(all[i].thumb.right - 1);
      });
      for (const p of all) {
        expect(p.title.top, `${width} px: the title below its thumbnail`)
          .toBeGreaterThanOrEqual(p.thumb.bottom - 1);
        expect(p.date.top, `${width} px: the date below the title`)
          .toBeGreaterThanOrEqual(p.title.bottom - 1);
        for (const [name, b] of [["title", p.title], ["date", p.date]]) {
          expect(b.left, `${width} px: the ${name} under its image`)
            .toBeGreaterThanOrEqual(p.thumb.left - 1);
          expect(b.right, `${width} px: the ${name} under its image`)
            .toBeLessThanOrEqual(p.thumb.right + 1);
        }
        expect(p.dateSize, `${width} px: the date smaller than the `
          + "news page's").toBeLessThan(listed);
        expect(p.dateClipped, `${width} px: the date not cut off`)
          .toBe(false);
      }
    }
  });

  test("Below 992 px each preview is its thumbnail on the left and its "
    + "text on the right, the two centered on each other vertically",
  async ({ page }, info) => {
    desktopOnly(info);
    for (const width of [390, 768]) {
      const band = await open(page, width);
      const previews = await previewsOf(band).all();

      expect(previews.length, `${width} px: the previews show`)
        .toBeGreaterThan(0);
      for (const preview of previews) {
        const p = await parts(preview);
        const middle = (b) => (b.top + b.bottom) / 2;

        expect(p.thumb.right, `${width} px: the thumbnail left of the text`)
          .toBeLessThanOrEqual(p.text.left + 1);
        expect(Math.abs(middle(p.thumb) - middle(p.text)),
          `${width} px: the thumbnail and text centered on each other`)
          .toBeLessThanOrEqual(1.5);
      }
    }
  });

  test("Every thumbnail takes the same hover shadow, the stronger one "
    + "the default thumbnail shows today", async ({ page }, info) => {
    desktopOnly(info);

    const band = await open(page, 1400);
    const previews = await previewsOf(band).all();

    expect(previews.length, "the previews show").toBeGreaterThan(0);

    const shadows = [];

    for (const preview of previews) {
      const thumb = preview.locator(".news-thumb");

      await thumb.hover();
      await page.waitForTimeout(EASE);
      shadows.push({
        isDefault: await thumb.locator(DEFAULT).count() > 0,
        shadow: await thumb.evaluate((el) => getComputedStyle(el).boxShadow),
      });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(EASE);
    }

    const standard = shadows.find((s) => s.isDefault);

    expect(standard, "a preview with the default thumbnail").toBeTruthy();
    expect(standard.shadow, "the default thumbnail lifts").not.toBe("none");
    shadows.forEach((s, i) => {
      expect(s.shadow, `preview ${i + 1}'s hover shadow, the default's`)
        .toBe(standard.shadow);
    });
  });

  test("The button is centered below 1200 px and left-aligned from "
    + "1200 px up", async ({ page }, info) => {
    desktopOnly(info);
    for (const width of [576, 768, 992, 1199, 1200, 1400]) {
      const band = await open(page, width);
      const button = await rect(band.getByRole("link", { name: BUTTON }));
      const stack = await rect(band.locator(".home-news-previews"));

      if (width < 1200) {
        const off = (button.left + button.right) / 2
          - (stack.left + stack.right) / 2;

        expect(Math.abs(off), `${width} px: centered under the previews`)
          .toBeLessThanOrEqual(1);
      } else {
        expect(Math.abs(button.left - stack.left),
          `${width} px: on the previews' left edge`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("In place of the Learn more eyebrow the section shows a short, "
    + "fairly thick horizontal bar in the color of the green bar below "
    + "the header; it is decorative and hidden from screen readers",
  async ({ page }) => {
    const band = await open(page);
    const heading = band.getByRole("heading", { level: 2,
      name: "Farm news and updates" });

    await expect(band.getByText("Learn more", { exact: true }))
      .toHaveCount(0);

    const stripe = await page.locator(".site-stripe").first()
      .evaluate((el) => ({
        color: getComputedStyle(el).backgroundColor,
        height: el.getBoundingClientRect().height,
      }));
    const title = await rect(heading);
    const bar = await heading.evaluate((h) => {
      const el = h.previousElementSibling;

      if (!el) return null;

      const r = el.getBoundingClientRect();

      return {
        text: el.textContent.trim(),
        hidden: Boolean(el.closest("[aria-hidden='true']")),
        color: getComputedStyle(el).backgroundColor,
        width: r.width,
        height: r.height,
        bottom: r.bottom,
      };
    });

    expect(bar, "an element before the heading").not.toBeNull();
    expect(bar.text, "no words in it").toBe("");
    expect(bar.hidden, "hidden from screen readers").toBe(true);
    expect(bar.color, "the header bar's green").toBe(stripe.color);
    expect(bar.height, "at least as thick as the header's bar")
      .toBeGreaterThanOrEqual(stripe.height);
    expect(bar.width, "horizontal").toBeGreaterThan(bar.height * 2);
    expect(bar.width, "short, beside the heading's width")
      .toBeLessThan(title.width);
    expect(bar.bottom, "above the heading")
      .toBeLessThanOrEqual(title.top + 1);
  });
});
