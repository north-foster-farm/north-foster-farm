// The home page as the home lane lands it. docs/qa-launch.md, "The
// autumn refresh".

import terms from "../data/delivery.json" with { type: "json" };
import { moneyOn } from "../assets/scripts/order/lib/money-on.mjs";
import {
  locationCount, locationsLabel,
} from "../assets/scripts/order/lib/scheduled.mjs";
import { today } from "../assets/scripts/order/lib/zoned.mjs";
import { expect, test } from "./support/order.mjs";

// The delivery figures the build printed, from the same money.html
// rule the page uses (#362): the minimum is $50 from 2027-01-01.
const MONEY = moneyOn(terms.money, today(new Date(), terms.timeZone));

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
  // James's wording and layout, approved in the browser 2026-11-11
  // (#536): four rows, no step numbers.
  test("How to buy shows four rows without the invoice era",
    async ({ page }) => {
      await page.goto("/");

      const how = page.locator("#how-to-buy");
      const steps = how.locator(".how-step");

      await expect(how.locator(".home-eyebrow")).toHaveText("How to buy");
      await expect(how.locator(".home-title"))
        .toHaveText("Shop for premium chicken and fresh eggs online");
      await expect(how.locator(".how-step-title")).toHaveText([
        "Our products",
        "Pickup or delivery?",
        "Flexible by design",
        "Quality you can taste",
      ]);
      await expect(steps).toHaveCount(4);
      await expect(how.locator(".how-step-copy")).toHaveText([
        "Browse what we have in stock, or check out our whole catalog.",
        "Pick up on our farm, at one of our pickup days, or get it "
          + "delivered to your door.",
        "Sign in with your email address and update your order, pickup, "
          + "or delivery.",
        "Be warned: you’ll never want chicken or eggs from the supermarket "
          + "again.",
      ]);
      await expect(how.locator(".how-num")).toHaveCount(0);

      // Phones stack the photo, the rows, the button; wide screens put
      // the photo left of the rows.
      const box = (sel) => how.locator(sel).boundingBox();
      const [photo, rows, cta] = await Promise.all(
        [".how-photo", ".how-steps", ".how-cta"].map(box)
      );
      const wide = (page.viewportSize()?.width ?? 0) >= 992;
      if (wide) {
        expect(photo.x + photo.width).toBeLessThanOrEqual(rows.x);
      } else {
        expect(photo.y + photo.height).toBeLessThanOrEqual(rows.y);
      }
      expect(rows.y + rows.height).toBeLessThanOrEqual(cta.y + 1);
      for (const step of await steps.all()) {
        await expect(step.locator(".home-icon svg")).toBeVisible();
      }
      expect(await how.innerText()).not.toMatch(INVOICE_ERA);

      await how.getByRole("link", { name: "Shop all products" }).click();
      await expect(page).toHaveURL(/\/order\/$/);
    });

  // #134: the hero stops growing on a tall screen, and on a phone its
  // big line runs three lines, well above the h1. The title never
  // wraps on its own, so it must fit every width. #173: the picture is
  // blurred under a wash, and from lg the words sit in the bottom
  // right corner over a dark green wash; below lg they are centred
  // over a black veil (James, 2026-09-25: the green was too heavy).
  test("the hero's height, wash and type (#134, #173)", async ({ page }) => {
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
        titleShadow: t.textShadow,
        subShadow: getComputedStyle(sub).textShadow,
        left: words.left,
        right: words.right,
        room: text.getBoundingClientRect(),
        box: hero.getBoundingClientRect(),
        filter: getComputedStyle(document.querySelector(".home-hero-img"))
          .filter,
        wash: getComputedStyle(document.querySelector(".home-hero-shade"))
          .backgroundImage,
        wordmark: getComputedStyle(document.querySelector("header .black"))
          .fill,
        primary: getComputedStyle(document.body)
          .getPropertyValue("--bs-primary").trim(),
      };
    });

    await page.goto("/");

    // The primary green as r, g, b, however the browser spells it.
    const green = await page.evaluate((c) => {
      const el = document.createElement("i");

      el.style.color = c;
      document.body.append(el);

      const out = getComputedStyle(el).color;

      el.remove();

      return out.match(/\d+/g).slice(0, 3);
    }, (await measure()).primary);
    const titles = {};

    for (const [width, height, lines] of [
      [320, 568, 3], [390, 664, 3], [575, 800, 3], [576, 800, 2],
      [768, 900, 2], [990, 900, 2], [1500, 900, 2], [2560, 1600, 2],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);

      const m = await measure();
      const at = `${width}px`;

      titles[width] = m.title;

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
      // #173: no outlined type; the wash over a blurred picture
      // carries the contrast.
      expect(m.stroke, `${at} no outline`).toBe(0);
      expect(m.filter).toBe("blur(9px)");
      expect(m.wash, `${at} wash`).toMatch(width >= 992
        // The brand green shaded 45% (James, 2026-09-26).
        ? /^linear-gradient\(to left, rgba\(17, 68, 46, 0\.75\) 40%/
        // Black, darkest at the top, on phones (James, 2026-09-26).
        : /^linear-gradient\(rgba\(7, 6, 6, 0\.8\), rgba\(7, 6, 6, 0\.6\) 55%/);
      // Both lines of type on the same soft shadow (James, 2026-09-26).
      expect(m.titleShadow, `${at} title shadow`).toBe(m.subShadow);
      expect(m.titleShadow, `${at} title shadow`).not.toBe("none");

      const middle = (m.room.left + m.room.right) / 2;

      // From 1600px the words grow with the screen and reach further
      // left, but stay clear of the hen in the left third.
      if (width >= 1600) {
        expect(m.room.left, `${at} words clear of the left third`)
          .toBeGreaterThan(width / 3);
      } else if (width >= 992) {
        expect(middle, `${at} words to the right`)
          .toBeGreaterThan(width * 0.6);
      }
      if (width >= 992) {
        expect(m.room.bottom, `${at} words at the foot`)
          .toBeGreaterThan(m.box.top + m.box.height * 0.6);
      } else {
        expect(Math.abs(middle - width / 2), `${at} words centred`)
          .toBeLessThanOrEqual(2);
      }
    }

    // A very wide screen gets bigger words.
    expect(titles[2560], "title bigger at 2560px than at 1500px")
      .toBeGreaterThan(titles[1500] * 1.3);

    // The wordmark in the primary green.
    expect((await measure()).wordmark).toBe(`rgb(${green.join(", ")})`);
  });

  // #133: the coop clip plays behind the hero over its photograph, and
  // a switch beside its button turns autoplay off and on site-wide.
  test.describe("hero video (#133)", () => {
    const hero = (page) => {
      const root = page.locator("[data-hero-video]");

      return {
        root,
        img: root.locator(".home-hero-img"),
        video: root.locator("video"),
        toggle: root.locator("[data-hero-toggle]"),
        autoplay: root.locator("[data-autoplay-switch]"),
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

    // #200: a two-way switch, shown by a press of play or pause, faded
    // with the controls, and always in the page for the keyboard.
    test("the autoplay switch turns it off and on, and holds site-wide",
      async ({ page, isMobile }) => {
        await page.goto("/");

        const h = hero(page);
        const off = { name: "Turn autoplay off for every video on this site" };
        const on = { name: "Turn autoplay on for every video on this site" };

        await expect.poll(() => playing(h.video)).toBe(true);
        if (!isMobile) {
          await h.root.hover();
          await page.waitForTimeout(400);
          await expect(h.toggle).toHaveCSS("opacity", "1");
        }

        // Unseen until play or pause is pressed, but in the page.
        await expect(h.autoplay).toHaveCSS("opacity", "0");
        await expect(page.getByRole("switch", off)).toHaveAttribute(
          "aria-checked", "true"
        );

        await expect(h.toggle).toHaveAttribute("aria-label", "Pause video");
        await h.toggle.click();
        await expect(h.root).toHaveAttribute("data-playing", "false");
        await expect(h.toggle).toHaveAttribute("aria-label", "Play video");
        await expect(h.autoplay).toHaveCSS("opacity", "1");
        await expect(h.autoplay).toHaveText(/^Turn autoplay off/);

        // Pausing changed nothing site-wide.
        expect(await page.evaluate(() => localStorage.getItem("nff:autoplay")))
          .toBe(null);

        await page.getByRole("switch", off).click();
        await expect(page.getByRole("switch", on)).toHaveAttribute(
          "aria-checked", "false"
        );
        expect(await page.evaluate(() => localStorage.getItem("nff:autoplay")))
          .toBe("off");

        // Five seconds idle, it fades with the controls.
        await page.mouse.move(0, 0);
        await page.waitForTimeout(6_500);
        await expect(h.autoplay).toHaveCSS("opacity", "0");

        // After a reload the photograph stays and nothing is fetched.
        const clips = clipRequests(page);

        // Not the whole `load` (#506): on staging at phone width one
        // reload sat 45 s without it. The page has nothing third-party
        // to hold it and no clip until one plays (preload="none", no
        // src), so a slow one of its own files likely held it. What this
        // needs is the hero wired, which the deferred module does
        // before DOMContentLoaded, and its photograph in, which is when
        // hero.js would start the clip: the 2 s from there is the
        // window a clip would be fetched in.
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => h.img.evaluate(
          (img) => img.complete && img.naturalWidth > 0
        ), "the photograph loads").toBe(true);
        await page.waitForTimeout(2_000);
        expect(clips, "no clip fetched with autoplay off").toHaveLength(0);
        await expect(h.root).not.toHaveClass(/\bis-ready\b/);
        await expect(h.img).toBeVisible();
        await expect(h.toggle).toBeVisible();
        await expect(h.toggle).toHaveCSS("opacity", "1");

        // Play shows the switch, still off: playing one clip leaves the
        // preference alone.
        await h.toggle.click();
        await expect.poll(() => playing(h.video)).toBe(true);
        await expect(h.autoplay).toHaveCSS("opacity", "1");
        await expect(page.getByRole("switch", on)).toHaveAttribute(
          "aria-checked", "false"
        );
        expect(await page.evaluate(() => localStorage.getItem("nff:autoplay")))
          .toBe("off");

        // The about page's clip follows the same choice, and its own
        // switch turns autoplay back on, which starts it.
        await page.goto("/about/");

        const clip = page.locator("[data-video]").first();
        const video = clip.locator("video");

        await clip.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(1_500);
        expect(await video.evaluate((v) => v.paused)).toBe(true);
        await clip.getByRole("switch", on).focus();
        await page.keyboard.press("Space");
        await expect(clip.getByRole("switch", off)).toHaveAttribute(
          "aria-checked", "true"
        );
        expect(await page.evaluate(() => localStorage.getItem("nff:autoplay")))
          .toBe("on");
        await expect.poll(() => playing(video)).toBe(true);
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

      // The autoplay switch is next, and shows when focused even after
      // the controls have faded.
      await page.waitForTimeout(6_500);
      await page.keyboard.press("Tab");
      await expect(h.autoplay).toBeFocused();
      await expect(h.autoplay).toHaveCSS("opacity", "1");
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
        // Autoplay reads as off, and a press turns it on.
        await expect(h.autoplay).toHaveAttribute("aria-checked", "false");
        await expect(h.autoplay).toHaveText(/^Turn autoplay on/);
      });
  });

  // #136: the newest post lives at /news/<slug>/. Since #537 the home
  // page shows its excerpt, under the band's eyebrow and title, with
  // "Continue reading" to the rest.
  test.describe("home news section (#136, #537)", () => {
    const POST = "/news/three-quarters-of-the-way/";

    test("the post's excerpt, linked to its own page", async ({ page }) => {
      await page.goto("/");

      const band = page.locator(".home-update");
      const card = page.locator(".home-update-card");

      await expect(band.locator(".home-eyebrow")).toHaveText("Learn more");
      await expect(band.getByRole("heading", { level: 2 }))
        .toHaveText("Farm news and updates");
      await expect(card.locator(".news-header-link"))
        .toHaveText("Three Quarters of the Way");
      await expect(card.locator(".news-header-link"))
        .toHaveAttribute("href", new RegExp(`${POST}$`));
      await expect(card.locator(".news-header time"))
        .toHaveAttribute("datetime", "2026-10-26");
      await expect(card.locator(".news-header time"))
        .toHaveText("October 26, 2026");

      // Winter, with "our map", is past the excerpt; the post's own
      // page carries it (the next test).
      await expect(card.getByRole("link", { name: "our map" }))
        .toHaveCount(0);
      await expect(card.locator("[data-zip-check]")).toHaveCount(0);
      await expect(card.getByRole("link", { name: /^Continue reading/ }))
        .toHaveAttribute("href", new RegExp(`${POST}#summer$`));

      // #537: the title is an h3 and the post's h2s are h4s, at the
      // sizes they had a level up: the title as the post's own h1
      // (2.125rem, scaled down by RFS), "Spring" at 1.2rem.
      const title = await card.locator(".news-header-title")
        .evaluate((el) => getComputedStyle(el).fontSize);

      await expect(card.getByRole("heading", { level: 4, name: "Spring" }))
        .toHaveCSS("font-size", "19.2px");

      // The archive button closes the post, below the card in the
      // section (#483): the small outline one, found by its name, since
      // the sign-up above it has "news" in its own.
      const news = page.locator(".home-update")
        .getByRole("link", { name: "More from the farm" });

      await expect(news).toHaveClass(/btn-outline/);
      await expect(news).toHaveAttribute("href", /\/news\/$/);

      // Up to 600px of text; 3.25rem of padding on a large screen.
      const text = await card.locator(".fmw-600").boundingBox();

      expect(text.width).toBeLessThanOrEqual(600);

      const pad = await card.evaluate((el) => [
        getComputedStyle(el).paddingLeft, getComputedStyle(el).paddingRight,
      ]);

      if (page.viewportSize().width >= 992) {
        expect(pad).toEqual(["52px", "52px"]);
      }

      await page.goto(POST);
      await expect(page.locator("h1.news-header-title"))
        .toHaveCSS("font-size", title);
    });

    test("the post's page is canonical, and the home page is its own",
      async ({ page }) => {
        await page.goto(POST);
        await expect(page.locator("link[rel='canonical']"))
          .toHaveAttribute("href", new RegExp(`${POST}$`));
        await expect(page.locator("h1"))
          .toHaveText("Three Quarters of the Way");
        await expect(page.locator("main")
          .getByRole("link", { name: "our map" }))
          .toHaveAttribute("href", /\/#map$/);

        await page.goto("/");
        await expect(page.locator("link[rel='canonical']"))
          .toHaveAttribute("href", /\/$/);

        await page.goto("/news/");
        await expect(page.locator(`a[href$='${POST}']`).first())
          .toBeAttached();
      });

    // #537: the reader lands on the first block the excerpt left out,
    // in the window and clear of the header. #557: measured against
    // the block's own scroll-margin-top, the header's height and 1rem
    // (_news.scss), once the scroll has settled. Bootstrap's reboot
    // makes the jump smooth, so a read during it lands anywhere: 506
    // and 608px on two runners, against half the window.
    test("Continue reading lands where the excerpt left off",
      async ({ page }) => {
        await page.goto("/");
        await page.locator(".home-update-card")
          .getByRole("link", { name: /^Continue reading/ }).click();
        await expect(page).toHaveURL(new RegExp(`${POST}#summer$`));

        const target = page.locator("#summer");

        await expect(target).toHaveAttribute("data-continue", "");

        const landing = () => target.evaluate((el) => ({
          top: el.getBoundingClientRect().top,
          margin: parseFloat(getComputedStyle(el).scrollMarginTop),
        }));

        await expect.poll(async () => {
          const { top, margin } = await landing();

          return Math.abs(top - margin);
        }, { message: "#summer settles at its scroll margin" })
          .toBeLessThanOrEqual(1);

        // The margin clears the whole header, row and stripe, whether
        // or not the header is still in the window.
        const { top, margin } = await landing();
        const header = await page.locator("body > header").first()
          .evaluate((el) => ({
            height: el.getBoundingClientRect().height,
            bottom: el.getBoundingClientRect().bottom,
          }));

        expect(margin).toBeGreaterThanOrEqual(header.height);
        expect(top).toBeGreaterThanOrEqual(Math.max(header.bottom, 0));
        await expect(target).toBeInViewport();
      });

    // #537: the eyebrow and title beside the card from lg, left-aligned,
    // and above it, centered, below lg.
    test("the band's title sits beside the card wide, above it narrow",
      async ({ page }) => {
        await page.goto("/");

        const title = page.locator(".home-update-intro .home-title");
        const box = await title.boundingBox();
        const card = await page.locator(".home-update-card").boundingBox();
        const align = await title.evaluate((el) =>
          getComputedStyle(el).textAlign);

        if (page.viewportSize().width >= 992) {
          expect(box.x + box.width).toBeLessThanOrEqual(card.x);
          expect(box.y).toBeLessThan(card.y + card.height / 2);
          expect(align).toBe("start");
        } else {
          expect(box.y + box.height).toBeLessThanOrEqual(card.y);
          expect(align).toBe("center");
        }
      });
  });

  // #214, #568: the build prints both bands and every market in
  // data/series.json with its season, and the browser picks at view
  // time: each market through its season, the band while one that
  // isn't a winter market runs. So these hold on a build of any date.
  const SEASON = {
    // A Saturday in September of the season in the data, and the
    // moment after the season's last close, midnight farm time.
    september: async () => {
      const { markets } = await import("./support/series.mjs");
      const last = markets.filter((m) => !m.winter).map((m) => m.closes)
        .sort().at(-1);
      let d = new Date(`${last.slice(0, 4)}-09-01T14:00:00Z`);

      while (d.getUTCDay() !== 6) d = new Date(d.getTime() + 864e5);

      return d;
    },
    ends: async (page) => Math.max(...await page
      .locator("[data-season-band] li[data-season-until]:not([data-winter])")
      .evaluateAll((els) => els.map((el) => Date.parse(
        el.dataset.seasonUntil)))),
  };

  test("the market band lists only the markets running", async ({ page }) => {
    const { markets } = await import("./support/series.mjs");
    const at = await SEASON.september();
    const day = at.toISOString().slice(0, 10);
    const running = markets
      .filter((m) => m.opens <= day && m.closes >= day)
      .map((m) => m.name);

    await page.clock.setFixedTime(at);
    await page.goto("/");

    const band = page.locator("[data-season-band]");

    await expect(band).toBeVisible();
    await expect(band.locator(".place:not([hidden]) .place-name"))
      .toHaveText(running);
    // The off-season band waits in the page, hidden.
    await expect(page.locator(".ways")).toBeHidden();
  });

  // The page may be weeks old when the last market closes, so the
  // browser swaps the bands itself, at midnight farm time on the day
  // after the last close, with nothing left of the market band.
  test("the market band gives way to the ways the day after the last close",
    async ({ page }) => {
      await page.goto("/");

      const band = page.locator("[data-season-band]");
      const ways = page.locator(".ways");
      const { markets } = await import("./support/series.mjs");
      // A winter market running on past the season goes with the band
      // (#544).
      const last = markets.filter((m) => !m.winter).map((m) => m.closes)
        .sort().at(-1);
      const ends = await SEASON.ends(page);
      const next = new Date(Date.parse(`${last}T12:00:00Z`) + 864e5)
        .toISOString().slice(0, 10);

      expect(new Date(ends).toLocaleDateString("en-CA",
        { timeZone: "America/New_York" })).toBe(next);

      await page.clock.setFixedTime(ends - 1000);
      await page.reload();
      await expect(band).toBeVisible();
      await expect(ways).toBeHidden();

      await page.clock.setFixedTime(ends);
      await page.reload();
      await expect(band).toBeHidden();
      await expect(ways).toBeVisible();
      await expect(ways.locator(".place")).toHaveCount(3);
    });

  // #385, #568: on staging, the toolbar's set time moves the bands
  // both ways, on a build of any date, with no rebuild. While a time
  // is set, the toolbar names what the clock can't move.
  test("the staging clock swaps the market and off-season bands",
    async ({ page }) => {
      let at = Date.now();

      await page.route("**/api/staging/info", async (route) => {
        await route.fulfill({
          json: {
            can: ["clock"], session: "x",
            clock: { available: true, offset: at - Date.now(), now: at },
          },
        });
      });
      await page.goto("/");
      test.skip(await page.locator("#staging").count() === 0,
        "not a staging build");

      const band = page.locator("[data-season-band]");
      const ways = page.locator(".ways");
      const misses = page.locator("[data-staging-clock-misses]");
      const ends = await SEASON.ends(page);

      at = (await SEASON.september()).getTime();
      await page.reload();
      await expect(band).toBeVisible();
      await expect(ways).toBeHidden();
      await expect(misses).toBeAttached();
      expect(await misses.evaluate((el) => el.hidden)).toBe(false);

      at = ends + 12 * 3600e3;
      await page.reload();
      await expect(ways).toBeVisible();
      await expect(band).toBeHidden();

      at = ends - 12 * 3600e3;
      await page.reload();
      await expect(band).toBeVisible();
      await expect(ways).toBeHidden();
    });

  // #544, option (c) on #548: while only a winter market runs, the
  // home page keeps the ways band. Its Pickup days card takes the
  // places open from /api/dates: the winter market by name when it is
  // the one place open, else how many places, linked to the map's
  // Places (the card's rule, James, 2026-10-26), which lists it.
  test("a winter market alone keeps the ways band", async ({ page }) => {
    const { markets } = await import("./support/series.mjs");

    await page.goto("/");

    const band = page.locator("[data-season-band]");

    test.skip(await band.isVisible(), "in a market season");

    const built = await page.evaluate(() => new Intl.DateTimeFormat("en-CA",
      { timeZone: "America/New_York" }).format(new Date()));
    const winter = markets.find((m) => m.winter && m.opens <= built
      && m.closes >= built);

    test.skip(!winter, "no winter market running");
    await expect(page.locator(".ways")).toBeVisible();

    const card = page.locator("[data-scheduled-ways]");
    const several = card.locator("a[href='#places']");

    await expect(card.locator(".place-open-name").or(several).first())
      .toBeVisible();
    if (await several.count()) {
      await expect(several).toHaveText(/^\d+ locations$/);
      await expect(page.locator("#home-map .map-places"))
        .toContainText(winter.name);
    } else {
      await expect(card).toContainText(winter.name);
    }
  });

  // #137: while no market runs, the market band gives way to the three
  // ways to buy, every fact from data/delivery.json.
  test.describe("off-season band (#137)", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      test.skip(!(await page.locator(".ways").isVisible()),
        "built while a market runs");
    });

    const WAYS = [
      {
        method: "onfarm", name: "On-farm pickup",
        line: "Choose a day and time to get your order right here at " +
          "the farm",
        where: "99 E Killingly Rd, Foster, RI",
        cost: "No minimum, no fee", cta: "Shop for pickup",
      },
      {
        method: "scheduled", name: "Pickup days",
        when: /Saturdays, 10:00\s–\u2060\s11:00\sAM/,
        line: "Order in advance and get your order at any upcoming " +
          "market, pop-up, or drop site",
        where: "46 Institute Ln, N Scituate, RI",
        cost: "No minimum, no fee", cta: "Shop for pickup days",
      },
      {
        method: "delivery", name: "Delivery",
        line: "Our farm-to-doorstep service: delivery to your front " +
          "door, every week",
        when: /Every Thursday, 10:00\sAM\s–\u2060\s4:00\sPM/,
        where: "Most of central Rhode Island and parts of eastern " +
          "Connecticut",
        cost: `$${MONEY.deliveryMinimum} minimum, $${MONEY.deliveryFee} fee`,
        cta: "Shop for delivery",
      },
    ];

    test("three ways to buy, in the market band's place",
      async ({ page }) => {
        // The scheduled card adds a fact for each place open now, from
        // /api/dates; this test counts the facts the build prints.
        await page.route("**/api/dates", (route) => route.abort());
        await page.goto("/");

        const band = page.locator(".ways");
        const places = band.locator(".place-way");

        await expect(band.locator(".home-eyebrow")).toHaveText(
          "No off-season"
        );
        await expect(band.locator(".home-title")).toHaveText(
          "Three ways to get your order"
        );
        await expect(places).toHaveCount(3);
        for (const [i, way] of WAYS.entries()) {
          const place = places.nth(i);

          await expect(place.locator(".place-name")).toHaveText(way.name);
          await expect(place.locator(".home-icon svg")).toBeVisible();
          // #212: when, where and cost are one list, each with an icon.
          const facts = way.when ? 3 : 2;

          await expect(place.locator(".place-tagline")).toHaveText(way.line);
          await expect(place.locator(".place-fact")).toHaveCount(facts);
          await expect(place.locator(".place-fact svg")).toHaveCount(facts);
          if (way.when) {
            await expect(place.locator(".place-when")).toHaveText(way.when);
          }
          await expect(place.locator(".place-where")).toHaveText(way.where);
          await expect(place.locator(".place-note")).toHaveText(way.cost);
          await expect(place.getByRole("link")).toHaveText(way.cta);
        }
        await expect(band.locator(".places-note")).toHaveCount(0);
      });

    // #313: scheduled pickup reads the places open now from /api/dates
    // at view time, over the drop site the build prints. One location,
    // the card gives its day and address; several, the Where line is
    // how many, as a link to the map (James, 2026-10-26).
    const DROP_ADDRESS = "46 Institute Ln, N Scituate, RI";
    const DROP_OPEN = [
      { date: "2026-10-24", label: "Saturday, October 24",
        series: "VFVQ", name: "Drop site", window: "10:00 – 11:00 AM",
        short: DROP_ADDRESS },
      { date: "2026-10-31", label: "Saturday, October 31",
        series: "VFVQ", name: "Drop site", window: "10:00 – 11:00 AM",
        short: DROP_ADDRESS },
    ];
    const FOSTER_OPEN = { date: "2026-10-25", label: "Sunday, October 25",
      series: "WAC5", name: "Foster Farmers Market",
      window: "9:00 AM – 1:00 PM",
      short: "Shady Acres Diner, 164 Danielson Pike, Foster" };
    const opened = (page, scheduled) => page.route("**/api/dates",
      (route) => route.fulfill({
        json: { now: "2026-10-22T12:00:00Z", scheduled },
      }));

    test("scheduled pickup with one location gives its address",
      async ({ page }) => {
        await opened(page, DROP_OPEN);
        await page.goto("/");

        const card = page.locator(".ways .place-way[data-scheduled-ways]");
        const opens = card.locator(".place-open");

        test.skip(!(await card.isVisible()), "built while a market runs");
        await expect(opens).toHaveCount(1);
        await expect(opens.first().locator(".place-open-name"))
          .toHaveText("Drop site");
        await expect(opens.first().locator(".place-open-where"))
          .toHaveText(DROP_ADDRESS);
        await expect(card.getByRole("link", { name: /location/ }))
          .toHaveCount(0);
        await expect(card.locator("[data-scheduled-static]").first())
          .toBeHidden();
      });

    test("scheduled pickup with several locations says how many, as a "
      + "link to the map", async ({ page }) => {
      const scheduled = [DROP_OPEN[0], FOSTER_OPEN, DROP_OPEN[1]];

      await opened(page, scheduled);
      await page.goto("/");

      const card = page.locator(".ways .place-way[data-scheduled-ways]");
      const link = card.locator(".place-where a");

      test.skip(!(await card.isVisible()), "built while a market runs");
      // The count is the list's own, never a number typed here.
      await expect(link)
        .toHaveText(locationsLabel(locationCount(scheduled)));
      await expect(link).toHaveAttribute("href", "#places");
      await expect(card.locator(".place-when")).toBeHidden();
      await expect(card.locator(".place-open")).toHaveCount(0);
    });

    test("scheduled pickup falls back to the drop site",
      async ({ page }) => {
        await page.route("**/api/dates", (route) => route.abort());
        await page.goto("/");

        const card = page.locator(".ways .place-way[data-scheduled-ways]");

        test.skip(!(await card.isVisible()), "built while a market runs");
        await expect(card.locator(".place-when")).toBeVisible();
        await expect(card.locator(".place-open")).toHaveCount(0);
      });

    // #212: the drop site's first day is a badge by its name
    // until that day is over, then gone.
    test("the drop site's start is a badge until it passes",
      async ({ page }) => {
        await page.goto("/");

        const badge = page.locator(".ways .place-head .place-badge");

        test.skip(await badge.count() === 0, "built after the start");
        const until = await badge.getAttribute("data-hide-from");

        expect(until).toMatch(/^2026-10-18T00:00:00-04:00$/);
        if (Date.now() < Date.parse(until)) {
          await expect(badge).toHaveText("Starting October 17");
          await expect(badge).toBeVisible();
        }
        await page.clock.setFixedTime(new Date("2026-10-18T12:00:00-04:00"));
        await page.reload();
        await expect(badge).toBeHidden();
      });

    for (const way of WAYS) {
      test(`"${way.cta}" opens the order page with ${way.name} chosen`,
        async ({ page }) => {
          await page.goto("/");
          await page.locator(".ways .place").getByRole("link", {
            name: way.cta, exact: true,
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
        // Sign in is a plain link too (#267), but it shows only once
        // /api/me answers, so the first link is taken without it.
        const links = [
          [1500, page.locator(
            "header .site-nav-link:not(.site-signin):visible"
          ).first()],
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

    // James, 2026-09-25: only the hero's buttons run full width on a
    // phone; every other button is as wide as its words.
    test("only the hero's buttons are wide on a phone", async ({ page }) => {
      const shop = page.locator("#how-to-buy .how-cta .btn");
      const hero = page.locator(".btn-hero").first();

      await page.goto("/");
      expect((await look(shop)).padding).toEqual((await look(hero)).padding);
      expect((await look(shop)).width).toBeLessThan(384);

      await page.setViewportSize({ width: 390, height: 664 });

      expect((await look(shop)).width, "Shop all products")
        .toBeLessThan(300);
      for (const btn of await page.locator(".touch-actions .btn").all()) {
        expect((await look(btn)).width, await btn.innerText())
          .toBeLessThan(300);
      }
      expect((await look(hero)).width, "the hero's Order now")
        .toBeGreaterThanOrEqual(300);
    });

    // James, #280: no light row above Get in touch, and its two
    // buttons share one centered row down to the smallest phone.
    test("Get in touch: no light row, both buttons on one row (#280)",
      async ({ page }) => {
        const buttons = page.locator(".touch-actions .btn");

        await page.goto("/");
        await expect(page.locator(".ticker-slot")).toHaveCount(0);
        await expect(buttons).toHaveText(["Email us", "Call or text us"]);
        await expect(buttons.last()).toHaveAttribute("href", /^tel:/);
        await expect(page.locator(".touch-lead a"), "a text link")
          .not.toHaveClass(/\bbtn\b/);

        for (const width of [320, 390]) {
          await page.setViewportSize({ width, height: 664 });

          const boxes = await buttons.evaluateAll((els) => els.map((el) => {
            const r = el.getBoundingClientRect();

            return { top: r.top, left: r.left, right: r.right };
          }));
          const [first, last] = boxes;

          expect(last.top, `one row at ${width}`).toBe(first.top);
          expect(Math.abs(first.left - (width - last.right)),
            `centered at ${width}`).toBeLessThanOrEqual(2);
          // Room to spare: Linux's Chromium rounds each letter to a
          // whole pixel, and wrapped the pair where a Mac left 3.7px
          // (#290).
          expect(await page.locator(".touch-actions").evaluate((row) => {
            const cs = getComputedStyle(row);
            const room = row.clientWidth - parseFloat(cs.paddingLeft)
              - parseFloat(cs.paddingRight);
            const btns = [...row.querySelectorAll(".btn")];

            return room - btns.reduce(
              (n, b) => n + b.getBoundingClientRect().width, 0
            ) - parseFloat(cs.columnGap) * (btns.length - 1);
          }), `px to spare at ${width}`).toBeGreaterThanOrEqual(6);
        }
      });
  });
});
