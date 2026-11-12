// The pickup picker's hero screens in their main states (#574), saved
// as pictures at 390, 768, 1024 and 1440 px under
// test-results/picker-states/, for James to judge Round 2 of the
// picker bracket. It asserts little: the orchestrator runs it by name
// (docs/cloud-lanes.md, "Checks") and posts the pictures. Written, not
// run, by the cloud lane that built it.
//
// The states are picker-states/states.mjs's, the ones the staging and
// preview switcher shows, answered here by routes as the switcher's
// own fetch does there, so this runs on a local build too. It sets
// its own widths, so the phone project skips it (playwright.config).

import { readFileSync } from "node:fs";

import {
  CUSTOMER, ORDER_ID, build, open,
} from "../assets/scripts/picker-states/states.mjs";
import { dates } from "./support/canned.mjs";
import { OrderPage, SKU, expect, test } from "./support/order.mjs";

const json = (name) => JSON.parse(readFileSync(
  new URL(`../data/${name}.json`, import.meta.url), "utf8",
));
const series = json("series").series;
const locations = json("locations").locations;

const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1024, height: 768 },
  { name: "wide", width: 1440, height: 900 },
];

// Answers the page as the switcher does for `key`: the dates, and the
// customer and order for a state that has one. -> the state's plan.
const answer = async (page, key) => {
  const since = new Date();
  const plan = build(key, { series, locations, now: since, sku: SKU.eggs });

  await page.route("**/api/dates", (route) => {
    if (plan.loading) return new Promise(() => {});
    if (plan.failed) return route.fulfill({ status: 503, json: { ok: false } });

    return route.fulfill({ json: {
      ...dates(), scheduled: open(plan.scheduled, new Date()),
    } });
  });
  if (plan.order) {
    await page.route("**/api/me", (route) => route.fulfill({
      json: { signedIn: true, customer: CUSTOMER },
    }));
    await page.route("**/api/account/orders", (route) => route.fulfill({
      json: { orders: [plan.order] },
    }));
  }
  if (plan.draft) {
    await page.addInitScript((draft) => localStorage.setItem(
      "nff-order-draft", JSON.stringify(draft)
    ), plan.draft);
  }

  return plan;
};

const card = (page) => page.locator(".order-method:has(#method-scheduled)");

// The scheduled card at the top of the screen, under the sticky bar,
// after any fold or unfold has run.
const shot = async (page, width, name, target = card(page)) => {
  await target.evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    window.scrollBy(0, -96);
  });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `test-results/picker-states/${width.width}-${name}.png`,
    animations: "disabled",
  });
};

// The first open day that has `n` pickups, as its radio's label.
const dayWith = (page, n) => page.locator(
  "#pickup .pickup-picker-cell:has(input:not(:disabled))"
).filter({ hasText: new RegExp(`\\b${n} pickups?\\b`) }).first()
  .locator("label");

