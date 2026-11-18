// The pickup-day picker (#540) out of `next` (#617): the order page,
// the lapsed dialog and the account's Change pickup offer scheduled
// pickups as production does (main, 329738cf), and no week strip, no
// picker markup, styles or scripts ship. Criteria tests, written
// before the change from the issue's spec and "Done when"; one test
// per criterion, named for it.
//
// Production's way, from main: on the order page every open pickup is
// a radio in #scheduled-pickups, all shown at once, none chosen until
// the customer chooses; the lapsed dialog lists the fresh pickups as
// radios labelled "<day>: <name>, <town>, <window>"; Change pickup
// moves a scheduled pickup with the day select, [data-dates]. The
// specs restored to their pre-picker expectations (order-scheduled,
// scheduled-pickup, order-draft-date, account, group-credit) hold the
// rest of production's behavior.
//
// The picker's markers, any of which means it shipped: its root
// [data-picker] and parts [data-picker-*] (the week strip
// [data-picker-strip], its days [data-picker-day]), the
// .pickup-picker block, the account's [data-scheduled-picker] slot,
// and the pickup-picker partial's and stylesheet's names.

import {
  OrderPage, expect, pickupRadios, pickupValues, test,
} from "./support/order.mjs";
import {
  CANNED, CUSTOMER, ORDER_SCHEDULED, cannedDates, dates,
} from "./support/canned.mjs";
import {
  DROP, cannedScheduled, datesWith, payable,
} from "./support/scheduled.mjs";

const MARKUP = "[data-picker], [data-picker-strip], [data-picker-day], " +
  "[data-picker-week], [data-picker-pickups], .pickup-picker, " +
  "[data-scheduled-picker]";
const NAMES = /pickup-picker|data-picker|data-scheduled-picker/;

// No picker in the page's DOM, nor in its templates' content, which a
// DOM query does not reach.
const noPicker = async (page, scope) => {
  await expect(scope.locator(MARKUP)).toHaveCount(0);

  const html = await page.content();

  expect(html.match(NAMES), "the picker's names in the page").toBeNull();
};

test.describe("the picker out of next (#617)", () => {
  test("the order page offers scheduled pickups as production does, " +
    "with no picker", async ({ page }) => {
    const lists = datesWith();

    await cannedScheduled(page, lists);

    const order = new OrderPage(page);

    await order.open({ eggs: 1 }, { method: "scheduled" });
    // Every pickup a radio, all shown at once: no day to choose first.
    await expect(pickupRadios(page)).toHaveCount(lists.scheduled.length);
    for (const radio of await pickupRadios(page).all()) {
      await expect(radio).toBeVisible();
      await expect(radio).not.toBeChecked();
    }
    expect(await pickupValues(page))
      .toEqual(lists.scheduled.map((d) => d.occurrence));
    await noPicker(page, page.locator("body"));
  });

  test("the lapsed dialog offers scheduled pickups as production does, " +
    "with no picker", async ({ page }) => {
    const lists = payable();

    await cannedScheduled(page, lists);
    await page.route("**/api/orders", (route) => (
      route.request().method() === "POST"
        ? route.fulfill({
          status: 409, json: { ok: false, dates: lists.scheduled },
        })
        : route.fallback()
    ));

    const order = new OrderPage(page);

    await order.open({ eggs: 1 }, { method: "scheduled" });
    await order.scheduled(DROP.series);
    await order.contact({ email: "lapsed@example.com" });
    await order.openCard();
    await order.card();
    await order.submit.click();

    const dialog = page.locator("#order-lapsed");
    const choices = dialog.locator("input[type='radio']");

    await expect(dialog).toBeVisible();
    await expect(choices).toHaveCount(lists.scheduled.length);
    for (const radio of await choices.all()) {
      await expect(radio).toBeVisible();
    }
    await expect(dialog.locator("label")).toHaveText(
      lists.scheduled.map((d) =>
        `${d.label}: ${DROP.name}, ${DROP.town}, ${DROP.window}`)
    );
    await noPicker(page, dialog);
  });

  test("Change pickup offers scheduled pickups as production does, " +
    "with no picker", async ({ page, context, baseURL }) => {
    const m = dates().scheduled.find((d) => d.series === CANNED.market);
    const order = {
      ...ORDER_SCHEDULED,
      fulfilment: { ...ORDER_SCHEDULED.fulfilment, occurrence: m.occurrence,
        date: m.date },
      pickup: {
        name: "Canned Market", place: "Town Common, 1 Main St, Foster, RI",
        window: "10 AM – 12 PM", occurrence: m.occurrence, gone: false,
      },
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
    await cannedDates(page);
    await page.goto("/account/#orders");
    await page.getByRole("button", { name: /^Change (delivery|pickup)$/ })
      .first().click();

    const form = page.locator(".account-panel-form");
    const select = form.locator("select[data-dates]");

    // The day select, the booked pickup chosen, an option for each.
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(m.occurrence);
    for (const d of dates().scheduled) {
      await expect(select.locator(`option[value='${d.occurrence}']`))
        .toHaveCount(1);
    }
    await noPicker(page, form);
  });

  // The pages' HTML as served, read without opening them: the account
  // page sends a visitor who is not signed in elsewhere.
  test("no picker styles or scripts ship", async ({ request, baseURL }) => {
    const assets = new Set();
    const asset = /(?:href|src)="([^"]+\.(?:css|js)(?:\?[^"]*)?)"/g;

    for (const path of ["/order/", "/account/"]) {
      const page = new URL(path, baseURL);
      const html = await (await request.get(page.href)).text();

      for (const [, ref] of html.matchAll(asset)) {
        const url = new URL(ref.replaceAll("&amp;", "&"), page);

        if (url.origin === page.origin) assets.add(url.href);
      }
    }
    expect(assets.size, "the pages' own styles and scripts")
      .toBeGreaterThan(0);
    for (const url of assets) {
      const body = await (await request.get(url)).text();

      expect(body.match(/pickup-picker|data-picker|picker-strip/), url)
        .toBeNull();
    }
  });
});
