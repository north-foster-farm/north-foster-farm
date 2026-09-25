// The about page as #144 lands it, and the video shortcode it brings:
// a silent clip that plays on screen unless autoplay is off.
// docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

// The overlap, in square pixels, of two boxes.
const overlap = (a, b) => Math.max(0,
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const clip = (page) => {
  const frame = page.locator("[data-video]").first();

  return {
    frame,
    video: frame.locator("video"),
    toggle: frame.locator("[data-video-toggle]"),
  };
};

// Scrolls the clip to the middle of the window and gives it a moment.
const onScreen = async (page, frame) => {
  await frame.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(1_500);
};

const playing = (video) => video.evaluate(
  (v) => !v.paused && v.currentTime > 0
);

test.describe("about (#144)", () => {
  test("the rule under How we raise them stops short of Linus",
    async ({ page }) => {
      await page.goto("/about/");
      await page.locator("figure.figure-egg img").evaluate(
        (img) => img.decode()
      );

      for (const width of [1500, 990, 575, 390]) {
        await page.setViewportSize({ width, height: 900 });

        const heading = await page.locator("#how-we-raise-them")
          .boundingBox();
        const linus = await page.locator("figure.figure-egg").boundingBox();

        expect(overlap(heading, linus), `${width}px`).toBe(0);
      }
    });

  test("What we sell opens with pasture, then the clip", async ({ page }) => {
    await page.goto("/about/");

    const after = await page.locator("#what-we-sell").evaluate((h2) => {
      const p = h2.nextElementSibling;
      const figure = p.nextElementSibling;

      return {
        p: p.textContent.trim(),
        figure: figure.matches("figure.video-figure"),
        caption: figure.querySelector("figcaption").textContent.trim(),
      };
    });

    expect(after.p).toMatch(/^We raise a premium chicken/);
    expect(after.p).toContain("pasture");
    expect(after.figure).toBe(true);
    expect(after.caption)
      .toBe("We work closely with Mother Nature; sometimes we don’t agree.");
  });

  test("the clip has a poster, a label and both encodes",
    async ({ page, request }) => {
      await page.goto("/about/");

      const { video, toggle } = clip(page);

      // The scene names the figure, so it is read before the caption
      // and its joke; the video itself is hidden, its button is not.
      await expect(video.locator("xpath=ancestor::figure[1]"))
        .toHaveAttribute("aria-label", /^Rain falls .*low chicken pen/);
      await expect(video).toHaveAttribute("aria-hidden", "true");
      for (const attr of ["muted", "loop", "playsinline"]) {
        expect(await video.evaluate((v, a) => v.hasAttribute(a), attr))
          .toBe(true);
      }
      await expect(video).toHaveAttribute("preload", "none");
      await expect(toggle).toHaveAttribute("aria-label", "Play video");

      const urls = await video.evaluate((v) => [
        [v.poster, "image/webp"],
        ...[...v.querySelectorAll("source")].map((s) => [s.src, s.type]),
      ]);

      expect(urls.map(([, type]) => type))
        .toEqual(["image/webp", "video/mp4", "video/webm"]);
      for (const [url, type] of urls) {
        const res = await request.head(url);

        expect(res.status(), url).toBe(200);
        expect(res.headers()["content-type"], url).toBe(type);
      }
    });

  test("the clip plays on screen, and a pause sticks", async ({ page }) => {
    await page.goto("/about/");

    const { frame, video, toggle } = clip(page);

    await onScreen(page, frame);
    await expect.poll(() => playing(video)).toBe(true);
    await expect(frame).toHaveAttribute("data-playing", "true");
    await expect(toggle).toHaveAttribute("aria-label", "Pause video");

    await toggle.click();
    await expect(frame).toHaveAttribute("data-playing", "false");
    await expect(toggle).toHaveAttribute("aria-label", "Play video");
    await expect(toggle).toHaveCSS("opacity", "1");

    // Away and back: still paused.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await onScreen(page, frame);
    expect(await video.evaluate((v) => v.paused)).toBe(true);
  });

  for (const [how, setup] of [
    ["reduced motion", (page) => page.emulateMedia({
      reducedMotion: "reduce",
    })],
    ["autoplay turned off", (page) => page.addInitScript(() => {
      localStorage.setItem("nff:autoplay", "off");
    })],
  ]) {
    test(`with ${how} the clip waits for play`, async ({ page }) => {
      await setup(page);
      await page.goto("/about/");

      const { frame, video, toggle } = clip(page);

      await onScreen(page, frame);
      expect(await video.evaluate((v) => v.paused)).toBe(true);
      await expect(frame).toHaveAttribute("data-playing", "false");
      await expect(toggle).toHaveCSS("opacity", "1");

      await toggle.click();
      await expect.poll(() => playing(video)).toBe(true);
    });
  }
});
