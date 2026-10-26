// Scheduled pickup on the order page (#311, piece B of #309): one
// picker of every occurrence open for pickup, read from /api/dates'
// `scheduled`. Answered here by canned lists (support/scheduled.mjs),
// so it needs no particular schedule. Written, not run, while e2e is
// paused.

import {
  OrderPage, expect, pickupChosen, pickupRadios, pickupValues, test,
} from "./support/order.mjs";
import {
  DROP, FOSTER, POPUP, cannedScheduled, datesWith, payable,
  saturdays,
} from "./support/scheduled.mjs";

const draft = (page) => page.evaluate(() => JSON.parse(
  localStorage.getItem("nff-order-draft") || "{}"
).payload.fulfilment);

const values = pickupValues;
const listed = (page) => expect(pickupRadios(page).first()).toBeVisible();
const part = (page, code, name) => page.locator(
  `#scheduled-pickups .order-pickup:has(input[value^='${code}-']) ` +
  `.order-pickup-${name}`
).first();

const series = async (page) => (await values(page))
  .map((v) => v.split("-")[0]);

test.describe("scheduled pickup", () => {
  test("the picker lists every open occurrence, by date",
    async ({ page }) => {
      await cannedScheduled(page);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await listed(page);

      const codes = await series(page);

      expect(codes).toContain(DROP.series);
      expect(codes).toContain(FOSTER.series);
      expect(codes).toContain(POPUP.series);

      const dates = (await values(page)).map((v) => v.split("-")[1]);

      expect(dates).toEqual([...dates].sort());
    });

  test("each entry is a card: day and hours, name, then address",
    async ({ page }) => {
      await cannedScheduled(page);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await listed(page);
      await expect(part(page, FOSTER.series, "date"))
        .toHaveText(/^\w+, \w+ \d+$/);
      await expect(part(page, FOSTER.series, "time"))
        .toHaveText("9:00 AM – 1:00 PM");
      await expect(part(page, FOSTER.series, "name"))
        .toHaveText("Foster Farmers Market");
      // The parts joined by commas, a line breaking only between two
      // (#439).
      await expect(part(page, FOSTER.series, "address").locator("span"))
        .toHaveText([
          "Shady Acres Diner", "164 Danielson Pike", "Foster, RI 02825",
        ]);
      await expect(part(page, DROP.series, "time"))
        .toHaveText("10:00 – 11:00 AM");
      await expect(part(page, DROP.series, "name"))
        .toHaveText("Scituate · Drop site");
      await expect(part(page, DROP.series, "address").locator("span"))
        .toHaveText([
          "The Village Green", "46 Institute Lane", "North Scituate, RI 02857",
        ]);
    });

  test("an unchosen card is white and a chosen one is not",
    async ({ page }) => {
      await cannedScheduled(page);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await listed(page);

      const card = page.locator("#scheduled-pickups .order-pickup").first();
      const bg = () => card.evaluate((el) => getComputedStyle(el)
        .backgroundColor);

      expect(await bg()).toBe("rgb(255, 255, 255)");
      await card.locator("input").check();
      expect(await bg()).not.toBe("rgb(255, 255, 255)");
    });

  test("none is chosen until the customer chooses", async ({ page }) => {
    await cannedScheduled(page);

    const order = new OrderPage(page);

    await order.open({ eggs: 1 }, { method: "scheduled" });
    await listed(page);
    await expect(pickupChosen(page)).toHaveCount(0);
    expect((await draft(page)).occurrence).toBe("");
  });

  test("paying without a choice says so and stays on the pickup",
    async ({ page }) => {
      await cannedScheduled(page);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await listed(page);
      await order.contact({ email: "none@example.com" });
      await order.openCard();
      await order.card();
      await order.submit.click();
      await expect(page.locator("[data-error-for='fulfilment.occurrence']"))
        .toHaveText("Choose a pickup day and place.");
      await expect(page.locator("#scheduled-pickups"))
        .toHaveClass(/is-invalid/);
      await expect(page.locator("#order-lapsed")).toBeHidden();
    });

  test("the cart's way names only the method", async ({ page }) => {
    await cannedScheduled(page);

    const order = new OrderPage(page);

    await order.open({ eggs: 1 }, { method: "scheduled" });
    await expect(page.locator("[data-way-name]"))
      .toHaveText("Pickup days");

    await order.scheduled(FOSTER.series);
    await expect(page.locator("[data-way-name]"))
      .toHaveText("Pickup days");
  });

  test("an occurrence the list lacks is not offered",
    async ({ page }) => {
      // Skipped, attend-only and unlisted occurrences, and any past the
      // horizon, never reach /api/dates; the page offers only the list.
      await cannedScheduled(page, datesWith([{ place: DROP, days: [3] }]));

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await listed(page);
      expect(await values(page)).toHaveLength(1);
      expect((await series(page))[0]).toBe(DROP.series);
    });

  test("only the drop site open: the card reads as the drop site does",
    async ({ page }) => {
      await cannedScheduled(page, datesWith([
        { place: DROP, days: [3, 10] },
      ]));

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await listed(page);
      await expect(page.locator("[data-scheduled-facts] dd").first())
        .toHaveText("At our markets and pickup days");
      await expect(page.locator("[data-scheduled-where]"))
        .toContainText("Village Green");
    });

  test("several places: the card names them", async ({ page }) => {
    await cannedScheduled(page);

    const order = new OrderPage(page);

    await order.open({ eggs: 1 });
    await expect(page.locator("[data-scheduled-facts] dd").first())
      .toHaveText("At our markets and pickup days");
    await expect(page.locator("[data-scheduled-where]")).toHaveText(
      "Drop site, Summer Concert, and Foster Farmers Market"
    );
  });

  test("choosing an occurrence posts the method and the occurrence",
    async ({ page }) => {
      await cannedScheduled(page);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });

      const value = await order.scheduled(FOSTER.series);

      await expect.poll(() => draft(page)).toMatchObject({
        method: "scheduled", occurrence: value,
      });
      expect(await draft(page)).not.toHaveProperty("site");
    });

  test("an empty list says so, cannot be chosen, and leaves the other " +
    "ways", async ({ page }) => {
    await cannedScheduled(page, { ...datesWith([]), scheduled: [] });

    const order = new OrderPage(page);

    await order.open({ eggs: 1 });
    await expect(page.locator("[data-scheduled-none]")).toHaveText(
      "No pickup days are open right now."
    );
    await expect(page.locator("#method-scheduled")).toBeDisabled();
    await expect(pickupRadios(page)).toHaveCount(0);
    await order.method("delivery");
    await order.method("onfarm");
  });

  test("an empty list unchooses a restored scheduled pickup",
    async ({ page }) => {
      await cannedScheduled(page, { ...datesWith([]), scheduled: [] });
      await page.addInitScript(() => localStorage.setItem(
        "nff-order-draft", JSON.stringify({ payload: {
          lines: [], customer: {},
          fulfilment: { method: "scheduled", occurrence: "VFVQ-990101" },
        } })
      ));

      const order = new OrderPage(page);

      await order.open();
      await expect(page.locator("#method-scheduled")).toBeDisabled();
      await expect(page.locator("#method-onfarm")).toBeChecked();
    });
});

