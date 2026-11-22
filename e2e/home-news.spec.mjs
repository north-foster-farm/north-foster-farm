// Criteria test for #566 (Home news: preview the second and third most
// recent posts as thumbnails), box 1. James's layout (2026-11-21): at
// desktop width the left column holds the eyebrow, the heading, a
// stack of thumbnails of the posts after the latest, then "More from
// the farm" (the site's outline button) under them; the right column
// is the latest post's excerpt card, as now. At phone width the latest
// post leads and the thumbnails follow it. Which posts fill the three
// places, and that drafts and future posts never do, is box 2's test,
// test/home-news.criteria.mjs: this build has drafts in it.
// Held out of every run by its name until the change lands: renamed to
// home-news.spec.mjs, it runs in the desktop (1500 px) and phone
// (390 px) projects.
//
// The seam, what the test relies on:
// - Each preview is an element marked `data-news-preview` inside
//   `.home-update`, holding a link to the post, the post's title as
//   that link's text, a `time[datetime]` with the post's date, and the
//   post's featured image (an `img`), or the farm's mark
//   (`.news-mark`) for a post with none, as the news page's rows do.
// - The lead stays `.home-update-card`, its title link
//   `.news-header-link` and its date `.news-header time`.
// - The section has one "More from the farm" link.

import { expect, test } from "./support/order.mjs";

const MORE = "More from the farm";
const LG = 992;

const box = (locator) => locator.boundingBox();

// A preview as the reader gets it: where its link goes, its title, its
// date, and whether its picture has loaded.
const read = (preview) => preview.evaluate((el) => {
  const link = el.querySelector("a[href]");
  const img = el.querySelector("img");

  return {
    path: link && new URL(link.href).pathname,
    title: [...el.querySelectorAll("a[href]")]
      .map((a) => a.textContent.trim()).find(Boolean) || "",
    date: el.querySelector("time")?.getAttribute("datetime") || "",
    picture: img ? img.complete && img.naturalWidth > 0
      : Boolean(el.querySelector(".news-mark svg")),
  };
});

test.describe("home news previews (#566)", () => {
  test("the latest post's excerpt plus thumbnails of the next three "
    + "posts, each linking to its post, in the left column under the "
    + "heading with More from the farm below them wide, after the "
    + "latest post narrow", async ({ page }) => {
    await page.goto("/");

    const band = page.locator(".home-update");
    const card = band.locator(".home-update-card");
    const previews = band.locator("[data-news-preview]")
      .filter({ visible: true });
    const more = band.getByRole("link", { name: MORE });

    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: /^Continue reading/ }))
      .toBeVisible();
    await expect(previews).toHaveCount(3);
    await expect(more).toHaveCount(1);
    await expect(more).toHaveClass(/btn-outline-primary/);
    await expect(more).toHaveJSProperty("pathname", "/news/");

    const lead = {
      path: await card.locator(".news-header-link")
        .evaluate((a) => new URL(a.href).pathname),
      date: await card.locator(".news-header time")
        .getAttribute("datetime"),
    };
    const shown = [];

    for (const preview of await previews.all()) {
      await preview.scrollIntoViewIfNeeded();
      await expect.poll(async () => (await read(preview)).picture,
        { message: "the preview's picture shows" }).toBe(true);
      shown.push(await read(preview));
    }

    const paths = shown.map((p) => p.path);

    expect(new Set(paths).size, "three different posts").toBe(3);
    expect(paths, "not the lead again").not.toContain(lead.path);
    for (const p of shown) {
      expect(p.path, "a link to a post").toMatch(/^\/news\/[^/]+\/$/);
      expect(p.title, "the post's title").not.toBe("");
      expect(p.date, "the post's date").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.date <= lead.date, "older than the lead").toBe(true);
    }
    expect(shown.map((p) => p.date), "newest first")
      .toEqual(shown.map((p) => p.date).sort().reverse());

    // Each preview's title and date are its post's own.
    for (const p of shown) {
      const post = await page.context().newPage();

      await post.goto(p.path);
      await expect(post.locator("h1")).toHaveText(p.title);
      await expect(post.locator(".news-header time"))
        .toHaveAttribute("datetime", p.date);
      await post.close();
    }

    await page.evaluate(() => window.scrollTo(0, 0));

    const heading = await box(band.getByRole("heading", { level: 2,
      name: "Farm news and updates" }));
    const leadBox = await box(card);
    const boxes = [];

    for (const preview of await previews.all()) {
      boxes.push(await box(preview));
    }

    const button = await box(more);
    const last = boxes.at(-1);

    boxes.slice(1).forEach((b, i) => {
      expect(b.y, "stacked, one under the other")
        .toBeGreaterThanOrEqual(boxes[i].y + boxes[i].height - 1);
    });
    expect(button.y, "More from the farm under the thumbnails")
      .toBeGreaterThanOrEqual(last.y + last.height - 1);

    if (page.viewportSize().width >= LG) {
      for (const b of [...boxes, button]) {
        expect(b.x + b.width, "in the left column, beside the card")
          .toBeLessThanOrEqual(leadBox.x + 1);
        expect(b.y, "under the heading")
          .toBeGreaterThanOrEqual(heading.y + heading.height - 1);
      }
      expect(boxes[0].y, "beside the card, not below it")
        .toBeLessThan(leadBox.y + leadBox.height);
    } else {
      const width = page.viewportSize().width;

      expect(boxes[0].y, "after the latest post")
        .toBeGreaterThanOrEqual(leadBox.y + leadBox.height - 1);
      for (const b of [...boxes, button]) {
        expect(b.x, "inside the screen").toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, "inside the screen")
          .toBeLessThanOrEqual(width);
      }
    }
  });
});
