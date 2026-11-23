// The map's camera (#862, map/map.js phase 4: the camera), pinned on
// next before the move, so the move must keep it. One test per
// behavior the reviewer of PR #1014 found no spec pinned, each named
// for it. Written from those four behaviors, on the home page's map.
//
// Projects: desktop has the mouse and the wheel; phone is Chromium with
// touch, for the double tap; both measure touch-action and the
// resize. The iphone project runs only its own list of layout and
// accessibility specs, so this file is not among them.
//
// The seam, what the tests rely on: the map is the first [data-map],
// its drawing the [data-map-svg] svg whose viewBox is what the camera
// shows; [data-map-zoom='in'] and ='reset' are its buttons; a pin is
// [data-map-pin].

import { expect, test } from "./support/order.mjs";

const map = (page) => page.locator("[data-map]").first();
const svg = (page) => map(page).locator("[data-map-svg]");

// The camera: the viewBox's width, in map units.
const width = (page) => svg(page).evaluate(
  (el) => Number(el.getAttribute("viewBox").split(" ")[2])
);

// The map's point under a point on screen.
const under = (page, x, y) => svg(page).evaluate((el, at) => {
  const p = new DOMPoint(at.x, at.y).matrixTransform(
    el.getScreenCTM().inverse()
  );

  return { x: p.x, y: p.y };
}, { x, y });

// The middle of the drawing on screen, in view.
const middle = async (page) => {
  await svg(page).scrollIntoViewIfNeeded();

  const box = await svg(page).boundingBox();

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

// A spot on the drawing with nothing under it to pick or open: no
// town, no pin, no control. On Delivery a tap there picks nothing, so
// only the camera can answer a double click or tap.
const bare = async (page) => {
  await svg(page).scrollIntoViewIfNeeded();

  const spot = await svg(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const busy = "[data-zip], [data-map-pin], button, input, a, "
      + ".map-zoom, .map-field, .map-tag";

    for (let i = 1; i < 10; i += 1) {
      for (let j = 1; j < 10; j += 1) {
        const x = r.left + (r.width * i) / 10;
        const y = r.top + (r.height * j) / 10;
        const hit = document.elementFromPoint(x, y);

        if (hit && el.contains(hit) && !hit.closest(busy)) return { x, y };
      }
    }

    return null;
  });

  expect(spot, "a bare spot on the map").not.toBeNull();

  return spot;
};

// The Places layer, once its framing has settled: its pins show.
const places = async (page) => {
  let last = "";

  await map(page).getByRole("tab", { name: "Places" }).click();
  await expect(map(page)).toHaveAttribute("data-layer", "places");
  await expect.poll(async () => {
    const now = await svg(page).getAttribute("viewBox");
    const rest = now === last;

    last = now;
    return rest;
  }, { intervals: [300] }).toBe(true);
};

const open = async (page) => {
  await page.goto("/");
  await expect(svg(page)).toBeVisible();
  await svg(page).scrollIntoViewIfNeeded();
};

const only = (info, name, why) => test.skip(info.project.name !== name,
  why);

test.describe("the map's camera (#862)", () => {
  test("a wheel with ctrl or meta held zooms about the pointer, and the "
    + "page does not scroll; a plain wheel does not zoom",
  async ({ page }, info) => {
    only(info, "desktop", "the wheel is the desktop's");
    await open(page);

    // Whether the last wheel on the map was default-prevented, read
    // once the map's own listener has run.
    await page.evaluate(() => {
      window.lastWheel = null;
      document.addEventListener("wheel", (e) => {
        window.lastWheel = e.defaultPrevented;
      });
    });

    const at = await middle(page);
    const whole = await width(page);

    // A plain wheel: no zoom.
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -200);
    await expect.poll(() => page.evaluate(() => window.lastWheel))
      .toBe(false);
    expect(await width(page), "a plain wheel does not zoom").toBe(whole);

    for (const key of ["Control", "Meta"]) {
      const spot = await middle(page);

      await page.mouse.move(spot.x, spot.y);

      const before = await under(page, spot.x, spot.y);
      const was = await width(page);
      const scrolled = await page.evaluate(() => scrollY);

      await page.evaluate(() => { window.lastWheel = null; });
      await page.keyboard.down(key);
      await page.mouse.wheel(0, -100);
      await page.keyboard.up(key);

      await expect.poll(() => width(page), `${key}: zooms in`)
        .toBeLessThan(was);
      expect(await page.evaluate(() => window.lastWheel),
        `${key}: the wheel is default-prevented`).toBe(true);
      expect(await page.evaluate(() => scrollY),
        `${key}: the page does not scroll`).toBe(scrolled);

      const after = await under(page, spot.x, spot.y);

      expect(Math.hypot(after.x - before.x, after.y - before.y),
        `${key}: the point under the pointer stays under it`)
        .toBeLessThan(1);
    }
  });

  test("a double click zooms in by a factor of 2; a double tap by touch "
    + "does not zoom", async ({ page }, info) => {
    test.skip(!["desktop", "phone"].includes(info.project.name),
      "the mouse is desktop's, the touch the phone's");
    await open(page);

    const at = await bare(page);
    const whole = await width(page);

    if (info.project.name === "desktop") {
      await page.mouse.dblclick(at.x, at.y);
      await expect.poll(() => width(page), "half the width: twice as close")
        .toBeCloseTo(whole / 2, 0);
    } else {
      await page.touchscreen.tap(at.x, at.y);
      await page.touchscreen.tap(at.x, at.y);
      await page.waitForTimeout(600);
      expect(await width(page), "a double tap does not zoom").toBe(whole);
    }
  });

  test("the map's touch-action is pan-y at full size and none when "
    + "zoomed in", async ({ page }, info) => {
    test.skip(!["desktop", "phone"].includes(info.project.name),
      "desktop and phone");
    await open(page);

    const action = () => svg(page).evaluate(
      (el) => getComputedStyle(el).touchAction
    );
    const whole = await width(page);

    expect(await action(), "full size").toBe("pan-y");
    await map(page).locator("[data-map-zoom='in']").click();
    await expect.poll(() => width(page)).toBeLessThan(whole);
    await expect.poll(action, "zoomed in").toBe("none");
    await map(page).locator("[data-map-zoom='reset']").click();
    await expect.poll(() => width(page)).toBeCloseTo(whole, 0);
    await expect.poll(action, "full size again").toBe("pan-y");
  });

  test("after a resize the map redraws so the pins keep their size on "
    + "screen", async ({ page }, info) => {
    test.skip(!["desktop", "phone"].includes(info.project.name),
      "desktop and phone");
    await open(page);
    await places(page);

    const pin = map(page).locator("[data-map-pin]").filter({ visible: true })
      .first();
    const size = () => pin.evaluate((el) => {
      const r = el.getBoundingClientRect();

      return { w: r.width, h: r.height };
    });
    const drawn = () => svg(page).evaluate(
      (el) => el.getBoundingClientRect().width
    );
    const first = page.viewportSize();
    const other = first.width >= 992
      ? { width: 800, height: first.height }
      : { width: 600, height: first.height };

    const was = { pin: await size(), map: await drawn() };

    expect(was.pin.h, "the pin shows").toBeGreaterThan(10);
    await page.setViewportSize(other);
    await expect.poll(drawn, "the drawing changed size")
      .not.toBeCloseTo(was.map, 0);
    await expect.poll(async () => Math.abs((await size()).h - was.pin.h),
      "the pin's height on screen").toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs((await size()).w - was.pin.w),
      "the pin's width on screen").toBeLessThanOrEqual(1);
  });
});