test.describe("links to scheduled pickup", () => {
  test("?method=scheduled opens scheduled pickup", async ({ page }) => {
    await cannedScheduled(page);
    await page.goto("/order/?method=scheduled");
    await expect(page.locator("#method-scheduled")).toBeChecked();
    await expect(page).toHaveURL(/\/order\/$/);
  });

  test("&series= chooses that series' next date", async ({ page }) => {
    await cannedScheduled(page);
    await page.goto(`/order/?method=scheduled&series=${POPUP.series}`);
    await expect(page.locator("#method-scheduled")).toBeChecked();
    await listed(page);
    await expect(pickupChosen(page)).toHaveValue(
      (await values(page)).find((v) => v.startsWith(`${POPUP.series}-`))
    );
    await expect(page).toHaveURL(/\/order\/$/);
  });

  test("a series the list lacks leaves nothing chosen",
    async ({ page }) => {
      await cannedScheduled(page);
      await page.goto("/order/?method=scheduled&series=NONE");
      await expect(page.locator("#method-scheduled")).toBeChecked();
      await listed(page);
      await expect(pickupChosen(page)).toHaveCount(0);
    });

  test("the old ?method=scituate chooses the drop site's next date",
    async ({ page }) => {
      await cannedScheduled(page);
      await page.goto("/order/?method=scituate");
      await expect(page.locator("#method-scheduled")).toBeChecked();

      const picked = await pickupChosen(page).inputValue();

      expect(picked.startsWith(`${DROP.series}-`)).toBe(true);
      await expect.poll(async () => (await draft(page)).method)
        .toBe("scheduled");
    });

  test("a link beats a saved draft's way", async ({ page }) => {
    await cannedScheduled(page);

    const order = new OrderPage(page);

    await order.open({ eggs: 1 }, { method: "delivery" });
    await page.goto(`/order/?method=scheduled&series=${FOSTER.series}`);
    await expect(page.locator("#method-scheduled")).toBeChecked();
    await listed(page);
    await expect(pickupChosen(page)).toHaveValue(
      (await values(page)).find((v) => v.startsWith(`${FOSTER.series}-`))
    );
  });
});

