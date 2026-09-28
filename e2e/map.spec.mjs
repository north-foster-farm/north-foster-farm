// The map (#138), in two layers since #214: an inline SVG of Rhode
// Island and its neighbours. Delivery: the ZIPs we deliver to shaded
// from the same data as the order form, by price, a key, and a pin
// dropped on any ZIP typed into a check on the page or tapped on the
// map, with a tag. Places: one blue pin for every place, a directory
// that opens their cards, one card template. Both zoom.
// docs/qa-launch.md, "The autumn refresh".
//
// Visibility is read from what renders, never from a script property:
// an SVG group has no `hidden` property, and a check that read one
// passed while the dropped pin never showed (fixed in 17b929e).

import { expect, test } from "./support/order.mjs";

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
const dropPin = (page) => map(page).locator(".map-drop-pin");

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

const places = async (page) => {
  await map(page).getByRole("tab", { name: "Places" }).click();
  await expect(map(page)).toHaveAttribute("data-layer", "places");
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
      left: r.left, right: r.right };
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

      const [a, b] = await Promise.all([
        swatch.evaluate((el) => getComputedStyle(el).backgroundColor),
        map(page).locator(`.map-zip.${cls}`).first()
          .evaluate((el) => getComputedStyle(el).fill),
      ]);

      expect(a, cls).toBe(b);
    }

    // Then how the tag marks what we deliver: a struck-through icon.
    const rows = map(page).locator(".map-key-areas li");

    await expect(rows).toHaveText([
      "$5 delivery", "$8 delivery", "We deliver it", "Not delivered there",
    ]);
    await expect(rows.nth(3).locator(".map-tag-icon.is-off")).toHaveCount(1);
    await expect(map(page).locator(".map-swatch.is-eggs")).toHaveCount(0);
  });

  // Places: the directory beside the map names every pin, under
  // "Pickup" and "Markets and pop-ups"; each name opens its pin's card.
  // Every pin is drawn alike, and none shows on the Delivery layer.
  test("the Places directory matches the pins", async ({ page }) => {
    await page.goto(HOME.path);

    const pins = map(page).locator("[data-map-pin]");

    await expect(pins.first()).toBeHidden();
    await expect(map(page).locator(".map-places")).toBeHidden();
    await places(page);
    await expect(pins.first()).toBeVisible();
    await expect(map(page).locator(".map-key-areas")).toBeHidden();

    const rows = await map(page).locator("[data-map-show]").evaluateAll(
      (els) => els.map((el) => ({
        n: el.dataset.mapShow,
        name: el.firstChild.textContent.trim(),
        head: el.closest("ul").previousElementSibling.textContent.trim(),
      }))
    );
    const drawn = await pins.evaluateAll((els) => els.map((el) => ({
      n: el.dataset.mapPin,
      label: el.getAttribute("aria-label"),
      fill: getComputedStyle(el.querySelector("path")).fill,
    })));

    expect(rows.slice(0, 2)).toMatchObject([
      { name: "Our farm", head: "Pickup" },
      { name: "Drop site", head: "Pickup" },
    ]);
    for (const row of rows.slice(2)) {
      expect(row.head, row.name).toBe("Markets and pop-ups");
    }
    for (const row of rows) {
      expect(drawn.find((d) => d.n === row.n), `a pin for ${row.name}`)
        .toBeTruthy();
    }
    for (const pin of drawn) {
      expect(rows.some((r) => r.n === pin.n), `${pin.label} listed`)
        .toBe(true);
    }
    // The drop site and the Scituate market are one place, one pin.
    const drop = rows.find((r) => r.name === "Drop site");
    const market = rows.find((r) => /^Scituate/.test(r.name));

    if (market) expect(market.n).toBe(drop.n);
    expect(new Set(drawn.map((d) => d.fill)).size, "one pin colour")
      .toBe(1);
    await expect(map(page).locator(".map-key-n, .map-ig, [data-stack]"))
      .toHaveCount(0);
    await expect(map(page)).not.toContainText("Out of season");
  });

  // The farm and the Foster market meet at the whole map: each stands
  // a little aside, so both can be tapped, and both come back to their
  // places once zoomed in. Every other tip is on its place at every
  // zoom: the Foster market's tip once fell in Connecticut on a phone.
  test("pins stand on their places; the farm and Foster stand apart",
    async ({ page }) => {
      await page.goto(HOME.path);
      await places(page);

      const svg = map(page).locator("[data-map-svg]");
      const width = () => svg.evaluate(
        (el) => Number(el.getAttribute("viewBox").split(" ")[2])
      );

      await svg.scrollIntoViewIfNeeded();
      const full = await width();
      const whole = await tips(page);
      const farm = whole.find((t) => t.n === "North Foster Farm");
      const foster = whole.find((t) => t.n === "Foster Farmers Market");

      for (const t of whole) {
        expect(Math.abs(t.dy), t.n).toBeLessThanOrEqual(1);
        expect(Math.abs(t.dx), t.n)
          .toBeLessThanOrEqual(t.nudge ? 16 : 1);
      }
      if (farm && foster) {
        expect(farm.left >= foster.right - 2 || foster.left >= farm.right - 2,
          "the farm and the Foster market side by side").toBe(true);
      }

      await map(page).locator("[data-map-zoom='in']").click();
      await expect.poll(width).toBeCloseTo(full / 2, 0);
      for (const t of await tips(page)) {
        expect(Math.hypot(t.dx, t.dy), `${t.n}, zoomed`)
          .toBeLessThanOrEqual(1);
      }
    });

  test("one place, one pin: the drop site's card lists the market too",
    async ({ page }) => {
      await page.goto(HOME.path);
      await places(page);
      await map(page).locator("[data-map-show]", { hasText: "Drop site" })
        .click();

      const card = map(page).locator("[data-map-card]:not([hidden])");
      const when = card.locator(".map-card-when li");

      await expect(card).toHaveCount(1);
      await expect(card.locator(".map-card-shop"))
        .toHaveAttribute("href", /\/order\/\?method=scituate$/);
      await expect(when.last()).toContainText("Drop site pickup");
      // The market's entry stands while it runs.
      if (await when.count() === 2) {
        await expect(card.locator(".map-card-kind"))
          .toHaveText("Farmers market and drop site");
        await expect(when.first()).toContainText("Scituate");
        await expect(card.getByRole("link", { name: "Market website" }))
          .toBeVisible();
      } else {
        await expect(card.locator(".map-card-kind")).toHaveText("Drop site");
      }
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

        const box = await svg.boundingBox();

        await page.touchscreen.tap(box.x + box.width - 4,
          box.y + box.height - 4);
        await expect(card).toBeHidden();
      });
  });

  test("a ZIP typed in drops a visible pin on its middle",
    async ({ page }) => {
      await page.goto(HOME.path);
      await expect(page.locator(HOME.input))
        .toHaveAttribute("autocomplete", "off");
      await expect(dropPin(page)).toBeHidden();

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
      await expect(dropPin(page)).toBeHidden();
      await map(page).getByRole("tab", { name: "Delivery" }).click();

      // A ZIP the map does not show gets no pin; the words answer.
      await check(page, HOME.input, "10001");
      await expect(dropPin(page)).toBeHidden();
      await expect(map(page).locator("[data-zip-result]"))
        .toContainText("outside our delivery area");

      // Clearing the field lifts the pin.
      await check(page, HOME.input, "02857");
      await expect(dropPin(page)).toBeVisible();
      await page.locator(HOME.input).fill("");
      await page.locator(HOME.input).dispatchEvent("input");
      await expect(dropPin(page)).toBeHidden();
    });

  // Lincoln lies on the map's top edge. The zoom sits above the map
  // since #214, so the tag has only the frame to keep inside.
  test("the tag keeps inside the frame", async ({ page }) => {
    await page.goto(HOME.path);
    await check(page, HOME.input, "02865");

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
    expect(zoom.y + zoom.height, "the zoom above the map")
      .toBeLessThanOrEqual(frame.y);
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
      await expect(dropPin(page)).toBeHidden();
      await expect(map(page).locator(".map-pick")).toBeHidden();

      // Water, at the frame's bottom right corner.
      await page.mouse.click(...warwick);
      await expect(dropPin(page)).toBeVisible();

      const box = await svg.boundingBox();

      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
      await expect(page.locator(HOME.input)).toHaveValue("");
      await expect(dropPin(page)).toBeHidden();
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
        .toContainText("We deliver to");
      await expect(dropPin(page)).toBeVisible();
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

  test("a pin opens its card; Escape closes it to the pin",
    async ({ page }) => {
      await page.goto(HOME.path);
      await places(page);

      const pin = map(page).locator("[data-map-pin='1']");
      const card = map(page).locator("[data-map-card='1']");

      await pin.scrollIntoViewIfNeeded();
      await pin.focus();
      await page.keyboard.press("Enter");
      await expect(card).toBeVisible();
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect(card.locator(".map-card-name")).toBeFocused();
      // One template: what kind of place, then its name.
      await expect(card.locator(".map-card-kind")).toHaveText("Our farm");
      await expect(card.locator(".map-card-name"))
        .toContainText("North Foster Farm");
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

      // The card sits inside the map's frame.
      const frame = await map(page).locator("[data-map-frame]").boundingBox();
      const c = await card.boundingBox();

      expect(c.x).toBeGreaterThanOrEqual(frame.x - 1);
      expect(c.x + c.width).toBeLessThanOrEqual(frame.x + frame.width + 1);

      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(pin).toBeFocused();
      await expect(pin).toHaveAttribute("aria-pressed", "false");
    });

  // A name in the directory opens the same card. Markets and pop-ups
  // have no shop button, and their links are labeled.
  test("a name in the directory opens the same card", async ({ page }) => {
    await page.goto(HOME.path);
    await places(page);

    const line = map(page).locator("[data-map-show]", {
      hasText: "Foster Farmers Market",
    });

    test.skip(await line.count() === 0, "the Foster market has closed");
    const n = await line.getAttribute("data-map-show");

    await line.click();

    const card = map(page).locator(`[data-map-card='${n}']`);

    await expect(map(page)).toHaveAttribute("data-layer", "places");
    await expect(card).toBeVisible();
    await expect(line).toHaveAttribute("aria-pressed", "true");
    await expect(card.locator(".map-card-kind")).toHaveText("Farmers market");
    await expect(card).toContainText("June through October");
    await expect(card).not.toContainText("Out of season");
    await expect(card.locator(".map-card-shop")).toHaveCount(0);
    await expect(card.locator(".map-card-links a"))
      .toHaveText(["Website", "Instagram"]);
    await expect(card).toBeInViewport();
    await card.locator("[data-map-card-close]").click();
    await expect(card).toBeHidden();
  });

  test("zoom in and out; pins keep their size", async ({ page }) => {
    await page.goto(HOME.path);
    await places(page);

    const svg = map(page).locator("[data-map-svg]");
    const width = () => svg.evaluate(
      (el) => Number(el.getAttribute("viewBox").split(" ")[2])
    );
    const pinHeight = () => map(page).locator("[data-map-pin='1']")
      .evaluate((el) => el.getBoundingClientRect().height);
    const zoomIn = map(page).locator("[data-map-zoom='in']");
    const zoomOut = map(page).locator("[data-map-zoom='out']");
    const reset = map(page).locator("[data-map-zoom='reset']");

    await svg.scrollIntoViewIfNeeded();

    const full = await width();
    const pinAtFull = await pinHeight();

    expect(pinAtFull, "the pin shows").toBeGreaterThan(20);
    await expect(zoomOut).toBeDisabled();
    await expect(reset).toBeHidden();

    await zoomIn.click();
    await expect.poll(width).toBeCloseTo(full / 2, 0);
    await expect(zoomOut).toBeEnabled();
    await expect(reset).toBeVisible();
    expect(Math.abs(await pinHeight() - pinAtFull), "pin size on screen")
      .toBeLessThanOrEqual(2);

    await reset.click();
    await expect.poll(width).toBeCloseTo(full, 0);
    await expect(zoomOut).toBeDisabled();
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