for (const width of WIDTHS) {
  test.describe(`picker states at ${width.width} px`, () => {
    test.use({ viewport: { width: width.width, height: width.height } });

    test("open, then a day with two places, settled and reopened",
      async ({ page }) => {
        await answer(page, "two");

        const order = new OrderPage(page);

        await order.open({ eggs: 1 }, { method: "scheduled" });
        await expect(page.locator("#scheduled-pickups input").first())
          .toBeAttached();
        await shot(page, width, "1-open");

        await dayWith(page, 2).click();
        await page.locator("#scheduled-pickups .order-pickup:not([hidden])")
          .last().locator("label").click();
        await shot(page, width, "2-day-with-two-chosen");

        await page.locator("#customer-first-name").focus();
        await expect(card(page).locator("[data-picker-settled]"))
          .toBeAttached();
        await shot(page, width, "3-settled");

        await card(page).getByRole("button", { name: "Change pickup" })
          .click();
        await shot(page, width, "4-reopened");
      });

    test("one place only", async ({ page }) => {
      await answer(page, "one");
      await new OrderPage(page).open({ eggs: 1 }, { method: "scheduled" });
      await dayWith(page, 1).click();
      await shot(page, width, "5-one-place");
    });

    test("several places", async ({ page }) => {
      await answer(page, "several");
      await new OrderPage(page).open({ eggs: 1 }, { method: "scheduled" });
      await dayWith(page, 1).click();
      await shot(page, width, "6-several-places");
    });

    test("a group round far out", async ({ page }) => {
      await answer(page, "round");
      await new OrderPage(page).open({ eggs: 1 }, { method: "scheduled" });
      await page.locator("#pickup .pickup-picker-row[data-gap] " +
        ".pickup-picker-cell:has(input:not(:disabled)) label").first().click();
      await shot(page, width, "7-group-round");
    });

    test("a draft whose date moved", async ({ page }) => {
      await answer(page, "moved");
      await new OrderPage(page).open();
      await expect(card(page).locator("[data-picker-note]")).toBeVisible();
      await shot(page, width, "8-draft-moved");
    });

    test("a chosen pickup that closes", async ({ page }) => {
      test.setTimeout(120_000);
      await answer(page, "closing");
      await new OrderPage(page).open();
      await shot(page, width, "9-closing-before");
      // The cutoff is 45 s after the state was built; the page asks
      // again a second after it.
      await expect(card(page).locator("[data-picker-instead]"))
        .toBeVisible({ timeout: 70_000 });
      await shot(page, width, "10-closed");
    });

    test("nothing available", async ({ page }) => {
      await answer(page, "none");
      await new OrderPage(page).open({ eggs: 1 });
      await shot(page, width, "11-nothing");
    });

    test("loading", async ({ page }) => {
      await answer(page, "loading");
      await page.goto("/order/?method=scheduled");
      await shot(page, width, "12-loading");
    });

    test("a failed load", async ({ page }) => {
      await answer(page, "failed");
      await page.goto("/order/?method=scheduled");
      await expect(page.locator("#pickup [data-dates-region]").first())
        .toBeAttached();
      await page.waitForTimeout(1_000);
      await shot(page, width, "13-failed");
    });

    test("?edit= with As booked", async ({ page }) => {
      await answer(page, "edit");
      await page.goto(`/order/?edit=${ORDER_ID}`);
      await expect(card(page).locator(".order-pickup-booked:not([hidden])"))
        .toBeAttached();
      await shot(page, width, "14-edit-as-booked");
      await card(page).getByRole("button", { name: "Change pickup" })
        .click();
      await shot(page, width, "15-edit-reopened");
    });

    test("the account's Change pickup, As booked, then moved",
      async ({ page }) => {
        await answer(page, "account");
        await page.goto("/account/#orders");
        await page.getByRole("button", { name: "Change pickup" }).first()
          .click();

        const panel = page.locator("[data-scheduled-picker]");

        await expect(panel).toBeVisible();
        await shot(page, width, "16-account-as-booked", panel);
        await panel.locator(".pickup-picker-cell:has(input:not(:disabled)) " +
          "label").first().click();
        await shot(page, width, "17-account-moved", panel);
      });

    test("the lapsed dialog, preset to the same place's next date",
      async ({ page }) => {
        const plan = await answer(page, "lapsed");
        const bad = plan.draft.payload.fulfilment.occurrence;

        // The page's own check raises the dialog; were it to pass, the
        // server's 409 does, with the list less the lapsed pickup.
        await page.route("**/api/orders", (route) => (
          route.request().method() === "POST"
            ? route.fulfill({ status: 409, json: {
              ok: false,
              dates: plan.scheduled.filter((e) => e.occurrence !== bad),
            } })
            : route.fallback()
        ));

        const order = new OrderPage(page);

        await order.open();
        await order.contact({ email: "picker-states@example.com" });
        await order.openCard();
        await order.card();
        await order.submit.click();

        const dialog = page.locator("#order-lapsed");

        await expect(dialog).toBeVisible();
        await page.waitForTimeout(500);
        await page.screenshot({
          path: `test-results/picker-states/${width.width}-18-lapsed.png`,
          animations: "disabled",
        });
        await dialog.getByRole("button", { name: "Choose another day" })
          .click();
        await page.waitForTimeout(500);
        await page.screenshot({
          path: `test-results/picker-states/${width.width}-19-lapsed-open.png`,
          animations: "disabled",
        });
      });
  });
}
