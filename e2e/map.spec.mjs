// The delivery map (#138): an inline SVG of Rhode Island and its
// neighbours, the ZIPs we deliver to filled from the same data as the
// order form, numbered pins that open cards, a key, zoom, and a pin
// dropped on any ZIP typed into a check on the page or tapped on the
// map. docs/qa-launch.md, "The autumn refresh".
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

  return {
    shown: !group.hasAttribute("hidden"),
    tone: group.dataset.tone,
    label: m.querySelector("[data-map-drop-label]").textContent,
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

test.describe("map (#138)", () => {
  test("three fills: ours, the rest of Rhode Island, the neighbours",
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
      // own tooltip over the map's.
      await expect(map(page).locator("svg[role='img']"))
        .toHaveAttribute("aria-label", /where we deliver/);
      await expect(map(page).locator("svg[role='img'] > title"))
        .toHaveCount(0);

      const ours = new Set(await areaZips(page));
      const shown = await map(page).locator("[data-zip]").evaluateAll(
        (els) => els.map((el) => ({
          zip: el.dataset.zip.slice(1),
          cls: ["is-ours", "is-away", "is-land"]
            .filter((c) => el.classList.contains(c)),
          town: el.dataset.town,
          fill: getComputedStyle(el).fill,
        }))
      );

      expect(shown.length).toBeGreaterThan(50);
      for (const z of shown) {
        expect(z.zip, "a whole ZIP, leading zero kept").toMatch(/^\d{5}$/);
        expect(z.cls, `${z.zip} has one class`).toHaveLength(1);
        expect(z.cls[0] === "is-ours", `${z.zip} filled as ours`)
          .toBe(ours.has(z.zip));
      }

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
      ["is-ours", "We deliver here"],
      ["is-away", "A little outside our area"],
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
  });

  // Since 0660a0d what is on now comes first and is drawn over what is
  // not; the farm wears the hen and no number, so the rest count from 1.
  test("the key matches the pins, what is on now first",
    async ({ page }) => {
      await page.goto(HOME.path);

      const pins = map(page).locator("[data-map-pin]");
      const key = map(page).locator("[data-map-show]");
      const rows = await key.evaluateAll((els) => els.map((el) => ({
        n: el.dataset.mapShow,
        shown: el.querySelector(".map-key-n")?.textContent.trim() || "",
        name: el.querySelector(".map-key-name").textContent.trim(),
        off: !!el.closest(".map-key-list")?.previousElementSibling
          ?.classList.contains("is-off"),
      })));
      const drawn = await pins.evaluateAll((els) => els.map((el) => ({
        n: el.dataset.mapPin,
        shown: el.querySelector("text")?.textContent.trim() || "",
        label: el.getAttribute("aria-label"),
        off: el.classList.contains("is-off"),
      })));

      expect(drawn).toHaveLength(rows.length);
      expect(rows[0]).toMatchObject({ n: "1", name: "Our farm", shown: "" });
      await expect(map(page).locator("[data-map-pin='1']"))
        .toHaveAttribute("aria-label", "Our farm");
      for (const [i, row] of rows.entries()) {
        const pin = drawn.find((d) => d.n === row.n);

        expect(pin, `a pin for ${row.name}`).toBeTruthy();
        expect(pin.shown, row.name).toBe(row.shown);
        expect(pin.label, row.name).toContain(row.name);
        expect(pin.off, `${row.name} on or off alike`).toBe(row.off);
        if (i > 0) expect(row.shown, row.name).toBe(String(i));
      }

      // On before off in the key; off drawn first, so on sits on top.
      const offAt = rows.findIndex((r) => r.off);

      expect(rows.slice(offAt).every((r) => r.off)).toBe(true);
      expect(drawn.findIndex((d) => !d.off))
        .toBeGreaterThan(drawn.findLastIndex((d) => d.off));

      await expect(map(page).locator(".map-key-head")).toContainText([
        "Pick up from us", "Upcoming pop-ups", /^Earlier pop-ups in \d{4}$/,
        "Farmers markets, out of season",
      ]);
      await expect(map(page).locator(".map-pin.map-pin-market.is-off"))
        .toHaveCount(3);
      for (const ig of await map(page).locator(".map-key .map-ig").all()) {
        await expect(ig).toHaveAttribute(
          "href", /^https:\/\/www\.instagram\.com\/[\w.]+\/$/
        );
        await expect(ig).toHaveAttribute("aria-label", /on Instagram$/);
      }
    });

  test("no pin hides another", async ({ page }) => {
    await page.goto(HOME.path);

    const boxes = await map(page).locator("[data-map-pin] .map-pin-body")
      .evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();

        return { n: el.textContent.trim(), x: r.x, y: r.y, w: r.width,
          h: r.height };
      }));

    for (const a of boxes) {
      for (const b of boxes) {
        if (Number(a.n) >= Number(b.n)) continue;

        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        const shared = Math.max(0, w) * Math.max(0, h) / (a.w * a.h);

        expect(shared, `pins ${a.n} and ${b.n} overlap`).toBeLessThan(0.25);
      }
    }
  });

  test("a ZIP typed in drops a visible pin on its middle",
    async ({ page }) => {
      await page.goto(HOME.path);
      await expect(page.locator(HOME.input))
        .toHaveAttribute("autocomplete", "off");
      await expect(dropPin(page)).toBeHidden();

      for (const [zip, tone, label] of [
        ["02857", "ok", /^02857 .+: We deliver here$/],
        ["02802", "wait", /^02802 .+: A little outside our area$/],
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
        expect(d.label, zip).toMatch(label);
        expect(d.at, `${zip} lands on its middle`)
          .toMatch(new RegExp(`^translate\\(${x} ${y}\\)`));
        expect(d.pick, `${zip} outlined`)
          .toBe(await shape.getAttribute("d"));
      }

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
      // The middle might sit under a pin; tap the shape where it is.
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

  test("a town names itself under the pointer", async ({ page }) => {
    test.skip(!!test.info().project.use.isMobile, "a mouse");
    await page.goto(HOME.path);

    const shape = zipShape(page, "02857");

    await shape.scrollIntoViewIfNeeded();

    const town = await shape.getAttribute("data-town");
    const box = await shape.boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 2,
      box.y + box.height / 2 + 2);

    const tip = map(page).locator("[data-map-tip]");

    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/: (We deliver here|A little outside)/);
    if (town) await expect(tip).toContainText(town);
  });

  test("a pin opens its card; Escape closes it to the pin",
    async ({ page }) => {
      await page.goto(HOME.path);

      const pin = map(page).locator("[data-map-pin='1']");
      const card = map(page).locator("[data-map-card='1']");

      await pin.scrollIntoViewIfNeeded();
      await pin.focus();
      await page.keyboard.press("Enter");
      await expect(card).toBeVisible();
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect(card.locator(".map-card-name")).toBeFocused();
      await expect(card.locator(".map-card-name")).toContainText("Our farm");
      await expect(card.getByRole("link", { name: "Directions" }))
        .toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\//);
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

  test("a line in the key opens the same card", async ({ page }) => {
    await page.goto(HOME.path);

    const line = map(page).locator("[data-map-show]", {
      hasText: "Foster Farmers Market",
    });
    const n = await line.getAttribute("data-map-show");

    await line.click();

    const card = map(page).locator(`[data-map-card='${n}']`);

    await expect(card).toBeVisible();
    await expect(card).toContainText("Out of season");
    await expect(card).toBeInViewport();
    await card.locator("[data-map-card-close]").click();
    await expect(card).toBeHidden();
  });

  test("zoom in and out; pins keep their size", async ({ page }) => {
    await page.goto(HOME.path);

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
  // post's "Check your ZIP code" button leads to it.
  test("the news post's ZIP button leads to the map's check",
    async ({ page }) => {
      await page.goto(HOME.path);
      await page.locator(".delivery-cta a").click();
      await expect(page).toHaveURL(/#map$/);
      await expect(page.locator(HOME.input)).toBeInViewport();
    });

  test("the delivery policy carries the same map", async ({ page }) => {
    await page.goto(POLICY.path);
    await expect(map(page)).toBeVisible();
    await expect(map(page).locator("[data-zip].is-ours").first())
      .toBeAttached();

    const input = page.locator("[data-zip-check] input").first();

    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill("02857");
    await input.press("Enter");
    await expect(dropPin(page)).toBeVisible();
    expect((await drop(page)).label).toMatch(/^02857 .+: We deliver here$/);
  });
});
