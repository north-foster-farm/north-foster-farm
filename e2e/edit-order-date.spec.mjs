// Changing a paid order keeps its booked pickup (#284). The order page
// restored the order's date before the date list arrived, so the
// browser dropped it and the first date on offer took its place; and
// a Save pressed before the list arrived was checked against no dates
// at all and sent nothing. Here the order is booked for a later day
// than the first, and Save is pressed at once.

import {
  NONCE, eggOrder, firstScheduled, postOrder,
} from "./support/api.mjs";
import { SKU, expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder,
  deleteCustomer, linkIn, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";

test.describe.configure({ mode: "serial" });

test.describe("changing a paid order's items (#284)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("edit-date");
  let orderId;
  let since;
  let booked;

  test.beforeAll(async ({ request }) => {
    since = new Date();

    // The last pickup on offer, with its last window: never the
    // first, which the page falls back to.
    const dates = await (await request.get("/api/dates")).json();
    const day = dates.onfarm.at(-1);

    booked = { date: day.date, window: day.windows.at(-1).id };
    expect(day.date).not.toBe(dates.onfarm[0].date);

    const payload = await eggOrder(request, {
      email, nonce: NONCE.ok, qty: 2, claimedTotal: 1400,
    });

    payload.fulfilment = {
      method: "onfarm", date: booked.date,
      onfarm: { window: booked.window }, delivery: {},
    };

    const { status, body } = await postOrder(request, payload);

    expect(status, JSON.stringify(body)).toBe(200);
    orderId = body.orderId;
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("keeps the booked day and time, and Save goes at once",
    async ({ page }) => {
      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();

      const mail = await waitForMail({ to: email, subject: SIGN_IN,
        since: asked });

      await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
      await expect(page).toHaveURL(/\/account\/?/);

      // Hold the date list until Save is pressed.
      let release;
      const held = new Promise((r) => { release = r; });

      await page.route("**/api/dates", async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(`/order/?edit=${orderId}`);

      const qty = page.locator(`[data-qty="${SKU.eggs}"]`);

      await expect(qty).toHaveValue("2");
      await qty.fill("1");
      await qty.blur();

      const sent = page.waitForRequest(
        (r) => r.url().includes(`/api/account/orders/${orderId}/edit`)
      );

      await page.locator("#order-save").click();
      release();
      await sent;
      await expect(page).toHaveURL(/\/account\/#orders/);

      const record = await orderRecord(orderId);

      expect(record.lines[0].qty).toBe(1);
      expect(record.fulfilment.date).toBe(booked.date);
      expect(record.fulfilment.onfarm.window).toBe(booked.window);
    });

  test("shows the booked day when the dates come after the order",
    async ({ page, context }) => {
      test.skip(!orderId, "Needs the order from beforeAll.");

      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();

      const mail = await waitForMail({ to: email, subject: SIGN_IN,
        since: asked });

      await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
      await expect(page).toHaveURL(/\/account\/?/);
      await context.route("**/api/dates", async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      await page.goto(`/order/?edit=${orderId}`);
      await expect(page.locator("[data-dates='onfarm']"))
        .toHaveValue(booked.date);
      await expect(page.locator(`[name='onfarm.window'][value='${
        booked.window}']`)).toBeChecked();
    });
});

// #312: the scheduled twin. Editing the items of a scheduled pickup
// keeps the occurrence it is booked at.
test.describe("changing a scheduled order's items (#312)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("edit-scheduled");
  let orderId;
  let since;
  let booked;

  test.beforeAll(async ({ request }) => {
    since = new Date();
    booked = await firstScheduled(request);
    test.skip(!booked, "The farm has opened no scheduled pickup.");

    const payload = await eggOrder(request, {
      email, nonce: NONCE.ok, qty: 2, claimedTotal: 1400,
      occurrence: booked.occurrence,
    });
    const { status, body } = await postOrder(request, payload);

    expect(status, JSON.stringify(body)).toBe(200);
    orderId = body.orderId;
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("keeps the occurrence", async ({ page }) => {
    test.skip(!orderId, "Needs the order from beforeAll.");

    const asked = new Date();

    await page.goto("/login/");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-submit").click();

    const mail = await waitForMail({ to: email, subject: SIGN_IN,
      since: asked });

    await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
    await expect(page).toHaveURL(/\/account\/?/);
    await page.goto(`/order/?edit=${orderId}`);

    const qty = page.locator(`[data-qty="${SKU.eggs}"]`);

    await expect(qty).toHaveValue("2");
    await qty.fill("1");
    await qty.blur();

    const sent = page.waitForRequest(
      (r) => r.url().includes(`/api/account/orders/${orderId}/edit`)
    );

    await page.locator("#order-save").click();
    await sent;
    await expect(page).toHaveURL(/\/account\/#orders/);

    const record = await orderRecord(orderId);

    expect(record.lines[0].qty).toBe(1);
    expect(record.fulfilment.method).toBe("scheduled");
    expect(record.fulfilment.occurrence).toBe(booked.occurrence);
  });
});
