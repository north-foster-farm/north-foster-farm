// The map (#138), in two layers since #214: an inline SVG of Rhode
// Island and its neighbours. Delivery: the ZIPs we deliver to shaded
// from the same data as the order form, by price, a key, and a pin
// dropped on any ZIP typed into a check on the page or tapped on the
// map, with a tag. Places: a numbered green pin for every place, a
// list whose rows open their cards, one card template. Both zoom.
// docs/qa-launch.md, "The autumn refresh".
//
// Visibility is read from what renders, never from a script property:
// an SVG group has no `hidden` property, and a check that read one
// passed while the dropped pin never showed (fixed in 17b929e).

import { OrderPage, expect, test } from "./support/order.mjs";
import { cannedScheduled } from "./support/scheduled.mjs";
import { addDays, today } from "../assets/scripts/order/lib/zoned.mjs";

const HOME = { path: "/", input: "#home-map-zip-input" };
const POLICY = { path: "/delivery-policy/" };

// The ZIP a shape stands for: the markup writes "z02857", since the
// minifier turns a bare 02857 into 2857.
const zipAttr = (zip) => `z${zip}`;

// The delivery area the page carries for its ZIP check.
const areaZips = (page) => page.evaluate(() => {
  const area = JSON.parse(
    document.querySelector("[data-zip-area]").textContent
  );

  return area.states.flatMap((s) => s.towns.flatMap((t) => t.zips));
});

const map = (page) => page.locator("[data-map]").first();

// The schedule /api/events answers with (the shape #310 posted on
// #309), canned so a spec needs no particular schedule: a date `n`
// days from today for a series at a location, open for pickup orders
// or only attended. The real codes: VFVQ the drop site at G4C6 (the
// Village Green), WAC5 the Foster Farmers Market at D8RW.
const LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
});
const on = (series, location, n, status = "pickup") => {
  const date = addDays(today(new Date(), "America/New_York"), n);

  return {
    occurrence: `${series}-${date.slice(2).replaceAll("-", "")}`,
    date,
    label: LABEL.format(new Date(`${date}T12:00:00Z`)),
    series,
    name: series,
    location,
    window: "10:00 – 11:00 AM",
    status,
  };
};
// Foster's date first, so the list leaves the order the build gave it.
const CANNED = [
  on("WAC5", "D8RW", 1),
  on("VFVQ", "G4C6", 2),
  on("VFVQ", "G4C6", 9, "attend"),
];
const events = (page, list = CANNED) => page.route(
  "**/api/events", (route) => route.fulfill({
    json: { now: new Date().toISOString(), events: list },
  })
);
// The rows in the list, by name.
const names = (page) => map(page).locator("[data-map-show] strong")
  .evaluateAll((els) => els.map((el) => el.textContent.trim()));
const dropPin = (page) => map(page).locator(".map-drop-pin");
// Hidden is asserted on the group: WebKit gives a shape inside a
// display: none group a box, so the shape itself reads as visible.
const dropGroup = (page) => map(page).locator(".map-drop");

const drop = (page) => map(page).evaluate((m) => {
  const group = m.querySelector("[data-map-drop]");
  const tag = m.querySelector("[data-map-drop-tag]");

  return {
    shown: !group.hasAttribute("hidden"),
    tone: group.dataset.tone,
    town: m.querySelector("[data-map-drop-town]").textContent,
    fee: m.querySelector("[data-map-drop-fee]").textContent,
    has: [...m.querySelectorAll("[data-map-drop-has]")]
      .map((g) => g.dataset.on === "true"),
    none: !tag.querySelector("[data-map-drop-none]").hidden,
    link: !tag.querySelector("[data-map-to-places]").hidden,
    at: m.querySelector("[data-map-drop-at]").getAttribute("transform"),
    pick: m.querySelector("[data-map-pick]").getAttribute("d"),
  };
});

const zipShape = (page, zip) => map(page).locator(
  `[data-zip='${zipAttr(zip)}']`
);

const check = async (page, input, zip) => {
  await page.locator(input).fill(zip);
  await page.locator(input).press("Enter");
  await page.waitForTimeout(300);
};

// Places opens on its pins, an animation: wait for the view to rest.
const places = async (page) => {
  const svg = map(page).locator("[data-map-svg]");
  let last = "";

  await map(page).getByRole("tab", { name: "Places" }).click();
  await expect(map(page)).toHaveAttribute("data-layer", "places");
  await expect.poll(async () => {
    const now = await svg.getAttribute("viewBox");
    const rest = now === last;

    last = now;
    return rest;
  }, { intervals: [300] }).toBe(true);
};

// The view's width after one press of +: half of it, but never past
// map.js's MAX_ZOOM of 5. Places frames its pins, so with the places
// close together it opens near the cap, and + stops there (#282).
const MAX_ZOOM = 5;
const zoomedIn = (width, whole) => Math.max(width / 2, whole / MAX_ZOOM);

// A check that needs the farm and the Foster market both on the map
// passes silently once the market's season ends: say it was skipped.
const skipped = (why) => test.info().annotations.push({
  type: "skipped check", description: why,
});

// The whole map's width, from the Delivery view a page opens on.
const wholeWidth = (page) => map(page).locator("[data-map-svg]").evaluate(
  (el) => el.viewBox.baseVal.width
);

// Opening a card scrolls its row into view smoothly: wait for the page
// to stop before measuring where anything is on screen.
const scrollRest = async (page) => {
  let last = -1;

  await expect.poll(async () => {
    const now = await page.evaluate(() => scrollY);
    const rest = now === last;

    last = now;
    return rest;
  }, { intervals: [200] }).toBe(true);
};

