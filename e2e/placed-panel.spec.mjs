// Criteria tests for #723 (Order placed panel: egg-shaped check,
// summary lists), one per "Done when" box marked (test), named for it.
// The box marked (screenshot), the egg-shaped check aligned with the
// heading at 390, 768 and 1440 px, is not a test.
//
// The wording is James's draft ("roughly"), which communications
// tightens, so these hold the structure and the facts each row
// carries, not the exact prose: a label then a list, a row per fact,
// the fact's value in the row.
//
// Held out of every run by its name: the config takes *.spec.mjs only,
// so renaming it to placed-panel.spec.mjs turns it on. Each test
// places an order against the fake payment drivers (#265), as
// fake-payments.spec.mjs does, and skips where they are not offered.

import {
  OrderPage, expect, paidCard, paymentFakes as fakes, test, uniqueEmail,
} from "./support/order.mjs";
import { label } from "../assets/scripts/order/lib/zoned.mjs";
import company from "../data/company.json" with { type: "json" };

const ORDER_ID = /^NFF-\d{4}-[A-Z2-9]{6}$/;
const TIME = /\d{1,2}:\d{2}/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The farm's street, as data/company.json gives it in full or short.
const FARM_STREET = new RegExp(
  `${escape(company.address.street)}|${escape(company.address.short)}`
);

// Places an order and returns what the panel should say: the order
// number, the cart's total as the cart shows it, the method paid with,
// the way's title as its card on the form shows it, the date chosen.
const place = async (page, request, way) => {
  const order = new OrderPage(page);
  const email = uniqueEmail(`placed-${way}`);

  // Delivery needs its minimum, and asks for a phone number.
  await order.open({ eggs: way === "delivery" ? 6 : 1 });
  if (way === "delivery") {
    await order.delivery();
  } else {
    await order.method(way);
  }
  await order.contact({
    first: "Placed", email,
    ...(way === "delivery" ? { phone: "4015550100" } : {}),
  });

  const date = await order.firstDate(way);
  const total = (await order.total.textContent()).trim();
  const type = (await page.locator(`#method-${way}-title`).textContent())
    .trim();

  await order.openCard();
  await order.card();

  const { status, body } = await order.pay();

  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.orderId).toMatch(ORDER_ID);
  await expect(order.result).toBeVisible();

  return {
    order, card: order.result, email, date, total, type,
    orderId: body.orderId, how: (await paidCard(request)).how,
  };
};

// The list that follows a section's label ("Order summary",
// "Receiving your order"), with or without a colon after it.
const listAfter = (card, name) => {
  const head = card.getByText(new RegExp(`^\\s*${name}:?\\s*$`, "i"));

  return {
    head, list: head.locator("xpath=(following::ul | following::ol)[1]"),
  };
};

// The one row of a list whose label matches `name`.
const row = (list, name) => list.locator("li").filter({ hasText: name });

// The rows are labels, so none ends with a period (#400, spec 6).
const noTrailingPeriod = async (list) => {
  const rows = await list.locator("li").allTextContents();

  expect(rows.length).toBeGreaterThan(0);
  for (const text of rows) expect(text.trim()).not.toMatch(/[.!?]$/);
};

