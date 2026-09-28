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
        .toHaveText("Order our chicken and eggs all year round");
      await expect(how.locator(".how-step-title")).toHaveText([
        "Step 1: Shop what’s fresh",
        "Step 2: Pickup or delivery",
        "Step 3: Change of plans?",
        "Step 4: Taste the difference",
      ]);
      await expect(steps).toHaveCount(4);
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

        await page.reload();
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

  // #136: the September update lives at /news/<slug>/ and the home
  // page publishes it in full under a news eyebrow.
  test.describe("home news section (#136)", () => {
    const POST = "/news/2026-09-22-september-update/";

    test("the post in full, linked to its own page", async ({ page }) => {
      await page.goto("/");

      const card = page.locator(".home-update-card");

      await expect(card.locator(".home-eyebrow"))
        .toHaveText("News and updates");
      await expect(card.locator(".home-update-link"))
        .toHaveText("September Update");
      await expect(card.locator(".home-update-link"))
        .toHaveAttribute("href", new RegExp(`${POST}$`));
      await expect(card.locator("time.home-update-date"))
        .toHaveAttribute("datetime", "2026-09-22");
      await expect(card.locator("time.home-update-date"))
        .toHaveText("September 22, 2026");

      // Since #211 the ZIP check is a plain link under Delivery.
      await expect(card.getByRole("link", { name: "Check your ZIP code" }))
        .toHaveAttribute("href", /\/#map$/);
      await expect(card.locator("[data-zip-check]")).toHaveCount(0);

      // The news button sits below the card, in the section.
      const news = page.locator(".home-update")
        .getByRole("link", { name: /news/i }).last();

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
    });

    test("the post's page is canonical, and the home page is its own",
      async ({ page }) => {
        await page.goto(POST);
        await expect(page.locator("link[rel='canonical']"))
          .toHaveAttribute("href", new RegExp(`${POST}$`));
        await expect(page.locator("h1")).toHaveText("September Update");
        await expect(page.locator("main")
          .getByRole("link", { name: "Check your ZIP code" }))
          .toHaveAttribute("href", /\/#map$/);

        await page.goto("/");
        await expect(page.locator("link[rel='canonical']"))
          .toHaveAttribute("href", /\/$/);

        await page.goto("/news/");
        await expect(page.locator(`a[href$='${POST}']`).first())
          .toBeAttached();
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
        where: "99 E Killingly Rd, Foster, RI",
        cost: "No minimum, no fee", cta: "Shop for pickup",
      },
      {
        method: "scituate", name: "Drop site",
        when: /Saturdays, 10:00\s–\u2060\s11:00\sAM/,
        where: "46 Institute Ln, North Scituate, RI",
        cost: "No minimum, no fee", cta: "Shop for the drop site",
      },
      {
        method: "delivery", name: "Delivery",
        when: /Every Thursday, 10:00\sAM\s–\u2060\s4:00\sPM/,
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
          "Three ways to get your order"
        );
        await expect(places).toHaveCount(3);
        for (const [i, way] of WAYS.entries()) {
          const place = places.nth(i);

          await expect(place.locator(".place-name")).toHaveText(way.name);
          await expect(place.locator(".home-icon svg")).toBeVisible();
          // #212: when, where and cost are one list, each with an icon.
          await expect(place.locator(".place-fact")).toHaveCount(3);
          await expect(place.locator(".place-fact svg")).toHaveCount(3);
          await expect(place.locator(".place-when")).toHaveText(way.when);
          await expect(place.locator(".place-where")).toHaveText(way.where);
          await expect(place.locator(".place-note")).toHaveText(way.cost);
          await expect(place.getByRole("link")).toHaveText(way.cta);
        }
        await expect(band.locator(".places-note")).toHaveCount(0);
      });

    // #212: the drop site's first Saturday is a badge by its name
    // until that day is over, then gone.
    test("the drop site's start is a badge until it passes",
      async ({ page }) => {
        await page.goto("/");

        const badge = page.locator(".ways .place-badge");

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
  });
});
