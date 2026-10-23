// POST /api/orders answers a browser rarely provokes: a decline, a
// total that moved, a stale date, bad fields, the honeypot. None of
// these charges anything or records an order.
// docs/qa-launch.md, "Payments".

import {
  NONCE, eggOrder, firstScheduled, postOrder,
} from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, nff,
} from "./support/staging.mjs";

test.describe("orders API", () => {
  test("a declined card answers 402 with the customer's words and " +
    "records nothing", async ({ request }) => {
    test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

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

  // A scheduled pickup names one occurrence (data/series.json); the
  // server derives its date and refuses any the schedule doesn't offer.
  test("a scheduled pickup is accepted, with its date derived",
    async ({ request }) => {
      const open = await firstScheduled(request);

      test.skip(!open, "the schedule opens no scheduled pickup");

      const { status, body } = await postOrder(request, await eggOrder(
        request, {
          email: uniqueEmail("api-scheduled"), occurrence: open.occurrence,
        }
      ));

      expect(status, JSON.stringify(body)).toBe(200);
    });

  test("a scheduled pickup the schedule doesn't offer is refused",
    async ({ request }) => {
      const open = await firstScheduled(request);
      const events = await (await request.get("/api/events")).json();
      const attendOnly = events.events.find((e) => e.status === "attend");
      const skipped = events.events.find((e) => e.status === "skip");
      const listed = new Set((await (await request.get("/api/dates"))
        .json()).scheduled.map((d) => d.occurrence));
      const unlisted = open && [7, 14, 21, 28, 35].map((n) => {
        const d = new Date(`${open.date}T12:00:00Z`);

        d.setUTCDate(d.getUTCDate() + n);

        return `${open.series}-${d.toISOString().slice(2, 10)
          .replaceAll("-", "")}`;
      }).find((id) => !listed.has(id));
      const wrong = [
        ["unknown", "ZZZZ-261101"],
        ["archived", "GR6C-260710"],
        ["past", "VFVQ-261017"],
        ["far beyond the horizon", "VFVQ-271002"],
        ["malformed", "not-an-id"],
        ...open ? [["past its cutoff or not a date of the series",
          `${open.series}-${open.occurrence.slice(5, 7)}0101`]] : [],
        ...attendOnly ? [["attend only", attendOnly.occurrence]] : [],
        ...skipped ? [["skipped", skipped.occurrence]] : [],
        ...unlisted ? [["no line in the schedule", unlisted]] : [],
      ];

      for (const [why, occurrence] of wrong) {
        const { status, body } = await postOrder(request, await eggOrder(
          request, { email: uniqueEmail("api-refused"), occurrence }
        ));

        expect([409, 422], why).toContain(status);
        expect(body.errors["fulfilment.occurrence"], why).toBeTruthy();
      }
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