test.describe("#723 the order placed panel", () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await fakes(request)).square, "SQUARE_ENV is not fake here");
  });

  test("The panel shows the confirmation line with the customer's " +
    "email address and a working \"Sign in\" link",
  async ({ page, request }) => {
    const { card, email } = await place(page, request, "onfarm");
    // The one paragraph that names the address and links to sign in.
    const line = card.locator("p")
      .filter({ hasText: /confirmation is on its way/i })
      .filter({ has: page.getByRole("link", { name: /^sign in$/i }) });

    await expect(line).toHaveCount(1);
    await expect(line.locator("strong", { hasText: email })).toHaveCount(1);
    await expect(line).toContainText(email);

    const link = line.getByRole("link", { name: /^sign in$/i });

    await expect(link).toHaveAttribute("href", /\/login\/$/);
    await link.click();
    await expect(page).toHaveURL(/\/login\/$/);
    await expect(page.locator("#login-form")).toBeVisible();
  });

  test("\"Order summary\" lists the order number and the amount paid " +
    "with its method", async ({ page, request }) => {
    const { card, orderId, total, how } = await place(page, request,
      "onfarm");
    const { head, list } = listAfter(card, "Order summary");

    await expect(head).toHaveCount(1);
    await expect(list).toBeVisible();

    const number = row(list, /order number/i);

    await expect(number).toHaveCount(1);
    await expect(number).toContainText(orderId);

    const paid = row(list, /payment/i);

    await expect(paid).toHaveCount(1);
    await expect(paid).toContainText(total);
    await expect(paid).toContainText(how);
    await noTrailingPeriod(list);
  });

  test("\"Receiving your order\" lists the order type, the pick-up " +
    "address for a pickup order (none for a delivery), and the date " +
    "and time", async ({ page, request }) => {
    const pickup = await place(page, request, "onfarm");
    const onfarm = listAfter(pickup.card, "Receiving your order");

    await expect(onfarm.head).toHaveCount(1);
    await expect(onfarm.list).toBeVisible();
    await expect(row(onfarm.list, /order type/i)).toHaveCount(1);
    await expect(row(onfarm.list, /order type/i))
      .toContainText(pickup.type);
    await expect(row(onfarm.list, /pick-?\s?up address/i)).toHaveCount(1);
    await expect(row(onfarm.list, /pick-?\s?up address/i))
      .toContainText(FARM_STREET);

    const pickupWhen = row(onfarm.list, /date and time/i);

    await expect(pickupWhen).toHaveCount(1);
    await expect(pickupWhen).toContainText(label(pickup.date));
    await expect(pickupWhen).toContainText(TIME);
    await noTrailingPeriod(onfarm.list);

    // A delivery, in a fresh page: no pick-up address at all.
    const fresh = await page.context().newPage();
    const drop = await place(fresh, request, "delivery");
    const delivery = listAfter(drop.card, "Receiving your order");

    await expect(delivery.list).toBeVisible();
    await expect(row(delivery.list, /order type/i)).toHaveCount(1);
    await expect(row(delivery.list, /order type/i))
      .toContainText(drop.type);
    await expect(row(delivery.list, /pick-?\s?up address/i))
      .toHaveCount(0);
    await expect(delivery.list).not.toContainText(FARM_STREET);

    const deliveryWhen = row(delivery.list, /date and time/i);

    await expect(deliveryWhen).toHaveCount(1);
    await expect(deliveryWhen).toContainText(label(drop.date));
    await expect(deliveryWhen).toContainText(TIME);
    await noTrailingPeriod(delivery.list);
    await fresh.close();
  });

  test("The removed lines are gone; the questions line remains, and " +
    "the Instagram follow line remains in a quieter form",
  async ({ page, request }) => {
    const { card } = await place(page, request, "onfarm");

    await expect(card).toBeVisible();
    // Spec 4: the account paragraph and "Have it handy" go.
    await expect(card).not.toContainText(/is your account with us/i);
    await expect(card).not.toContainText(/no password/i);
    await expect(card).not.toContainText(/have it handy/i);

    const questions = card.locator("p").filter({ hasText: /^\s*Questions\?/ });

    await expect(questions).toHaveCount(1);
    await expect(questions.getByRole("link", { name: company.email }))
      .toHaveAttribute("href", `mailto:${company.email}`);

    // The element that holds the follow link's text.
    const follow = card.locator("a[href*='instagram.com']")
      .locator("xpath=..");

    await expect(follow).toHaveCount(1);
    await expect(follow).toBeVisible();

    // Quieter than the panel's body text, which the confirmation line
    // is: smaller, or a softer color.
    const confirmation = card.locator("p")
      .filter({ hasText: /confirmation is on its way/i }).first();
    const style = (loc) => loc.evaluate((el) => {
      const s = getComputedStyle(el);

      return { size: parseFloat(s.fontSize), color: s.color };
    });
    const body = await style(confirmation);
    const quiet = await style(follow);

    expect(
      quiet.size < body.size || quiet.color !== body.color,
      `Instagram line ${JSON.stringify(quiet)} is as loud as the ` +
        `body text ${JSON.stringify(body)}`
    ).toBe(true);
  });
});
