// POST /api/orders answers a browser rarely provokes: a decline, a
// total that moved, a stale date, bad fields, the honeypot. None of
// these charges anything or records an order.
// docs/qa-launch.md, "Payments".

import { NONCE, eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, nff,
} from "./support/staging.mjs";

test.describe("orders API", () => {
  test("a declined card answers 402 with the customer's words and " +
    "records nothing", async ({ request }) => {
    test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

    const email = uniqueEmail("api-decline");
    const { status, body } = await postOrder(request, await eggOrder(
      request, { email, nonce: NONCE.declined }
    ));

    expect(status, JSON.stringify(body)).toBe(402);
    expect(body.declined).toBe(true);
    expect(body.code).toBeTruthy();
    expect(body.message).toMatch(/\w/);
    expect(await nff(["orders", "list", `--email=${email}`]))
      .toContain("No orders.");
  });

  test("a total that differs from the server's is refused, not charged",
    async ({ request }) => {
      const { status, body } = await postOrder(request, await eggOrder(
        request, { email: uniqueEmail("api-total"), claimedTotal: 600 }
      ));

      expect(status).toBe(422);
      expect(body.errors.total).toBe(
        "The total changed while you were on this page. Check it and pay " +
        "again."
      );
      expect(body.totals.total).toBe(700);
    });

  test("a date no longer offered answers 409 with a fresh list",
    async ({ request }) => {
      const payload = await eggOrder(request, {
        email: uniqueEmail("api-stale"),
      });

      payload.fulfilment.date = "2026-01-02";

      const { status, body } = await postOrder(request, payload);

      expect(status).toBe(409);
      expect(body.errors["fulfilment.date"])
        .toBe("That date is no longer available.");
      expect(body.dates.length).toBeGreaterThan(0);
    });

  test("bad fields answer 422, field by field", async ({ request }) => {
    const payload = await eggOrder(request, { email: "not-an-email" });

    payload.customer.firstName = "";
    payload.fulfilment = {
      method: "delivery", date: payload.fulfilment.date,
      delivery: { zip: "10001" }, onfarm: {},
    };

    const { status, body } = await postOrder(request, payload);

    expect(status).toBe(422);
    expect(body.errors).toMatchObject({
      "customer.firstName": "Please enter your first name.",
      "customer.email": "That email address doesn't look right.",
      "customer.phone": "Please enter a phone number.",
      "delivery.zip": "That's outside our delivery area.",
      "delivery.minimum": expect.stringContaining("$40 or more"),
    });
  });

  test("the honeypot is dropped silently", async ({ request }) => {
    const payload = await eggOrder(request, {
      email: uniqueEmail("api-bot"), extra: { website: "http://spam" },
    });
    const { status, body } = await postOrder(request, payload);

    expect(status).toBe(204);
    expect(body).toBeNull();
  });
});
