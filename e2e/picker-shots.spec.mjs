// Pictures of the pickup picker as a timetable (#573, Round 2 of the
// picker bracket on #540), for James to judge beside the other
// direction: each hero screen in its main states at 390, 768, 1024
// and 1440 px, saved under test-results/picker-timetable/ and attached
// to the report. Nothing is asserted but what a picture needs.
//
// The states are the switcher's (staging/picker-states.mjs), built
// from the farm's own public series and places at the time of the run;
// the specs answer /api/dates with them here, since a local build
// carries no switcher. Run by name, desktop project only (it sets its
// own widths):
//
//   gh workflow run e2e.yml --ref lane/cloud-573 \
//     -f specs="e2e/picker-shots.spec.mjs"

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CLOSED } from "../assets/scripts/order/lib/picker.mjs";
import {
  SAMPLE_ORDER, answerAt, dropCodeOf, openList, stateParts,
} from "../assets/scripts/staging/picker-states.mjs";
import { CUSTOMER, ORDER_SCHEDULED, dates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";

const data = (name) => JSON.parse(readFileSync(
  new URL(`../data/${name}.json`, import.meta.url), "utf8",
));
const { locations } = data("locations");
const { series } = data("series");
const { timeZone } = data("delivery");
const SKU = data("catalog").groups.flatMap((g) => g.items)
  .find((i) => i.inStock).sku;

const OUT = join(import.meta.dirname, "..", "test-results",
  "picker-timetable");
const WIDTHS = [390, 768, 1024, 1440];
const HEIGHT = { 390: 844, 768: 1024, 1024: 768, 1440: 900 };

const partsFor = (key) => {
  const now = new Date();

  return stateParts(key, {
    now, timeZone, dropCode: dropCodeOf(series), sku: SKU,
    list: openList({ now, timeZone, locations, series }),
  });
};

// /api/dates answered with the state's list, what is still open at
// each answer; the lapsed state's pickup goes after the first.
// `hold` never answers (loading); a null list fails (503).
const routeDates = (page, parts, { hold = false } = {}) => {
  let answered = 0;

  return page.route("**/api/dates", async (route) => {
    answered += 1;
    if (hold) return;
    if (parts.scheduled === null) {
      await route.fulfill({ status: 503, json: {} });

      return;
    }

    const now = Date.now();
    const list = answerAt(parts.scheduled, now).filter((d) => !parts.lapse
      || answered === 1 || d.occurrence !== parts.lapse.occurrence);

    await route.fulfill({ json: {
      ...dates(), now: new Date(now).toISOString(), scheduled: list,
    } });
  });
};

// The draft a state restores, with one item in the cart.
const seedDraft = (page, fulfilment) => page.addInitScript((value) => {
  window.localStorage.setItem("nff-order-draft", JSON.stringify(value));
}, { payload: { lines: [{ sku: SKU, qty: 1 }], customer: {}, fulfilment },
  savedAt: Date.now() });

const shoot = async (target, testInfo, name) => {
  const file = join(OUT, `${name}.png`);

  mkdirSync(OUT, { recursive: true });
  await target.screenshot({ path: file, animations: "disabled" });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
};

const card = (page) => page.locator(".order-method")
  .filter({ has: page.locator("#method-scheduled") });
// The chips a customer taps (labels over Bootstrap's .btn-check).
const chips = (page) => page.locator("#scheduled-pickups .pickup-picker-btn");

// Brings the card into view and takes it, and at 390 px the screen
// too, with the cart's sheet over the bottom.
const shootCard = async (page, testInfo, name, width) => {
  const box = card(page);

  await box.scrollIntoViewIfNeeded();
  // Past the chips' and the cart's transitions.
  await page.waitForTimeout(400);
  await shoot(box, testInfo, `order-${name}-${width}`);
  if (width === 390) {
    await shoot(page, testInfo, `order-${name}-${width}-screen`);
  }
};

const desktopOnly = (testInfo) => test.skip(
  testInfo.project.name !== "desktop", "sets its own widths",
);

// The order page's Pickup days card, in each state with a list.
const LISTED = ["several", "one", "shared", "group", "moved"];

for (const width of WIDTHS) {
  test.describe(`the timetable at ${width} px`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize({ width, height: HEIGHT[width] });
    });

    for (const key of LISTED) {
      test(`order page: ${key}`, async ({ page }, testInfo) => {
        const parts = partsFor(key);

        await routeDates(page, parts);
        await seedDraft(page, parts.draft || { method: "scheduled" });

        const order = new OrderPage(page);

        await order.open();
        await expect(chips(page).first()).toBeVisible();
        await shootCard(page, testInfo, key, width);
      });
    }

    test("order page: a chosen pickup closes", async ({ page }, testInfo) => {
      const parts = partsFor("closing");
      const [soon] = parts.scheduled;

      // Four seconds on, not the switcher's half minute.
      parts.scheduled[0] = { ...soon,
        cutoff: new Date(Date.now() + 4000).toISOString() };
      await routeDates(page, parts);
      await seedDraft(page, parts.draft);

      const order = new OrderPage(page);

      await order.open();
      await expect(chips(page).first()).toBeVisible();
      await shootCard(page, testInfo, "closing-before", width);
      await expect(card(page).locator("[data-picker-note]"))
        .toHaveText(CLOSED, { timeout: 15_000 });
      await shootCard(page, testInfo, "closing-closed", width);
    });

    test("order page: ?edit= As booked", async ({ page }, testInfo) => {
      const parts = partsFor("edit");

      await routeDates(page, parts);
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { ok: true, orders: [parts.order] },
      }));
      await page.goto(`/order/?edit=${SAMPLE_ORDER}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(chips(page).first()).toBeVisible();
      await shootCard(page, testInfo, "edit", width);
    });

    test("order page: a chip chosen", async ({ page }, testInfo) => {
      const parts = partsFor("several");

      await routeDates(page, parts);
      await seedDraft(page, { method: "scheduled" });

      const order = new OrderPage(page);

      await order.open();
      await expect(chips(page).first()).toBeVisible();
      // The last chip, as a customer would tap it.
      await chips(page).last().click();
      await shootCard(page, testInfo, "chosen", width);
    });

    test("order page: nothing available", async ({ page }, testInfo) => {
      await routeDates(page, partsFor("nothing"));

      const order = new OrderPage(page);

      await order.open();
      await expect(card(page).locator("[data-scheduled-none]"))
        .toBeVisible();
      await shootCard(page, testInfo, "nothing", width);
    });

    test("order page: loading", async ({ page }, testInfo) => {
      await routeDates(page, partsFor("loading"), { hold: true });
      await seedDraft(page, { method: "scheduled" });
      await page.goto("/order/", { waitUntil: "domcontentloaded" });
      await expect(card(page).locator("[data-load='shown']"))
        .toBeVisible();
      await shootCard(page, testInfo, "loading", width);
    });

    test("order page: a failed load", async ({ page }, testInfo) => {
      await routeDates(page, partsFor("failed"));
      await seedDraft(page, { method: "scheduled" });
      await page.goto("/order/", { waitUntil: "domcontentloaded" });
      await expect(card(page).locator(".skeleton-failed")).toBeVisible();
      await shootCard(page, testInfo, "failed", width);
    });

    test("lapsed dialog", async ({ page }, testInfo) => {
      const parts = partsFor("lapsed");

      test.skip(!parts.lapse, "nothing open to lapse");
      await routeDates(page, parts);
      await seedDraft(page, parts.draft);

      const order = new OrderPage(page);

      await order.open();
      await expect(chips(page).first()).toBeVisible();
      await order.contact({ email: "picker-shots@example.com" });
      await order.openCard();
      await order.card();
      await order.submit.click();

      const dialog = page.locator("#order-lapsed");

      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".pickup-picker-gone")).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, testInfo, `lapsed-${width}`);
    });

    test("account: Change pickup", async ({ page, context, baseURL },
      testInfo) => {
      const parts = partsFor("several");
      const drop = parts.scheduled.filter((d) => d.series
        === dropCodeOf(series)).at(-1) || parts.scheduled[0];

      test.skip(!drop, "nothing open to book");

      const order = {
        ...ORDER_SCHEDULED, canChange: true,
        fulfilment: { ...ORDER_SCHEDULED.fulfilment,
          occurrence: drop.occurrence, date: drop.date },
        pickup: { name: drop.name, place: drop.place, window: drop.window,
          occurrence: drop.occurrence, series: drop.series, gone: false },
      };

      await context.addCookies([{
        name: "nff_signed_in", value: "1", url: baseURL,
      }]);
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [order] },
      }));
      await page.route("**/api/account/cart", (route) => route.fulfill({
        json: { ok: true, cart: null },
      }));
      await routeDates(page, parts);
      await page.goto("/account/#orders");
      await page.getByRole("button", { name: /^Change (delivery|pickup)$/ })
        .first().click();

      const panel = page.locator(".account-panel-form").first();

      await expect(panel.locator(".pickup-picker-btn").first())
        .toBeVisible();
      await page.waitForTimeout(400);
      await shoot(panel, testInfo, `account-as-booked-${width}`);
      // Another pickup: the summary says where it moves to.
      await panel.locator(".pickup-picker-btn").first().click();
      await shoot(panel, testInfo, `account-moving-${width}`);
    });
  });
}