test.describe("a lapsed scheduled pickup", () => {
  // The server's 409: the way chosen has lapsed, `dates` the fresh list
  // for that way (for a scheduled pickup, the `scheduled` list).
  const lapse = (page, dates) => page.route("**/api/orders", (route) => (
    route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { ok: false, dates } })
      : route.fallback()
  ));

  const pay = async (order) => {
    await order.contact({ email: "lapsed@example.com" });
    await order.openCard();
    await order.card();
    await order.submit.click();
  };

  test("offers the fresh pickups and puts the choice on the form",
    async ({ page }) => {
      test.skip(saturdays().length < 2, "needs two orderable Saturdays");

      const lists = payable();

      await cannedScheduled(page, lists);
      await lapse(page, lists.scheduled);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await order.scheduled(DROP.series);
      await pay(order);

      const dialog = page.locator("#order-lapsed");

      await expect(dialog).toBeVisible();
      await expect(dialog.locator("[data-lapsed-legend]"))
        .toHaveText("Pickup days");
      await expect(dialog.getByRole("button", { name: "Use this pickup" }))
        .toBeVisible();
      await expect(dialog.getByRole("button", {
        name: "Choose on-farm pickup or delivery instead",
      })).toBeVisible();

      // Take the other Saturday, not the first offered.
      const market = lists.scheduled.at(-1);

      await dialog.getByLabel(new RegExp(market.label)).check();
      await dialog.getByRole("button", { name: "Use this pickup" }).click();
      await expect(pickupChosen(page)).toHaveValue(market.occurrence);
      await expect(page.locator("[data-lapsed-status]")).toHaveText(
        `Pickup is now ${market.label}, ${DROP.window}, at ` +
        "the drop site. Pay to place your order."
      );
    });

  for (const [way, instead] of [
    ["scheduled", "Choose on-farm pickup or delivery instead"],
    ["onfarm", "Choose a pickup day or delivery instead"],
    ["delivery", "Choose on-farm pickup or a pickup day instead"],
  ]) {
    test(`a lapsed ${way} way offers "${instead}"`, async ({ page }) => {
      const lists = payable();

      await cannedScheduled(page, lists);
      await lapse(page, way === "scheduled" ? lists.scheduled : lists[way]);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      if (way === "scheduled") {
        await order.scheduled(DROP.series);
      } else if (way === "delivery") {
        await order.delivery();
        await order.firstDate("delivery");
      } else {
        await order.firstDate("onfarm");
      }
      await pay(order);
      await expect(page.getByRole("button", { name: instead }))
        .toBeVisible();
    });
  }
});
