// The delivery map (#138): an inline SVG of Rhode Island and the
// Connecticut border towns, the ZIPs we deliver to filled from the
// same data as the order form, numbered pins with a key, and a pin
// dropped on any ZIP typed into a check on the page.
// docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

const HOME = { path: "/", input: "#home-map-zip-input" };
const POLICY = { path: "/delivery-policy/" };

// The delivery area the page carries for its ZIP check, as a set.
const areaZips = (page) => page.evaluate(() => {
  const area = JSON.parse(
    document.querySelector("[data-zip-area]").textContent
  );

  return area.states.flatMap((s) => s.towns.flatMap((t) => t.zips));
});

const drop = (page) => page.evaluate(() => {
  const group = document.querySelector("[data-map] [data-map-drop]");
  const at = group.querySelector("[data-map-drop-at]");

  return {
    hidden: group.hidden,
    tone: group.dataset.tone,
    label: group.querySelector("[data-map-drop-label]").textContent,
    at: at.getAttribute("transform"),
    pick: group.querySelector("[data-map-pick]").getAttribute("d"),
  };
});

const zipArea = (page, zip) => page.locator(
  `[data-map] [data-zip='${zip}']`
).evaluate((el) => ({
  at: `translate(${el.dataset.x} ${el.dataset.y})`,
  d: el.getAttribute("d"),
}));

const check = async (page, input, zip) => {
  await page.locator(input).fill(zip);
  await page.locator(input).press("Enter");
  await page.waitForTimeout(200);
};

test.describe("map (#138)", () => {
  test("the ZIPs we deliver to, and nothing from elsewhere",
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

      const map = page.locator("[data-map]");

      await expect(map.locator("svg[role='img'] title")).toContainText(
        "where we deliver"
      );

      const ours = new Set(await areaZips(page));
      const shown = await map.locator("[data-zip]").evaluateAll((els) =>
        els.map((el) => ({
          zip: el.dataset.zip,
          ours: el.classList.contains("is-ours"),
          fill: getComputedStyle(el).fill,
        })));

      expect(shown.length).toBeGreaterThan(50);
      for (const z of shown) {
        expect(z.ours, `${z.zip} filled as ours`).toBe(ours.has(z.zip));
      }

      const fills = new Set(shown.map((z) => `${z.ours}:${z.fill}`));

      expect(fills.size, "one fill for ours, one for the rest").toBe(2);
      expect(foreign, "no third-party requests").toEqual([]);
    });

  test("numbered pins match the key, markets out of season",
    async ({ page }) => {
      await page.goto(HOME.path);

      const map = page.locator("[data-map]");
      const pins = map.locator(".map-pin");
      const key = map.locator(".map-key-n");

      await expect(pins).toHaveCount(await key.count());
      for (let i = 0; i < await pins.count(); i += 1) {
        await expect(pins.nth(i).locator("text")).toHaveText(String(i + 1));
        await expect(key.nth(i)).toHaveText(String(i + 1));
      }
      await expect(map.locator(".map-key-name").first()).toHaveText(
        "Our farm"
      );
      await expect(map.locator(".map-key-head").first()).toContainText(
        "out of season"
      );
      await expect(map.locator(".map-pin.map-pin-market.is-out"))
        .toHaveCount(3);
      for (const ig of await map.locator(".map-ig").all()) {
        await expect(ig).toHaveAttribute(
          "href", /^https:\/\/www\.instagram\.com\/[\w.]+\/$/
        );
        await expect(ig).toHaveAttribute("aria-label", /on Instagram$/);
        await expect(ig.locator("svg")).toBeVisible();
      }
    });

  test("no pin hides another", async ({ page }) => {
    await page.goto(HOME.path);

    const boxes = await page.locator("[data-map] .map-pin").evaluateAll(
      (els) => els.map((el) => {
        const r = el.getBoundingClientRect();

        return { n: el.textContent.trim(), x: r.x, y: r.y, w: r.width,
          h: r.height };
      })
    );

    for (const a of boxes) {
      for (const b of boxes) {
        if (a.n >= b.n) continue;

        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        const shared = Math.max(0, w) * Math.max(0, h) / (a.w * a.h);

        expect(shared, `pins ${a.n} and ${b.n} overlap`).toBeLessThan(0.25);
      }
    }
  });

  test("a ZIP drops a pin on its middle, colored by the answer",
    async ({ page }) => {
      await page.goto(HOME.path);
      await expect(page.locator(HOME.input))
        .toHaveAttribute("autocomplete", "off");

      for (const [zip, tone, label] of [
        ["02857", "ok", "02857: We deliver here"],
        ["02802", "wait", "02802: A little outside our area"],
      ]) {
        await check(page, HOME.input, zip);

        const d = await drop(page);
        const area = await zipArea(page, zip);

        expect(d.hidden, zip).toBe(false);
        expect(d.tone, zip).toBe(tone);
        expect(d.label, zip).toBe(label);
        expect(d.at, `${zip} lands on its middle`).toBe(area.at);
        expect(d.pick, `${zip} outlined`).toBe(area.d);
      }

      // A ZIP the map does not show gets no pin; the words answer.
      await check(page, HOME.input, "10001");
      expect((await drop(page)).hidden).toBe(true);
      await expect(page.locator("[data-map] [data-zip-result]"))
        .toContainText("outside our delivery area");

      // Clearing the field lifts the pin.
      await check(page, HOME.input, "02857");
      await page.locator(HOME.input).fill("");
      await page.locator(HOME.input).dispatchEvent("input");
      await page.waitForTimeout(200);
      expect((await drop(page)).hidden).toBe(true);
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

  test("with reduced motion the pin appears without falling",
    async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(HOME.path);
      await check(page, HOME.input, "02857");

      const fall = await page.locator("[data-map] .map-drop-fall")
        .evaluate((el) => getComputedStyle(el).animationName);

      expect(fall).toBe("none");
      expect((await drop(page)).hidden).toBe(false);
    });

  test("the delivery policy carries the same map", async ({ page }) => {
    await page.goto(POLICY.path);

    const map = page.locator("[data-map]");

    await expect(map).toBeVisible();
    await expect(map.locator("[data-zip].is-ours").first()).toBeAttached();

    const input = page.locator("[data-zip-check] input").first();

    await expect(input).toHaveAttribute("autocomplete", "off");
    await input.fill("02857");
    await input.press("Enter");
    await page.waitForTimeout(200);
    expect((await drop(page)).label).toBe("02857: We deliver here");
  });
});
