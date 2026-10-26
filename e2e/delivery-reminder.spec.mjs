// #355, #456: the evening before a delivery the jobs email the
// customer "Your delivery is tomorrow", once. The order is placed
// through the API, then the jobs run as of set times (the back
// office's `jobsRun`, which works only this order): just before the
// reminder hour nothing goes, just after it the email does, and a
// second run sends nothing more. Whether the cron fires on its own is
// an observation, not part of this spec. The order is refunded,
// closed and deleted afterwards.

import terms from "../data/delivery.json" with { type: "json" };
import {
  addDays, instant, today,
} from "../assets/scripts/order/lib/zoned.mjs";
import { deliveryOrder, postPriced } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  mailTo, op, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const REMINDER = "Your delivery is tomorrow";
const HOUR = 18;

test.describe.configure({ mode: "serial" });

test.describe("the delivery reminder", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("reminder");
  let id;
  let eve;
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([
    () => (id ? closeOrder(id) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  const run = async (hour, minute) => (await op("jobsRun", {
    at: instant(eve, hour, minute, terms.timeZone).toISOString(),
    orders: [id],
  })).report;

  test("a paid delivery is placed and confirmed", async ({ request }) => {
    const { status, body } = await postPriced(
      request, await deliveryOrder(request, { email })
    );

    expect(status, JSON.stringify(body)).toBe(200);
    id = body.orderId;

    const record = await orderRecord(id);

    expect(record.fulfilment.method).toBe("delivery");
    eve = addDays(record.fulfilment.date, -1);
    expect(today(new Date(), terms.timeZone) <= eve).toBe(true);

    // The jobs send a confirmation that never went out; wait for the
    // one the order sent, so the runs below can't send it twice.
    await waitForMail({
      to: email, subject: "Your order is confirmed", since,
    });
  });

  test("before the reminder hour nothing is sent", async () => {
    const report = await run(HOUR - 1, 55);

    expect(report.errors).toEqual([]);
    expect(report.deliveryReminded).not.toContain(id);
    expect((await mailTo(email, since)).map((m) => m.subject))
      .not.toContain(REMINDER);
  });

  test("after it, the reminder goes with the drop-off details",
    { tag: "@regression" }, async () => {
      const report = await run(HOUR, 5);

      expect(report.errors).toEqual([]);
      expect(report.deliveryReminded).toContain(id);

      const mail = await waitForMail({ to: email, subject: REMINDER, since });

      expect(mail.text).toContain("Tomorrow is delivery day!");
      expect(mail.text).toContain("By the front steps");
      expect(mail.text).toContain(id);
      expect(mail.text).toContain("Turn off delivery reminders");
      expect((await orderRecord(id)).emails.deliveryReminder).toBeTruthy();
    });

  test("a second run sends nothing more", async () => {
    const report = await run(HOUR + 1, 0);

    expect(report.errors).toEqual([]);
    expect(report.deliveryReminded).not.toContain(id);
    expect((await mailTo(email, since)).filter((m) => m.subject === REMINDER))
      .toHaveLength(1);
  });
});
