// #461: the customer emails no other spec sends from their own
// trigger, each sent by the farm's action or the job that owns it
// (the back office's ops stand in for `bin/nff`):
//
//   a customer's missed delivery        orders attempt <id> no-cooler
//   the farm's or weather's miss moves  orders attempt <id> weather
//   an address decided                  customers address approved|denied
//   the news confirmation               sign-up form request, then the link
//   a year of quiet                     the daily job, for one address
//
// The words of the emails are drafts under #304 and #189; these checks
// pin what each one must say, not every line. Orders are refunded,
// closed and deleted, customers deleted and mail cleared afterwards.

import { deliveryOrder, postPriced } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, customerRecord,
  deleteCustomer, linkIn, op, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

test.describe.configure({ mode: "serial" });

test.describe("customer emails, from their triggers", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const made = [];
  const emails = [];
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([
    ...made.map((id) => () => closeOrder(id)),
    ...emails.flatMap((email) => [
      () => deleteCustomer(email),
      () => clearMail({ to: email, since }),
    ]),
  ]));

  // A paid delivery, with its confirmation in the outbox before the
  // test goes on.
  const delivery = async (request, tag) => {
    const email = uniqueEmail(tag);

    emails.push(email);

    const { status, body } = await postPriced(
      request, await deliveryOrder(request, { email })
    );

    expect(status, JSON.stringify(body)).toBe(200);
    made.push(body.orderId);
    await waitForMail({
      to: email, subject: "Your order is confirmed", since,
    });

    return { email, id: body.orderId };
  };

  // The waiver keeps the delivery fee out of the miss, so the
  // teardown refunds the whole order.
  test("a customer's missed delivery asks them what to do",
    { tag: "@regression" }, async ({ request }) => {
      const { email, id } = await delivery(request, "missed");

      await op("orderAttempt", {
        id, cause: "no-cooler", waive: "QA e2e",
      });

      const mail = await waitForMail({
        to: email, subject: "We couldn't deliver your order", since,
      });

      expect(mail.text).toContain("Your order is back at the farm.");
      expect(mail.text).toContain("By the front steps");
      expect(mail.text).toContain("Reschedule or cancel");

      const record = await orderRecord(id);

      expect(record.question).toMatchObject({ kind: "missed" });
      expect(record.attempted).toMatchObject({ cause: "no-cooler" });
      expect(record.emails.missedDelivery).toBeTruthy();
    });

  test("the weather's miss moves the delivery and says so",
    { tag: "@regression" }, async ({ request }) => {
      const { email, id } = await delivery(request, "moved");
      const booked = (await orderRecord(id)).fulfilment.date;

      await op("orderAttempt", { id, cause: "weather" });

      const mail = await waitForMail({
        to: email, subject: /^Your delivery has moved to /, since,
      });

      expect(mail.text).toContain("The weather kept us from delivering " +
        "your order today");
      expect(mail.text).toContain("You don't need to do anything.");

      const record = await orderRecord(id);

      expect(record.fulfilment.date > booked).toBe(true);
      expect(record.question && record.question.answeredAt)
        .toBeFalsy();
      expect(record.status).toBe("paid");
    });

  test("an address is approved, then denied, and each says so",
    { tag: "@regression" }, async ({ page }) => {
      const email = uniqueEmail("address");

      emails.push(email);

      // Sign in by the link the CLI would make, then save an address
      // outside the approved list, as the account page does.
      await page.goto((await op("login", { email })).url);
      await expect(page).toHaveURL(/\/account\//);

      const saved = await page.evaluate(async () => {
        const res = await fetch("/api/account/address", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address1: "9 Test Street", town: "Pawtucket", zip: "02860",
            cooler: "By the door",
          }),
        });

        return { status: res.status, body: await res.json() };
      });

      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await customerRecord(email)).address.status).toBe("pending");

      await op("addressDecide", { email, decision: "approved" });

      const yes = await waitForMail({
        to: email, subject: "We can deliver to your address", since,
      });

      expect(yes.text).toContain("9 Test Street");
      expect((await customerRecord(email)).address.status)
        .toBe("approved");

      await op("addressDecide", { email, decision: "denied" });

      const no = await waitForMail({
        to: email, subject: "We can't deliver to your address", since,
      });

      expect(no.text).toContain("outside our delivery area");
      expect((await customerRecord(email)).address.status).toBe("denied");
    });

  test("the news confirmation joins them when they confirm",
    { tag: "@regression" }, async ({ request }) => {
      const email = uniqueEmail("invite");

      emails.push(email);

      expect((await op("newsSubscribeRequest", { email })).ok).toBe(true);

      const invite = await waitForMail({
        to: email, subject: "Confirm your email address for Farm News",
        since,
      });
      const link = linkIn(invite, /\/api\/news\/confirm\?token=/);

      expect(link, "the confirmation link").toBeTruthy();
      // Not on the list until the link is followed.
      expect(await customerRecord(email)).toBeNull();

      const res = await request.get(link);

      expect(res.ok(), `the link answered ${res.status()}`).toBe(true);

      const record = await customerRecord(email);

      expect(record.marketing).toBe(true);
      expect(record.marketingSource).toBe("signup");
      await waitForMail({
        to: email, subject: "Welcome to Farm News", since,
      });
    });

  test("a year of quiet takes them off farm news and tells them, once",
    { tag: "@regression" }, async () => {
      const email = uniqueEmail("quiet");

      emails.push(email);
      await op("customerSeedQuiet", { email, years: 2 });

      const first = (await op("quietRun", { email })).report;

      expect(first.noticed).toEqual([email]);

      const mail = await waitForMail({
        to: email, subject: "Your account is still here", since,
      });

      expect(mail.text).toContain("It's been a year");
      expect(mail.text).toContain("We've stopped sending you our Farm " +
        "News emails.");

      const record = await customerRecord(email);

      expect(record.marketing).toBe(false);
      expect(record.marketingSource).toBe("inactive");
      expect(record.quietNoticeAt).toBeTruthy();

      const again = (await op("quietRun", { email })).report;

      expect(again.noticed, "told once").toEqual([]);
    });
});
