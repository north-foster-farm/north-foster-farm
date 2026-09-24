// The home page as the home lane lands it. docs/qa-launch.md, "The
// autumn refresh".

import { expect, test } from "./support/order.mjs";

const INVOICE_ERA = /invoice|payment link|pay to confirm/i;

// Buttons ease into their hover over 0.16 s; read them after it.
const EASE = 400;

const look = (locator) => locator.evaluate((el) => {
  const s = getComputedStyle(el);

  return {
    width: el.offsetWidth,
    height: el.offsetHeight,
    color: s.color,
    background: s.backgroundColor,
    border: s.borderTopColor,
    borderWidth: s.borderTopWidth,
    shadow: s.boxShadow,
    padding: [s.paddingLeft, s.paddingRight],
    transition: s.transitionProperty,
  };
});

const hovered = async (page, locator) => {
  await locator.hover();
  await page.waitForTimeout(EASE);

  return look(locator);
};

test.describe("home", () => {
  // James's wording, 2026-09-24 (#150).
  test("How to buy walks four steps without the invoice era",
    async ({ page }) => {
      await page.goto("/");

      const how = page.locator("#how-to-buy");
      const steps = how.locator(".how-step");

      await expect(how.locator(".home-title"))
        .toHaveText("From our pasture to your table");
      await expect(how.locator(".how-step-title")).toHaveText([
        "Step 1: Shop one page",
        "Step 2: Choose your day",
        "Step 3: Make a change",
        "Step 4: Pick up or delivery",
      ]);
      await expect(steps).toHaveCount(4);
      for (const step of await steps.all()) {
        await expect(step.locator(".home-icon svg")).toBeVisible();
      }
      expect(await how.innerText()).not.toMatch(INVOICE_ERA);

      await how.getByRole("link", { name: "Shop all products" }).click();
      await expect(page).toHaveURL(/\/order\/$/);
    });

  // #134: the hero stops growing on a tall screen, sits under a black
  // tint, and on a phone its big line runs three lines, well above the
  // h1. The title never wraps on its own, so it must fit every width.
  test("the hero's height, tint and type (#134)", async ({ page }) => {
    const measure = () => page.evaluate(() => {
      const hero = document.querySelector(".home-hero");
      const title = document.querySelector(".home-hero-title");
      const sub = document.querySelector(".home-hero-sub");
      const text = document.querySelector(".home-hero-text");
      const t = getComputedStyle(title);
      const box = title.getBoundingClientRect();
      // Its words' extent, not the block's.
      const range = document.createRange();

      range.selectNodeContents(title);

      const words = range.getBoundingClientRect();

      return {
        hero: hero.getBoundingClientRect().height,
        header: document.querySelector("header").getBoundingClientRect()
          .height,
        lines: Math.round(box.height / parseFloat(t.lineHeight)),
        title: parseFloat(t.fontSize),
        sub: parseFloat(getComputedStyle(sub).fontSize),
        stroke: parseFloat(getComputedStyle(sub).webkitTextStrokeWidth),
        left: words.left,
        right: words.right,
        room: text.getBoundingClientRect(),
        filter: getComputedStyle(document.querySelector(".home-hero-img"))
          .filter,
        wordmark: getComputedStyle(document.querySelector("header .black"))
          .fill,
        primary: getComputedStyle(document.body)
          .getPropertyValue("--bs-primary").trim(),
      };
    });

    await page.goto("/");

    for (const [width, height, lines] of [
      [320, 568, 3], [390, 664, 3], [575, 800, 3], [576, 800, 2],
      [768, 900, 2], [990, 900, 2], [1500, 900, 2], [2560, 1600, 2],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);

      const m = await measure();
      const at = `${width}px`;

      expect(m.lines, `${at} title lines`).toBe(lines);
      expect(m.left, `${at} title inside the window`)
        .toBeGreaterThanOrEqual(0);
      expect(m.right, `${at} title inside the window`)
        .toBeLessThanOrEqual(width);
      expect(m.right, `${at} title inside its column`)
        .toBeLessThanOrEqual(m.room.right + 1);
      expect(m.hero, `${at} hero height`).toBeLessThanOrEqual(1300);
      if (width < 576) {
        expect(m.title / m.sub, `${at} big line over the h1`)
          .toBeGreaterThanOrEqual(1.8);
      }
      if (width >= 768) {
        expect(m.stroke, `${at} h1 stroke`).toBeGreaterThanOrEqual(2.5);
      }
      expect(m.filter).toBe("brightness(0.82)");
    }

    const m = await measure();

    // The wordmark in the primary green, however the browser spells it.
    const rgb = await page.evaluate((c) => {
      const el = document.createElement("i");

      el.style.color = c;
      document.body.append(el);

      const out = getComputedStyle(el).color;

      el.remove();

      return out;
    }, m.primary);

    expect(m.wordmark).toBe(rgb);
  });

  // #133: the coop clip plays behind the hero over its photograph, and
  // a pause offers to stop every video on the site playing by itself.
  test.describe("hero video (#133)", () => {
    const hero = (page) => {
      const root = page.locator("[data-hero-video]");

      return {
        root,
        img: root.locator(".home-hero-img"),
        video: root.locator("video"),
        toggle: root.locator("[data-hero-toggle]"),
        note: root.locator("[data-hero-note]"),
      };
    };

    // Every request for the hero's clip, with when it was made.
    const clipRequests = (page) => {
      const seen = [];

      page.on("request", (req) => {
        if (req.url().includes("/videos/opening-the-coop")) {
          seen.push({ url: req.url(), at: Date.now() });
        }
      });

      return seen;
    };

    const playing = (video) => video.evaluate(
      (v) => !v.paused && v.currentTime > 0
    );

    test("the photograph paints first, then the light clip plays over it",
      async ({ page }) => {
        const clips = clipRequests(page);
        let posterAt = 0;

        page.on("response", (res) => {
          if (/opening-the-coop.*\.(webp|jpg)/.test(res.url()) && !posterAt) {
            posterAt = Date.now();
          }
        });
        await page.goto("/");

        const h = hero(page);

        for (const attr of ["muted", "loop", "playsinline"]) {
          expect(await h.video.evaluate((v, a) => v.hasAttribute(a), attr),
            attr).toBe(true);
        }
        await expect.poll(() => playing(h.video)).toBe(true);
        await expect(h.root).toHaveClass(/\bis-ready\b/);
        await expect(h.root).toHaveAttribute("data-playing", "true");
        await expect(h.img).toBeVisible();

        expect(posterAt, "the photograph was fetched").toBeGreaterThan(0);
        expect(clips.length, "the clip was fetched").toBeGreaterThan(0);
        expect(clips[0].at, "no clip before the photograph")
          .toBeGreaterThanOrEqual(posterAt);

        const src = await h.video.evaluate((v) => v.currentSrc);
        const size = Number((await page.request.head(src))
          .headers()["content-length"]);

        expect(size, `${src} under 1.5 MB`).toBeLessThan(1.5 * 1024 * 1024);
      });

    test("a pause offers to stop autoplay, and the choice holds site-wide",
      async ({ page, isMobile }) => {
        await page.goto("/");

        const h = hero(page);

        await expect.poll(() => playing(h.video)).toBe(true);
        if (!isMobile) {
          await h.root.hover();
          await page.waitForTimeout(400);
          await expect(h.toggle).toHaveCSS("opacity", "1");
        }
        await expect(h.toggle).toHaveAttribute("aria-label", "Pause video");
        await h.toggle.click();
        await expect(h.root).toHaveAttribute("data-playing", "false");
        await expect(h.toggle).toHaveAttribute("aria-label", "Play video");
        const offer = h.note.locator("[data-hero-offer]");
        const done = h.note.locator("[data-hero-done]");

        await expect(h.note).toBeVisible();
        await expect(offer).toBeVisible();
        await expect(offer).toHaveText(
          "Stop videos playing on their own? Turn off autoplay"
        );
        await expect(done).toBeHidden();

        await offer.getByRole("button", { name: "Turn off autoplay" })
          .click();
        await expect(offer).toBeHidden();
        await expect(done).toBeVisible();
        await expect(done).toHaveText(
          "Videos here will wait for you to press play."
        );
        expect(await page.evaluate(() => localStorage.getItem("nff:autoplay")))
          .toBe("off");

        // After a reload the photograph stays and nothing is fetched.
        const clips = clipRequests(page);

        await page.reload();
        await page.waitForTimeout(2_000);
        expect(clips, "no clip fetched with autoplay off").toHaveLength(0);
        await expect(h.root).not.toHaveClass(/\bis-ready\b/);
        await expect(h.img).toBeVisible();
        await expect(h.toggle).toBeVisible();
        await expect(h.toggle).toHaveCSS("opacity", "1");

        // A pause now offers nothing: there is nothing left to turn off.
        await h.toggle.click();
        await expect.poll(() => playing(h.video)).toBe(true);
        await h.toggle.click();
        await expect(h.note).toBeHidden();

        // The about page's clip follows the same choice.
        await page.goto("/about/");

        const clip = page.locator("[data-video]").first();

        await clip.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(1_500);
        expect(await clip.locator("video").evaluate((v) => v.paused))
          .toBe(true);
      });

    test("the play button can be reached by keyboard", async ({ page }) => {
      test.skip(!!test.info().project.use.isMobile, "no keyboard");
      await page.goto("/");

      const h = hero(page);

      await expect.poll(() => playing(h.video)).toBe(true);
      await h.toggle.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(h.toggle).toBeFocused();
      await expect(h.toggle).toHaveCSS("opacity", "1");
      await page.keyboard.press("Enter");
      await expect(h.root).toHaveAttribute("data-playing", "false");
    });

    test("with reduced motion the photograph stays until play",
      async ({ page }) => {
        const clips = clipRequests(page);

        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");

        const h = hero(page);

        await page.waitForTimeout(2_000);
        expect(clips).toHaveLength(0);
        await expect(h.root).toHaveAttribute("data-playing", "false");
        await expect(h.toggle).toBeVisible();
        await expect(h.toggle).toHaveAttribute("aria-label", "Play video");

        await h.toggle.click();
        await expect.poll(() => playing(h.video)).toBe(true);
        // Nothing to offer where videos already wait to be played.
        await h.toggle.click();
        await expect(h.note).toBeHidden();
      });
  });

  // #137: outside market season (May 15 to September 15, decided at
  // build time) the market band gives way to the three ways to buy,
  // every fact from data/delivery.json.
  test.describe("off-season band (#137)", () => {
    const WAYS = [
      {
        method: "onfarm", name: "On-farm pickup",
        when: "Select weekdays, by appointment",
        where: "99 East Killingly Road, Foster, RI 02825",
        cost: "No minimum, no fee", cta: "Shop for pickup",
      },
      {
        method: "scituate", name: "Scituate drop site",
        when: /^Saturdays, 10:00 – 11:00 AM(, starting October 17)?$/,
        where: "Village Green, 46 Institute Lane, North Scituate, RI 02857",
        cost: "No minimum, no fee", cta: "Shop for the drop site",
      },
      {
        method: "delivery", name: "Delivery",
        when: "Every Thursday, 10:00 AM – 4:00 PM",
        where: "Most of central Rhode Island and parts of eastern " +
          "Connecticut",
        cost: "$40 minimum, $5 fee", cta: "Shop for delivery",
      },
    ];

    test("three ways to buy, in the market band's place",
      async ({ page }) => {
        await page.goto("/");

        const band = page.locator(".ways");
        const places = band.locator(".place");

        await expect(band.locator(".home-eyebrow")).toHaveText(
          "No off-season"
        );
        await expect(band.locator(".home-title")).toHaveText(
          "Three ways to get your order, all winter"
        );
        await expect(places).toHaveCount(3);
        for (const [i, way] of WAYS.entries()) {
          const place = places.nth(i);

          await expect(place.locator(".place-name")).toHaveText(way.name);
          await expect(place.locator(".home-icon svg")).toBeVisible();
          await expect(place.locator(".place-when")).toHaveText(way.when);
          await expect(place.locator(".place-where")).toHaveText(way.where);
          await expect(place.locator(".place-note")).toHaveText(way.cost);
          await expect(place.getByRole("link")).toHaveText(way.cta);
        }
        await expect(band.locator(".places-note"))
          .toHaveText("The farmers markets return in June.");
      });

    for (const way of WAYS) {
      test(`"${way.cta}" opens the order page with ${way.name} chosen`,
        async ({ page }) => {
          await page.goto("/");
          await page.locator(".ways .place").getByRole("link", {
            name: way.cta,
          }).click();
          await expect(page).toHaveURL(/\/order\//);
          await expect(page.locator("#onfarm-date")).toBeEnabled();
          await expect(page.locator(`#method-${way.method}`)).toBeChecked();
        });
    }
  });

  // The hero reserves the header's height below it so that together
  // they fill the window, up to 80rem, and nothing peeks in under the
  // fold. Production: 69px header from md up, 4.25rem reserved.
  test("the hero and header fill the window exactly", async ({ page }) => {
    await page.goto("/");

    for (const [width, height] of [
      [390, 664], [767, 900], [768, 900], [1199, 900], [1500, 900],
      [1500, 1300],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);

      const bottom = await page.locator(".home-hero")
        .evaluate((el) => el.getBoundingClientRect().bottom);

      expect(Math.abs(bottom - height), `${width}x${height}: the hero ` +
        "ends at the window's bottom edge").toBeLessThanOrEqual(1);
    }
  });

  // #135: hover is a button's strongest moment, the shadows are a
  // little softer, and only phones get the wide button. Hover needs a
  // mouse, so these run in the desktop project and set their widths.
  test.describe("buttons (#135)", () => {
    test.skip(({ isMobile }) => isMobile, "hover needs a mouse");

    test("Order now stays pure white on hover and lifts",
      async ({ page }) => {
        await page.goto("/");

        const button = page.locator(".btn-hero").first();
        const rest = await look(button);
        const hover = await hovered(page, button);

        expect(hover.background).toBe("rgb(255, 255, 255)");
        expect(hover.border).toBe("rgb(255, 255, 255)");
        expect(hover.color).toBe(rest.color);
        expect(hover.shadow).not.toBe("none");
        expect(hover.shadow).not.toBe(rest.shadow);
      });

    test("header links ease in a gray border without changing size",
      async ({ page }) => {
        const shop = page.locator("#how-to-buy .how-cta .btn");
        const links = [
          [1500, page.locator("header .site-nav-link:visible").first()],
          [390, page.locator("header .site-toggle")],
        ];

        await page.goto("/");

        const lift = (await hovered(page, shop)).shadow;

        for (const [width, link] of links) {
          await page.setViewportSize({ width, height: 900 });
          await page.mouse.move(0, 0);
          await page.waitForTimeout(EASE);

          const rest = await look(link);
          const hover = await hovered(page, link);

          expect(rest.border, `${width}px at rest`)
            .toBe("rgba(0, 0, 0, 0)");
          expect(hover.border, `${width}px on hover`)
            .not.toBe("rgba(0, 0, 0, 0)");
          expect(hover.borderWidth).toBe(rest.borderWidth);
          expect([hover.width, hover.height], `${width}px size`)
            .toEqual([rest.width, rest.height]);
          expect(rest.transition).toContain("border-color");
          expect(hover.shadow, "the shared lift shadow").toBe(lift);
        }
      });

    test("Shop all products is wide on phones only", async ({ page }) => {
      const shop = page.locator("#how-to-buy .how-cta .btn");
      const hero = page.locator(".btn-hero").first();

      await page.goto("/");
      expect((await look(shop)).padding).toEqual((await look(hero)).padding);
      // As wide as its words, not the phone style's 24rem.
      expect((await look(shop)).width).toBeLessThan(384);

      await page.setViewportSize({ width: 390, height: 664 });

      const container = await page.locator("#how-to-buy .container")
        .evaluate((el) => {
          const s = getComputedStyle(el);

          return el.clientWidth - parseFloat(s.paddingLeft) -
            parseFloat(s.paddingRight);
        });

      expect(Math.abs((await look(shop)).width - container))
        .toBeLessThanOrEqual(1);
    });
  });
});
