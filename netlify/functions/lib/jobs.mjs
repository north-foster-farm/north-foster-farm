// The scheduled work, decided in America/New_York from the records
// alone, so a run at any minute does the right thing and a repeat
// run does nothing twice.
//
//   poll        ask Square about every unpaid order (missed webhook)
//   soon        30 minutes after placing, still unpaid: first reminder
//   nextDay     24 hours after placing, still unpaid: second reminder
//   final       8:00 the day before fulfilment (the Wednesday, for a
//               delivery), still unpaid: last call
//   abandon     unpaid at the cutoff: the delivery cutoff, or midnight
//               before a pickup; the invoice is cancelled
//   delivery    18:00 the day before a paid delivery: cooler reminder
//   close       a paid order the day after fulfilment is fulfilled

import terms from "../../../data/delivery.json" with { type: "json" };
import { cutoffFor } from "../../../assets/scripts/order/lib/dates.mjs";
import {
  addDays, instant, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { sendMail } from "./mail.mjs";
import { pollUnpaid, sendForOrder } from "./payments.mjs";
import { openOrders, setStatus } from "./records.mjs";
import { accountUrlFor } from "./site.mjs";
import { cancelInvoice, getInvoice } from "./square.mjs";
import { deliveryReminder, paymentReminder } from "./templates.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SOON_AFTER = 30 * MINUTE;
export const NEXT_DAY_AFTER = 24 * HOUR;
export const FINAL_HOUR = 8;
export const DELIVERY_REMINDER_HOUR = 18;

const tz = terms.timeZone;

const sent = (order, key) => !!(order.emails && order.emails[key]);

// When an unpaid order is given up on.
export const abandonAt = (order) => {
  const date = order.fulfilment.date;

  return order.fulfilment.method === "delivery"
    ? cutoffFor(date, terms)
    : instant(date, 0, 0, tz);
};

export const finalReminderAt = (order) =>
  instant(addDays(order.fulfilment.date, -1), FINAL_HOUR, 0, tz);

export const deliveryReminderAt = (order) =>
  instant(addDays(order.fulfilment.date, -1), DELIVERY_REMINDER_HOUR, 0, tz);

// Which payment reminder, if any, is due now and not yet sent.
export const reminderDue = (order, now) => {
  const placed = Date.parse(order.submittedAt);
  const t = now.getTime();

  if (t >= finalReminderAt(order).getTime() && !sent(order, "final")) {
    return "final";
  }
  if (t >= placed + NEXT_DAY_AFTER && !sent(order, "nextDay")) {
    return "nextDay";
  }
  if (t >= placed + SOON_AFTER && !sent(order, "soon")) return "soon";

  return null;
};

export const runJobs = async (stores, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  invoice = getInvoice,
  cancel = cancelInvoice,
} = {}) => {
  const report = {
    at: now.toISOString(), paid: [], reminded: [], abandoned: [],
    deliveryReminded: [], closed: [],
  };
  const opts = { env, mail, now };

  report.paid = await pollUnpaid(stores, await openOrders(stores), {
    invoice, ...opts,
  });

  // Re-read: the poll may have paid some.
  for (const order of await openOrders(stores)) {
    if (order.status === "submitted") {
      if (now.getTime() >= abandonAt(order).getTime()) {
        await setStatus(stores, order.id, "abandoned", now, {
          source: "jobs",
        });
        report.abandoned.push(order.id);
        if (order.square && order.square.invoiceId) {
          try {
            await cancel(order.square.invoiceId, { env });
          } catch (error) {
            console.error(JSON.stringify({
              event: "invoice.cancel_failed", id: order.id,
              error: String(error.message),
            }));
          }
        }
        continue;
      }

      const stage = reminderDue(order, now);

      if (stage) {
        await sendForOrder(stores, order, stage, paymentReminder(order, stage, {
          accountUrl: accountUrlFor(env),
        }), opts);
        report.reminded.push({ id: order.id, stage });
      }
    }

    if (order.status === "paid") {
      const isDelivery = order.fulfilment.method === "delivery";

      if (isDelivery && !sent(order, "deliveryReminder")
        && now.getTime() >= deliveryReminderAt(order).getTime()
        && today(now, tz) < order.fulfilment.date) {
        await sendForOrder(stores, order, "deliveryReminder",
          deliveryReminder(order, { accountUrl: accountUrlFor(env) }), opts);
        report.deliveryReminded.push(order.id);
      }

      if (today(now, tz) > order.fulfilment.date) {
        await setStatus(stores, order.id, "fulfilled", now, { source: "jobs" });
        report.closed.push(order.id);
      }
    }
  }

  return report;
};