// Where each pin's tip stands on screen, and where its place is.
const tips = (page) => map(page).locator("[data-map-svg]").evaluate((el) => (
  [...el.querySelectorAll("[data-map-pin]")].map((g) => {
    const place = new DOMPoint(Number(g.dataset.x), Number(g.dataset.y))
      .matrixTransform(el.getScreenCTM());
    const tip = new DOMPoint(0, 0).matrixTransform(g.getScreenCTM());
    const r = g.getBoundingClientRect();

    return { n: g.getAttribute("aria-label"), nudge: g.dataset.nudge,
      dx: tip.x - place.x, dy: tip.y - place.y,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  })
));

test.describe("map (#138, #214)", () => {
  test("three fills: ours, the rest of RI, the neighbours",
    async ({ page, baseURL }) => {
      const foreign = [];
      const host = new URL(baseURL).host;

      page.on("request", (req) => {
        const url = new URL(req.url());

        if (url.protocol.startsWith("http") && url.host !== host) {
          foreign.push(req.url());
        }
      });
      await page.goto(HOME.path);
      // An aria-label since 0660a0d: a <title> showed as the browser's
      // own tooltip over the map's. A group, not an img, so the pin
      // buttons inside stay reachable.
      await expect(map(page).locator("svg[role='group']"))
        .toHaveAttribute("aria-label", /where we deliver/);
      await expect(map(page).locator("svg[role='group'] > title"))
        .toHaveCount(0);
      await expect(map(page)).toHaveAttribute("data-layer", "delivery");

      // The stylesheet in: until then every shape reads black.
      await expect.poll(() => map(page).locator(".map-zip.is-ours").first()
        .evaluate((el) => getComputedStyle(el).fill))
        .not.toBe("rgb(0, 0, 0)");

      const ours = new Set(await areaZips(page));
      const shown = await map(page).locator("[data-zip]").evaluateAll(
        (els) => els.map((el) => ({
          zip: el.dataset.zip.slice(1),
          cls: ["is-ours", "is-away", "is-land"]
            .filter((c) => el.classList.contains(c)),
          eggs: el.classList.contains("is-eggs"),
          town: el.dataset.town,
          fill: getComputedStyle(el).fill,
        }))
      );

      expect(shown.length).toBeGreaterThan(50);
      for (const z of shown) {
        expect(z.zip, "a whole ZIP, leading zero kept").toMatch(/^\d{5}$/);
        expect(z.cls, `${z.zip} has one fill class`).toHaveLength(1);
        expect(z.cls[0] === "is-ours", `${z.zip} filled as ours`)
          .toBe(ours.has(z.zip));
        // Eggs only (Connecticut) is ours, at the same price; the tag,
        // not the fill, says so.
        if (z.eggs) expect(z.cls[0], `${z.zip} eggs only`).toBe("is-ours");
      }
      expect(shown.find((z) => z.zip === "06234").eggs).toBe(true);

      const fillOf = (cls) => new Set(
        shown.filter((z) => z.cls[0] === cls).map((z) => z.fill)
      );

      for (const cls of ["is-ours", "is-away", "is-land"]) {
        expect(fillOf(cls).size, `${cls}: one fill`).toBe(1);
      }
      expect(new Set(shown.map((z) => z.fill)).size).toBe(3);

      // Rhode Island's own ZIPs (028, 029) are ours or away, never
      // plain land; Massachusetts' 02 ZIPs may be land.
      for (const z of shown.filter((s) => /^02[89]/.test(s.zip))) {
        expect(z.cls[0], z.zip).not.toBe("is-land");
      }
      expect(foreign, "no third-party requests").toEqual([]);
    });

  test("the key's swatches match the map's fills", async ({ page }) => {
    await page.goto(HOME.path);

    for (const [cls, text] of [
      ["is-ours", "$5 delivery"],
      ["is-away", "$8 delivery"],
    ]) {
      const swatch = map(page).locator(`.map-key-areas .map-swatch.${cls}`);

      await expect(swatch.locator("xpath=..")).toHaveText(text);

      const a = await swatch.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      );

      // The fills ease in as the page opens: wait for them to rest.
      await expect.poll(() => map(page).locator(`.map-zip.${cls}`).first()
        .evaluate((el) => getComputedStyle(el).fill), { message: cls })
        .toBe(a);
    }

    // Then how the tag marks what we deliver: a struck-through icon.
    const rows = map(page).locator(".map-key-areas li");

    await expect(rows).toHaveText([
      "$5 delivery", "$8 delivery", "Available for delivery",
      "Unavailable for delivery",
    ]);
    await expect(rows.nth(3).locator(".map-tag-icon.is-off")).toHaveCount(1);
    await expect(map(page).locator(".map-swatch.is-eggs")).toHaveCount(0);
  });

  // Places: one list beside the map names every pin, the farm first,
  // then each location by the next date the farm attends there (#314);
  // each name opens its pin's card. Every pin is drawn alike, and none
  // shows on the Delivery layer.
  test("the Places list is one list, matching the pins",
    async ({ page }) => {
      await events(page);
      await page.goto(HOME.path);

      const pins = map(page).locator("[data-map-pin]");

      await expect(map(page).locator(".map-pins")).toBeHidden();
      await expect(map(page).locator(".map-places")).toBeHidden();
      await places(page);
      await expect(pins.first()).toBeVisible();
      await expect(map(page).locator(".map-key-areas").first()).toBeHidden();
      await expect(map(page).locator(".map-key-areas").last()).toBeHidden();
      // One list, with no sections.
      await expect(map(page).locator(".map-key-head")).toHaveCount(0);
      await expect(map(page).locator(".map-places .map-key-list"))
        .toHaveCount(1);

      const rows = await map(page).locator("[data-map-show]").evaluateAll(
        (els) => els.map((el) => ({
          n: el.dataset.mapShow,
          name: el.querySelector("strong").textContent.trim(),
          num: el.querySelector("[data-map-num]").textContent,
        }))
      );
      const drawn = await pins.evaluateAll((els) => els.map((el) => ({
        n: el.dataset.mapPin,
        label: el.getAttribute("aria-label"),
      })));

      expect(rows[0].name).toBe("Our farm");
      for (const row of rows) {
        expect(drawn.find((d) => d.n === row.n), `a pin for ${row.name}`)
          .toBeTruthy();
      }
      for (const pin of drawn) {
        expect(rows.some((r) => r.n === pin.n), `${pin.label} listed`)
          .toBe(true);
      }
      // A pin carries its row's number, in list order, and is named for
      // its place, never the number (#214).
      await expect.poll(() => map(page).locator("[data-map-num]")
        .evaluateAll((els) => els.map((el) => el.textContent)))
        .toEqual(rows.map((_, i) => String(i + 1)));
      for (const row of rows) {
        const pin = map(page).locator(`[data-map-pin='${row.n}']`);

        expect(await pin.getAttribute("aria-label")).not.toBe(row.num);
        await expect(pin).toHaveAccessibleName(/\D{3}/);
      }
      // Fills ease in as the layer shows: wait for them to rest.
      await expect.poll(() => pins.evaluateAll((els) => new Set(
        els.map((el) => getComputedStyle(el.querySelector("path")).fill)
      ).size), "one pin color").toBe(1);
      expect(drawn.length).toBeGreaterThan(0);
      await expect(map(page).locator(".map-key-n, .map-ig, [data-stack]"))
        .toHaveCount(0);
      await expect(map(page)).not.toContainText("Out of season");
    });

  test("the list follows the next date the farm attends",
    async ({ page }) => {
      await events(page);
      await page.goto(HOME.path);
      await places(page);

      const all = await names(page);

      if (!(all.includes("Shady Acres Diner")
        && all.includes("The Village Green"))) {
        skipped("Foster market not showing");
        return;
      }
      // Foster's date is first in the canned schedule.
      await expect.poll(() => names(page)).toEqual([
        "Our farm", "Shady Acres Diner", "The Village Green",
        ...all.filter((n) => ![
          "Our farm", "Shady Acres Diner", "The Village Green",
        ].includes(n)),
      ]);
      // And the other way round, with the drop site's first.
      await page.unroute("**/api/events");
      await events(page, [on("VFVQ", "G4C6", 1), on("WAC5", "D8RW", 2)]);
      await page.reload();
      await places(page);
      await expect.poll(() => names(page).then((n) => n.slice(0, 3)))
        .toEqual(["Our farm", "The Village Green", "Shady Acres Diner"]);
    });

  // The farm and the Foster market meet at the whole map: each stands
  // a little aside, so both can be tapped, and both come back to their
  // places once zoomed in. Places opens framed on its pins, as close as
  // they allow, so the two may already stand apart there (#282): at
  // that view they must only not overlap. Every other tip is on its
  // place at every zoom: the Foster market's tip once fell in
  // Connecticut on a phone.
  test("pins stand on their places; the farm and Foster stand apart",
    async ({ page }) => {
      await page.goto(HOME.path);

      const all = await wholeWidth(page);

      await places(page);

      const svg = map(page).locator("[data-map-svg]");
      const width = () => svg.evaluate(
        (el) => Number(el.getAttribute("viewBox").split(" ")[2])
      );
      const pair = (shown) => [
        shown.find((t) => t.n === "North Foster Farm"),
        shown.find((t) => t.n === "Shady Acres Diner"),
      ];
      const onPlaces = (shown, where) => {
        for (const t of shown) {
          expect(Math.abs(t.dy), `${t.n}, ${where}`).toBeLessThanOrEqual(1);
          expect(Math.abs(t.dx), `${t.n}, ${where}`)
            .toBeLessThanOrEqual(t.nudge ? 16 : 1);
        }
      };
      const apart = (a, b) => a.left >= b.right - 2 || b.left >= a.right - 2;
      const zoomOut = map(page).locator("[data-map-zoom='out']");

      await svg.scrollIntoViewIfNeeded();
      const fit = await width();
      const framed = await tips(page);
      const [farm, foster] = pair(framed);

      onPlaces(framed, "framed");
      if (!(farm && foster)) skipped("Foster market not showing");
      if (farm && foster) {
        const clear = apart(farm, foster) || farm.top >= foster.bottom - 2
          || foster.top >= farm.bottom - 2;

        expect(clear, "the farm and the Foster market both tappable")
          .toBe(true);
      }

      await map(page).locator("[data-map-zoom='in']").click();
      await expect.poll(width).toBeCloseTo(zoomedIn(fit, all), 0);
      for (const t of await tips(page)) {
        expect(Math.hypot(t.dx, t.dy), `${t.n}, zoomed`)
          .toBeLessThanOrEqual(1);
      }

      // Out to the whole state, where the two meet: side by side.
      while (await zoomOut.isEnabled()) {
        await zoomOut.click();
        await page.waitForTimeout(300);
      }
      await expect.poll(width).toBeCloseTo(all, 0);
      const whole = await tips(page);
      const [farAt, fosterAt] = pair(whole);

      onPlaces(whole, "whole state");
      if (farAt && fosterAt) {
        expect(apart(farAt, fosterAt),
          "the farm and the Foster market side by side").toBe(true);
      }
    });

  // The drop site and a market at the Village Green are two series at
  // one location: one pin, one card, no special case (#314).
  test("one location, one card: the Village Green's series and dates",
    async ({ page }) => {
      await events(page);
      await page.goto(HOME.path);
      await places(page);
      await map(page).locator("[data-map-show]", {
        hasText: "The Village Green",
      }).click();

      const card = map(page).locator("[data-map-card]:not([hidden])");
      const drop = card.locator("[data-series='VFVQ']");
      const dates = drop.locator("[data-series-dates] li");

      await expect(card).toHaveCount(1);
      await expect(drop).toContainText("Drop site");
      // The date open for pickup links to its series; the one the farm
      // only attends has no link.
      await expect(dates).toHaveCount(2);
      await expect(dates.first().getByRole("link",
        { name: "Shop for pickup here" }))
        .toHaveAttribute("href", /\/order\/\?method=scheduled&series=VFVQ$/);
      await expect(dates.last().getByRole("link")).toHaveCount(0);
      await expect(dates.last()).toContainText("No pickup orders");
      // No link the build kept for the drop site once the dates load.
      await expect(drop.locator("[data-series-fallback]")).toHaveCount(0);
      // A market there, while its season runs, shares the card.
      const market = card.locator("[data-series='2MPW']");

      if (await market.count()) {
        await expect(card.locator("[data-series]")).toHaveCount(2);
        await expect(card.getByRole("link", { name: "Market website" }))
          .toBeVisible();
      } else {
        skipped("the Scituate market's season has ended");
        await expect(card.getByRole("link", { name: "Market website" }))
          .toHaveCount(0);
      }
    });

  test("every series' open date links to the order page for it",
    async ({ page }) => {
      const codes = await (async () => {
        await page.goto(HOME.path);

        return map(page).locator("[data-series]").evaluateAll(
          (els) => els.map((el) => [el.dataset.series,
            el.closest("li[data-location]").dataset.location])
        );
      })();

      // A market, a pop-up, the drop site: whatever the build carries.
      await page.unroute("**/api/events").catch(() => {});
      await events(page, codes.map(([series, at], i) => on(series, at, i + 1)));
      await page.reload();
      await places(page);
      for (const [series, at] of codes) {
        await map(page).locator(`li[data-location='${at}'] [data-map-show]`)
          .click();

        const card = map(page).locator("[data-map-card]:not([hidden])");

        await expect(card.locator(`[data-series='${series}'] a`,
          { hasText: "Shop for pickup here" }))
          .toHaveAttribute("href",
            new RegExp(`/order/\\?method=scheduled&series=${series}$`));
        await page.keyboard.press("Escape");
      }
    });

  test("a skipped date is absent, and a series with none shows its season",
    async ({ page }) => {
      // The farm skips the drop site on the second Saturday; the
      // schedule's list leaves it out.
      await events(page, [on("VFVQ", "G4C6", 2)]);
      await page.goto(HOME.path);
      await places(page);
      await map(page).locator("[data-map-show]", {
        hasText: "The Village Green",
      }).click();

      const drop = map(page).locator("[data-series='VFVQ']");

      await expect(drop.locator("[data-series-dates] li")).toHaveCount(1);
      await expect(drop).toContainText(/Saturdays, 10:00 – 11:00 AM/);
      // Foster has no date in the list: its card keeps its season, and
      // has no link.
      const foster = map(page).locator("[data-series='WAC5']");

      if (await foster.count()) {
        await expect(foster.locator("[data-series-dates] li")).toHaveCount(0);
        await expect(foster.locator("a")).toHaveCount(0);
        await expect(foster).toContainText("June through October");
      }
    });

  test("when /api/events can't load, seasons stay and only the drop site links",
    async ({ page }) => {
      await page.route("**/api/events", (route) => route.abort());
      await page.goto(HOME.path);
      await places(page);

      const drop = map(page).locator("[data-series='VFVQ']");

      await expect(drop.locator("[data-series-fallback]"))
        .toHaveAttribute("href", /\/order\/\?method=scheduled&series=VFVQ$/);
      await expect(drop.locator("[data-series-dates] li")).toHaveCount(0);
      await expect(map(page).locator(
        "[data-series]:not([data-series='VFVQ']) a[href*='/order/']"
      )).toHaveCount(0);
      await expect(map(page).locator("[data-map-show]", {
        hasText: "The Village Green",
      })).toBeVisible();
    });

  // The order page's "{n} locations" link opens the map to the
  // locations with a date open for pickup (#314).
  test("#places-scheduled keeps the scheduled pickup locations",
    async ({ page }) => {
      await events(page, [on("VFVQ", "G4C6", 2)]);
      await page.goto(`${HOME.path}#places-scheduled`);
      await expect(map(page)).toHaveAttribute("data-layer", "places");

      const chip = map(page).locator("[data-map-filter]");

      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => names(page)).toEqual(["The Village Green"]);
      await expect(map(page).locator("[data-map-pin]:not([hidden])"))
        .toHaveCount(1);
      await expect(map(page).locator("[data-map-num]:visible"))
        .toHaveText("1");
      // The chip puts the rest back.
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "false");
      await expect.poll(async () => (await names(page)).length)
        .toBeGreaterThan(1);
      expect((await names(page))[0]).toBe("Our farm");
    });

  test("with nothing open for pickup, the filter says so",
    async ({ page }) => {
      await events(page, [on("VFVQ", "G4C6", 2, "attend")]);
      await page.goto(`${HOME.path}#places-scheduled`);
      await expect(map(page).locator("[data-map-filter-none]"))
        .toBeVisible();
      await expect(map(page).locator("[data-map-pin]:not([hidden])"))
        .toHaveCount(0);
    });

  test("the order page's locations link opens the filtered map",
    async ({ page }) => {
      await cannedScheduled(page);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });

      const link = page.locator("[data-scheduled-facts] a",
        { hasText: /locations$/ });

      await expect(link).toHaveAttribute("href", /\/#places-scheduled$/);
    });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

    test("a tap on a pin opens its card; a tap off it closes it",
      async ({ page }) => {
        await page.goto(HOME.path);
        await places(page);

        const svg = map(page).locator("[data-map-svg]");
        // By its number: an open card's pin moves to the end, to paint
        // on top.
        const n = await map(page).locator("[data-map-pin]").first()
          .getAttribute("data-map-pin");
        const pin = map(page).locator(`[data-map-pin='${n}']`);
        const card = map(page).locator(`[data-map-card='${n}']`);

        await svg.scrollIntoViewIfNeeded();
        await pin.locator(".map-pin-body").tap();
        await expect(card).toBeVisible();
        await expect(pin).toHaveAttribute("aria-pressed", "true");
        await scrollRest(page);

        // A corner of the map the card, the zoom and the pins leave bare.
        const box = await svg.boundingBox();
        const corner = await page.evaluate((b) => [
          [b.x + b.width - 4, b.y + b.height - 4],
          [b.x + b.width - 4, b.y + 4],
          [b.x + 60, b.y + b.height - 4],
        ].find(([x, y]) => {
          const el = document.elementFromPoint(x, y);

          return el && el.closest("[data-map-svg]")
            && !el.closest("[data-map-pin]");
        }), box);

        expect(corner, "a bare corner").toBeTruthy();
        await page.touchscreen.tap(...corner);
        await expect(card).toBeHidden();
      });
  });

  test("a ZIP typed in drops a visible pin on its middle",
    async ({ page }) => {
      await page.goto(HOME.path);
      await expect(page.locator(HOME.input))
        .toHaveAttribute("autocomplete", "off");
      await expect(dropGroup(page)).toBeHidden();

      // The tag: the town, an egg and a hen (struck through where we
      // don't deliver them), and the price, or "No delivery" and a way
      // to the places.
      for (const [zip, tone, fee, has, none] of [
        ["02857", "ok", "$5", [true, true], false],
        ["02802", "wait", "$8", [true, true], false],
        ["06234", "ok", "$5", [true, false], false],
        ["01570", "no", "", [false, false], true],
      ]) {
        await check(page, HOME.input, zip);

        const d = await drop(page);
        const shape = zipShape(page, zip);
        const [x, y] = await shape.evaluate(
          (el) => [el.dataset.x, el.dataset.y]
        );

        await expect(dropPin(page), zip).toBeVisible();
        expect(d.shown, zip).toBe(true);
        expect(d.tone, zip).toBe(tone);
        expect(d.town, zip).toBe(await shape.getAttribute("data-town"));
        expect(d.fee, zip).toBe(fee);
        expect(d.has, zip).toEqual(has);
        expect(d.none, `${zip} says No delivery`).toBe(none);
        expect(d.link, `${zip} offers the places`).toBe(none);
        expect(d.at, `${zip} lands on its middle`)
          .toMatch(new RegExp(`^translate\\(${x} ${y}\\)`));
        expect(d.pick, `${zip} outlined`)
          .toBe(await shape.getAttribute("d"));
        const off = await map(page).locator("[data-map-drop-has]")
          .evaluateAll((els) => els.map((el) => el.classList
            .contains("is-off")));

        expect(off, `${zip} struck through`).toEqual(has.map((h) => !h));
      }

      // "See pickup spots" opens the Places layer.
      await map(page).locator("[data-map-to-places]").click();
      await expect(map(page)).toHaveAttribute("data-layer", "places");
      await expect(dropGroup(page)).toBeHidden();
      await map(page).getByRole("tab", { name: "Delivery" }).click();

      // A ZIP the map does not show gets no pin; the screen reader's
      // words answer.
      await check(page, HOME.input, "10001");
      await expect(dropGroup(page)).toBeHidden();
      await expect(map(page).locator("[data-zip-result]"))
        .toHaveText("No delivery to 10001.");

      // Clearing the field lifts the pin.
      await check(page, HOME.input, "02857");
      await expect(dropPin(page)).toBeVisible();
      await page.locator(HOME.input).fill("");
      await page.locator(HOME.input).dispatchEvent("input");
      await expect(dropGroup(page)).toBeHidden();
    });

  // Lincoln lies on the map's top edge. The zoom sits over the map's
  // top left since #214, clear of the tag at Lincoln.
  test("the tag keeps inside the frame", async ({ page }) => {
    await page.goto(HOME.path);
    await check(page, HOME.input, "02865");
    // A check brings the map into view: measure once the page stops.
    await scrollRest(page);

    const [tag, frame, zoom] = await Promise.all([
      map(page).locator("[data-map-drop-tag]"),
      map(page).locator("[data-map-frame]"),
      map(page).locator(".map-zoom"),
    ].map((el) => el.boundingBox()));

    expect(tag.y).toBeGreaterThanOrEqual(frame.y);
    expect(tag.x).toBeGreaterThanOrEqual(frame.x);
    expect(tag.x + tag.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(tag.y + tag.height)
      .toBeLessThanOrEqual(frame.y + frame.height);
    expect(zoom.y, "the zoom inside the map").toBeGreaterThanOrEqual(frame.y);
    expect(zoom.x).toBeGreaterThanOrEqual(frame.x);
    expect(tag.x >= zoom.x + zoom.width || tag.x + tag.width <= zoom.x
      || tag.y >= zoom.y + zoom.height || tag.y + tag.height <= zoom.y,
    "the tag clear of the zoom").toBe(true);
  });

  test("a second tap on the town picked clears it; so does water",
    async ({ page }) => {
      await page.goto(HOME.path);

      const svg = map(page).locator("[data-map-svg]");
      // A point on the shape itself, not under the tag.
      const at = (zip) => zipShape(page, zip).evaluate((el) => {
        const r = el.getBoundingClientRect();

        for (let i = 1; i < 10; i += 1) {
          for (let j = 1; j < 10; j += 1) {
            const x = r.x + r.width * i / 10;
            const y = r.y + r.height * j / 10;

            if (document.elementFromPoint(x, y) === el) return [x, y];
          }
        }
        return null;
      });
      const result = map(page).locator("[data-zip-result]");

      await svg.scrollIntoViewIfNeeded();
      const warwick = await at("02886");

      await page.mouse.click(...warwick);
      await expect(page.locator(HOME.input)).toHaveValue("02886");
      await expect(dropPin(page)).toBeVisible();
      await page.mouse.click(...warwick);
      await expect(page.locator(HOME.input)).toHaveValue("");
      await expect(result).toBeEmpty();
      await expect(dropGroup(page)).toBeHidden();
      await expect(map(page).locator(".map-pick")).toBeHidden();

      // Water, at the frame's bottom right corner.
      await page.mouse.click(...warwick);
      await expect(dropPin(page)).toBeVisible();

      const box = await svg.boundingBox();

      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
      await expect(page.locator(HOME.input)).toHaveValue("");
      await expect(dropGroup(page)).toBeHidden();
    });

  // A town we don't deliver to picks like any other, and its outline
  // is grey: the green means yes (#214).
  test("a town outside the area picks, outlined in grey",
    async ({ page }) => {
      await page.goto(HOME.path);

      const land = map(page).locator(".map-zip.is-land").first();

      await land.scrollIntoViewIfNeeded();

      const zip = (await land.getAttribute("data-zip")).slice(1);
      const hit = await land.evaluate((el) => {
        const r = el.getBoundingClientRect();

        for (let i = 1; i < 10; i += 1) {
          for (let j = 1; j < 10; j += 1) {
            const x = r.x + r.width * i / 10;
            const y = r.y + r.height * j / 10;

            if (document.elementFromPoint(x, y) === el) return [x, y];
          }
        }
        return null;
      });

      expect(hit, "a point on the shape").toBeTruthy();
      await page.mouse.click(...hit);
      await expect(page.locator(HOME.input)).toHaveValue(zip);

      const pick = map(page).locator(".map-pick");

      await expect(pick).toBeVisible();
      await expect(pick).toHaveCSS("stroke", "rgb(94, 94, 95)");
      await expect(map(page).locator("[data-map-drop-tag]"))
        .toContainText("No delivery");
    });

  test("a tap on a town runs the check and drops the pin",
    async ({ page }) => {
      await page.goto(HOME.path);

      const shape = zipShape(page, "02857");

      await shape.scrollIntoViewIfNeeded();

      const box = await shape.boundingBox();
      const [x, y] = await shape.evaluate((el) => {
        const svg = el.ownerSVGElement;
        const pt = svg.createSVGPoint();

        pt.x = Number(el.dataset.x);
        pt.y = Number(el.dataset.y);

        const s = pt.matrixTransform(svg.getScreenCTM());

        return [s.x, s.y];
      });

      expect(box).toBeTruthy();
      // Tap the shape where it is, should its middle be covered.
      const hit = await page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);

        return el && el.closest("[data-zip]") ? [px, py] : null;
      }, [x, y]);

      await page.mouse.click(...(hit || [box.x + box.width / 2,
        box.y + box.height / 2]));
      await expect(page.locator(HOME.input)).toHaveValue("02857");
      await expect(map(page).locator("[data-zip-result]"))
        .toContainText("We deliver eggs and chicken to");
      await expect(dropPin(page)).toBeVisible();
    });

  // The field is bare on the map, bottom right, on Delivery only; its
  // placeholder is the instruction (#214).
  test("the ZIP field floats on the map, Delivery only",
    async ({ page }) => {
      await page.goto(HOME.path);

      const input = page.locator(HOME.input);

      await expect(input).toHaveAttribute("placeholder", "Enter your ZIP");
      await expect(map(page).getByText("Do we deliver to you?"))
        .toHaveCount(0);
      const [field, frame] = await Promise.all([
        input.boundingBox(),
        map(page).locator("[data-map-frame]").boundingBox(),
      ]);

      expect(field.x + field.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(field.x + field.width).toBeGreaterThan(frame.x + frame.width - 40);
      expect(field.y + field.height)
        .toBeLessThanOrEqual(frame.y + frame.height);
      expect(field.y + field.height)
        .toBeGreaterThan(frame.y + frame.height - 40);

      await map(page).getByRole("tab", { name: "Places" }).click();
      await expect(input).toBeHidden();
      await map(page).getByRole("tab", { name: "Delivery" }).click();
      await expect(input).toBeVisible();
    });

  // With a mouse, a town shows the dropped pin's tag beside the
  // pointer: its name, what we deliver there and the price.
  test("a town shows its tag under the pointer", async ({ page }) => {
    test.skip(!!test.info().project.use.isMobile, "a mouse");
    await page.goto(HOME.path);

    const shape = zipShape(page, "02857");

    await shape.scrollIntoViewIfNeeded();

    const town = await shape.getAttribute("data-town");
    const [x, y] = await shape.evaluate((el) => {
      const svg = el.ownerSVGElement;
      const pt = svg.createSVGPoint();

      pt.x = Number(el.dataset.x);
      pt.y = Number(el.dataset.y);

      const s = pt.matrixTransform(svg.getScreenCTM());

      return [s.x, s.y];
    });

    await page.mouse.move(x, y);
    await page.mouse.move(x + 2, y + 2);

    const tip = map(page).locator(".map-tag.is-tip");

    await expect(tip).toBeVisible();
    await expect(tip).toContainText("$5");
    if (town) await expect(tip).toContainText(town);
    await expect(tip.locator(".map-tag-icon.is-off")).toHaveCount(0);

    // Not on the Places layer.
    await places(page);
    await page.mouse.move(x, y);
    await expect(tip).toBeHidden();
  });

  test("a pin opens its card; Escape closes it to its row",
    async ({ page }) => {
      await page.goto(HOME.path);
      await places(page);

      const pin = map(page).locator("[data-map-pin='1']");
      const card = map(page).locator("[data-map-card='1']");

      const light = () => pin.locator("path").evaluate((el) => {
        const [r, g, b] = getComputedStyle(el).fill.match(/\d+/g).map(Number);

        return r + g + b;
      });

      await pin.scrollIntoViewIfNeeded();
      const idle = await light();

      await pin.focus();
      await page.keyboard.press("Enter");
      await expect(card).toBeVisible();
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      // The selected pin is brightened, never darkened (#214).
      await expect.poll(light).toBeGreaterThan(idle);
      // The card opens in its row, and the row has the focus.
      await expect(map(page).locator("[data-map-show='1']")).toBeFocused();
      await expect(card.locator("xpath=ancestor::li"))
        .toHaveAttribute("data-open", "");
      // One template: when, where, directions, then the shop button.
      await expect(card.locator(".map-card-label")).toHaveText(
        ["When", "Where"]
      );
      // To the farm's listing by name, and Apple's by its place ID.
      const farm = "destination=North\\+Foster\\+Farm%2C\\+99\\+East";

      await expect(card.getByRole("link",
        { name: "Directions in Google Maps" })).toHaveAttribute("href",
        new RegExp(`^https://www\\.google\\.com/maps/dir/\\?api=1&${farm}`));
      await expect(card.getByRole("link",
        { name: "Directions in Apple Maps" })).toHaveAttribute("href",
        new RegExp(`^https://maps\\.apple\\.com/directions\\?${farm}` +
          ".*&destination-place-id=ICF8119F668A349F8$"));
      await expect(card.locator(".map-card-shop")).toHaveAttribute(
        "href", /\/order\/\?method=onfarm$/
      );

      // The card is in the list, never over the map.
      await expect(map(page).locator("[data-map-frame] [data-map-card]"))
        .toHaveCount(0);

      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(map(page).locator("[data-map-show='1']")).toBeFocused();
      await expect(pin).toHaveAttribute("aria-pressed", "false");
    });

  // A name in the directory opens the same card. A location with only
  // a market or a pop-up has no shop button; its links are labeled.
  // No blue on land: water is the only blue, and a town with a pin has
  // no tint (#214).
  test("no town takes a tint, and no land is blue", async ({ page }) => {
    await page.goto(HOME.path);
    await places(page);
    await expect(map(page).locator(".has-pin")).toHaveCount(0);

    const fills = await map(page).locator(".map-zip").evaluateAll(
      (els) => [...new Set(els.map((el) => getComputedStyle(el).fill))]
    );

    expect(fills).toHaveLength(1);

    const [r, , b] = fills[0].match(/\d+/g).map(Number);

    expect(b, "not blue").toBeLessThanOrEqual(r);
  });

  // Beside the map, a list longer than the map scrolls (#214).
  test("the places list scrolls when it outruns the map",
    async ({ page }) => {
      await page.goto(HOME.path);
      await places(page);

      const list = map(page).locator(".map-places");
      const wide = await page.evaluate(() => matchMedia("(min-width: 992px)")
        .matches);

      test.skip(!wide, "the list sits below the map on a phone");
      await list.scrollIntoViewIfNeeded();
      await list.evaluate((el) => {
        const ul = el.querySelector(".map-key-list:last-of-type");

        for (let i = 0; i < 12; i += 1) {
          ul.append(ul.firstElementChild.cloneNode(true));
        }
        dispatchEvent(new Event("resize"));
      });

      const [box, frame] = await Promise.all([
        list.boundingBox(),
        map(page).locator("[data-map-frame]").boundingBox(),
      ]);

      expect(box.y + box.height, "ends with the map")
        .toBeLessThanOrEqual(frame.y + frame.height + 1);
      await expect(list).toHaveCSS("overflow-y", "auto");
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight),
        "it scrolls").toBe(true);
    });

  // The pin's town is outlined while its card is open (#214).
  test("the selected pin's town is outlined", async ({ page }) => {
    await page.goto(HOME.path);
    await places(page);

    const town = map(page).locator(".map-town");

    await expect(town).toBeHidden();
    await map(page).locator("[data-map-pin='1']").scrollIntoViewIfNeeded();
    await map(page).locator("[data-map-pin='1']").focus();
    await page.keyboard.press("Enter");
    await expect(town).toBeVisible();
    expect(await town.getAttribute("d")).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(town).toBeHidden();

    // Every pin stands in a town of the map.
    const count = await map(page).locator("[data-map-pin]").count();

    for (let n = 1; n <= count; n += 1) {
      const pin = map(page).locator(`[data-map-pin='${n}']`);

      await pin.focus();
      await page.keyboard.press("Enter");
      await expect(town, `pin ${n}`).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });

  test("a name in the directory opens the same card", async ({ page }) => {
    await page.goto(HOME.path);
    await places(page);

    const line = map(page).locator("[data-map-show]", {
      hasText: "Shady Acres Diner",
    });

    test.skip(await line.count() === 0, "the Foster market has closed");
    const n = await line.getAttribute("data-map-show");

    await line.click();

    const card = map(page).locator(`[data-map-card='${n}']`);

    await expect(map(page)).toHaveAttribute("data-layer", "places");
    await expect(card).toBeVisible();
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await expect(card).toContainText("June through October");
    await expect(card).not.toContainText("Out of season");
    await expect(card.locator(".map-card-shop")).toHaveCount(0);
    await expect(card.locator(".map-card-links a"))
      .toHaveText(["Market website", "Market Instagram"]);
    await expect(card).toBeInViewport();
    // Tapping the row again closes it.
    await line.click();
    await expect(card).toBeHidden();
  });

  test("zoom in and out; pins keep their size", async ({ page }) => {
    await page.goto(HOME.path);

    const all = await wholeWidth(page);
    const svg = map(page).locator("[data-map-svg]");
    const width = () => svg.evaluate(
      (el) => Number(el.getAttribute("viewBox").split(" ")[2])
    );
    const pinHeight = () => map(page).locator("[data-map-pin='1']")
      .evaluate((el) => el.getBoundingClientRect().height);
    const zoomIn = map(page).locator("[data-map-zoom='in']");
    const zoomOut = map(page).locator("[data-map-zoom='out']");
    const reset = map(page).locator("[data-map-zoom='reset']");

    // Delivery opens on the whole state, whatever the pins: + halves
    // the view, and stops at MAX_ZOOM with the button disabled (#282).
    await svg.scrollIntoViewIfNeeded();
    await expect(zoomOut).toBeDisabled();
    await zoomIn.click();
    await expect.poll(width).toBeCloseTo(all / 2, 0);
    for (let i = 0; i < 4 && await zoomIn.isEnabled(); i += 1) {
      await zoomIn.click();
      await page.waitForTimeout(300);
    }
    await expect(zoomIn).toBeDisabled();
    await expect.poll(width).toBeCloseTo(all / MAX_ZOOM, 0);

    await places(page);
    await svg.scrollIntoViewIfNeeded();

    // Places opens framed on its pins: closer than the state, and
    // the globe has nothing to do.
    const fit = await width();
    const pinAtFit = await pinHeight();

    expect(pinAtFit, "the pin shows").toBeGreaterThan(20);
    await expect(reset).toBeHidden();
    await expect(zoomOut).toBeEnabled();

    await zoomIn.click();
    await expect.poll(width).toBeCloseTo(zoomedIn(fit, all), 0);
    await expect(reset).toBeVisible();
    expect(Math.abs(await pinHeight() - pinAtFit), "pin size on screen")
      .toBeLessThanOrEqual(2);

    // The buttons zoom out to the whole state, and no further.
    await reset.click();
    await expect.poll(width).toBeCloseTo(fit, 0);
    for (let i = 0; i < 4; i += 1) {
      if (await zoomOut.isEnabled()) await zoomOut.click();
      await page.waitForTimeout(300);
    }
    await expect(zoomOut).toBeDisabled();
    expect(await width()).toBeGreaterThan(fit);
    await reset.click();
    await expect.poll(width).toBeCloseTo(fit, 0);
  });

  // Places frames its pins; Delivery shows the whole state (#214).
  test("Places frames its pins, and Delivery the whole state",
    async ({ page }) => {
      await page.goto(HOME.path);

      const svg = map(page).locator("[data-map-svg]");
      const view = () => svg.getAttribute("viewBox");
      const whole = await view();

      await places(page);

      // Every pin sits inside the frame with about its height to spare.
      const box = await svg.boundingBox();
      const pins = await map(page).locator("[data-map-pin]").evaluateAll(
        (els) => els.map((el) => el.getBoundingClientRect().toJSON())
      );

      expect(await view()).not.toBe(whole);
      for (const r of pins) {
        expect(r.left - box.x, "left room").toBeGreaterThanOrEqual(20);
        expect(box.x + box.width - r.right, "right room")
          .toBeGreaterThanOrEqual(20);
        expect(r.top - box.y, "top room").toBeGreaterThanOrEqual(20);
        expect(box.y + box.height - r.bottom, "bottom room")
          .toBeGreaterThanOrEqual(20);
      }

      // One pin alone is shown at a town's zoom, no closer.
      await map(page).evaluate((m) => {
        for (const pin of [...m.querySelectorAll("[data-map-pin]")].slice(1)) {
          pin.remove();
        }
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect.poll(async () => {
        const w = Number((await view()).split(" ")[2]);

        return Math.round(Number(whole.split(" ")[2]) / w * 10) / 10;
      }).toBe(4);

      await map(page).getByRole("tab", { name: "Delivery" }).click();
      await expect.poll(view).toBe(whole);
    });

  // A row and its pin light each other under a mouse (#214).
  test("a row and its pin light each other", async ({ page }) => {
    await page.goto(HOME.path);
    await places(page);

    const row = map(page).locator("[data-map-show='1']");
    const pin = map(page).locator("[data-map-pin='1']");

    await row.hover();
    await expect(pin).toHaveAttribute("data-hot", "");
    await pin.locator(".map-pin-body").hover();
    await expect(row).toHaveAttribute("data-hot", "");
    await page.mouse.move(0, 0);
    await expect(row).not.toHaveAttribute("data-hot", "");
    await expect(pin).not.toHaveAttribute("data-hot", "");
  });

  test("with reduced motion the pin appears without falling",
    async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(HOME.path);
      await check(page, HOME.input, "02857");

      const fall = await map(page).locator(".map-drop-fall")
        .evaluate((el) => getComputedStyle(el).animationName);

      expect(fall).toBe("none");
      await expect(dropPin(page)).toBeVisible();
    });

  // Since #136 the home page's only ZIP check is the map's; the news
  // post's "Check your ZIP code" link leads to it.
  test("the news post's ZIP link leads to the map's check",
    async ({ page }) => {
      await page.goto(HOME.path);
      await page.locator(".home-update-card")
        .getByRole("link", { name: "Check your ZIP code" }).click();
      await expect(page).toHaveURL(/#map$/);
      await expect(page.locator(HOME.input)).toBeInViewport();
    });

  // The delivery policy's map is the Delivery layer alone (M10): no
  // switch and no pins; "See pickup spots" goes to the home page's
  // Places.
  test("the delivery policy carries the Delivery map", async ({ page }) => {
    await page.goto(POLICY.path);
    await expect(map(page)).toBeVisible();
    await expect(map(page).locator("[data-zip].is-ours").first())
      .toBeAttached();
    await expect(map(page).getByRole("tab")).toHaveCount(0);
    await expect(map(page).locator("[data-map-pin]")).toHaveCount(0);

    const input = page.locator("[data-zip-check] input").first();

    // "See where we deliver" lands with the field, at the map's foot,
    // in the window.
    await page.locator("a[href='#map-policy']").first().click();
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill("02857");
    await input.press("Enter");
    await expect(dropPin(page)).toBeVisible();
    expect((await drop(page)).fee).toBe("$5");

    await input.fill("01570");
    await input.press("Enter");
    await expect(map(page).locator("[data-map-to-places]"))
      .toHaveAttribute("href", /#places$/);
  });
});
