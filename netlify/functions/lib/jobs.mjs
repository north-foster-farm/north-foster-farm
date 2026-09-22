// The scheduled work, decided in America/New_York from the records
// alone, so a run at any minute does the right thing and a repeat
// run does nothing twice.
//
//   poll        ask Square about every unpaid order (missed webhook)
//   soon        1 hour after placing, still unpaid: first reminder
//   nextDay     24 hours after placing, still unpaid: second reminder
//   final       8:00 the day before fulfilment (the Wednesday, for a
//               delivery), still unpaid: last call
//   abandon     unpaid at the cutoff: the delivery cutoff, or midnight
//               before a pickup; the invoice is cancelled
//   held        a bank transfer in flight gets no reminder and is not
//               abandoned; Square will say PAID or UNPAID
//   bank        an unpaid invoice that offered bank transfer loses the
//               option once its date is too close to clear
//   delivery    18:00 the day before a paid delivery: cooler reminder
//   close       a paid order the day after fulfilment is fulfilled
//   question    an order with an open question from the farm (a denied
//               pickup window) is left alone: no reminders, not
//               abandoned, not closed, until the customer answers
//   pickups     8:00 daily, the on-farm orders within two days still
//               waiting on the farm or the customer, to ADMIN_EMAILS
//   venmo       18:00 daily, the Venmo payments that named no order or
//               the wrong amount, to ADMIN_EMAILS

import terms from "../../../data/delivery.json" with { type: "json" };
import { cutoffFor } from "../../../assets/scripts/order/lib/dates.mjs";
import {
  addDays, instant, parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { pollUnpaid, sendForOrder } from "./payments.mjs";
import {
  amendOrder, getCustomer, needsAgreement, openOrders, questionOpen,
  reminderPrefs, setStatus,
} from "./records.mjs";
import { mailLinks, orderUrlFor, settingsUrlFor } from "./site.mjs";
import {
  bankTransferOffered, cancelInvoice, closeBankTransfer, getInvoice,
} from "./square.mjs";
import { adjust } from "./stock.mjs";
import {
  deliveryReminder, farmPickupsToConfirm, farmVenmoUnmatched,
  paymentReminder,
} from "./templates.mjs";
import { markReported, unreportedPayments } from "./venmo.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SOON_AFTER = HOUR;
export const NEXT_DAY_AFTER = 24 * HOUR;
export const FINAL_HOUR = 8;
export const DELIVERY_REMINDER_HOUR = 18;
export const PICKUPS_REPORT_HOUR = 8;
export const PICKUPS_REPORT_DAYS = 2;
export const VENMO_REPORT_HOUR = 18;

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
  close = closeBankTransfer,
} = {}) => {
  const report = {
    at: now.toISOString(), paid: [], reminded: [], abandoned: [],
    deliveryReminded: [], closed: [], bankTransferClosed: [], muted: [],
    pickupsToConfirm: [], venmoReported: [],
  };
  const opts = { env, mail, now };

  report.paid = await pollUnpaid(stores, await openOrders(stores), {
    invoice, ...opts,
  });

  // A customer's reminder settings, read once per run however many
  // orders they have open. A reminder they turned off is skipped and
  // reported, never sent; the clocks it would have announced
  // (abandonment, fulfilment) still run.
  const prefs = new Map();
  const wants = async (order, kind) => {
    const email = order.customer.email;

    if (!prefs.has(email)) {
      prefs.set(email, reminderPrefs(await getCustomer(stores, email)));
    }
    if (prefs.get(email)[kind]) return true;
    report.muted.push({ id: order.id, kind });

    return false;
  };

  // Re-read: the poll may have paid some.
  for (const order of await openOrders(stores)) {
    if (questionOpen(order)) continue;

    if (order.status === "submitted") {
      if (order.paymentPending) continue;

      if (now.getTime() >= abandonAt(order).getTime()) {
        await setStatus(stores, order.id, "abandoned", now, {
          source: "jobs",
        });
        report.abandoned.push(order.id);
        await adjust(stores, order.lines, 1);
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

      // Once, per invoice that offered it. A Square failure is left
      // for the next run; a "no longer unpaid" answer is not, since
      // the invoice can no longer be edited either way.
      const sq = order.square || {};

      if (sq.bankTransfer && !sq.bankTransferClosedAt
        && !bankTransferOffered(order.fulfilment.date, now)) {
        try {
          await close(sq.invoiceId, { env });
          await amendOrder(stores, order.id, {
            square: { ...sq, bankTransferClosedAt: now.toISOString() },
          }, "bankTransfer.closed", now);
          report.bankTransferClosed.push(order.id);
        } catch (error) {
          console.error(JSON.stringify({
            event: "bank_transfer.close_failed", id: order.id,
            error: String(error.message),
          }));
        }
      }

      const stage = reminderDue(order, now);

      if (stage && await wants(order, "payment")) {
        await sendForOrder(stores, order, stage, paymentReminder(order, stage, {
          orderUrl: orderUrlFor(env, order.id),
          settingsUrl: settingsUrlFor(env),
          links: mailLinks(env),
          now,
        }), opts);
        report.reminded.push({ id: order.id, stage });
      }
    }

    if (order.status === "paid") {
      const isDelivery = order.fulfilment.method === "delivery";

      if (isDelivery && !sent(order, "deliveryReminder")
        && now.getTime() >= deliveryReminderAt(order).getTime()
        && today(now, tz) < order.fulfilment.date
        && await wants(order, "delivery")) {
        await sendForOrder(stores, order, "deliveryReminder",
          deliveryReminder(order, {
            orderUrl: orderUrlFor(env, order.id),
            settingsUrl: settingsUrlFor(env),
            links: mailLinks(env),
          }), opts);
        report.deliveryReminded.push(order.id);
      }

      if (today(now, tz) > order.fulfilment.date) {
        await setStatus(stores, order.id, "fulfilled", now, { source: "jobs" });
        report.closed.push(order.id);
      }
    }
  }

  report.pickupsToConfirm = await pickupsReport(stores, { env, mail, now });
  report.venmoReported = await venmoReport(stores, { env, mail, now });

  return report;
};

// A once-a-day farm email, recorded in the jobs store under `key`
// once it has gone (or once there was nothing to send). `build`
// returns the message, or null for nothing. A mail failure leaves no
// record, so the next run tries again. -> what `list` returned.
const dailyReport = async (stores, {
  key, hour, list, build, onSent, env, mail, now,
}) => {
  const to = adminEmails(env);

  if (parts(now, tz).hour < hour || !to.length) return [];
  if (await stores.jobs.get(key)) return [];

  const items = await list();

  if (items.length) {
    try {
      await mail({ to, idempotencyKey: key, ...build(items) }, { env });
    } catch (error) {
      console.error(JSON.stringify({
        event: "mail.failed", template: key, error: String(error.message),
      }));

      return [];
    }
    if (onSent) await onSent(items);
  }
  await stores.jobs.set(key, { at: now.toISOString(), count: items.length });

  return items;
};

// The on-farm orders within PICKUPS_REPORT_DAYS of their date that
// still wait on someone: the farm to confirm, or the customer to pick
// again after a deny. Once a day from PICKUPS_REPORT_HOUR, only when
// the list is not empty. -> the ids reported this run.
export const pickupsDue = (orders, day) => orders.filter((o) =>
  o.fulfilment.method === "onfarm"
  && (needsAgreement(o) || questionOpen(o))
  && o.fulfilment.date <= addDays(day, PICKUPS_REPORT_DAYS));

const pickupsReport = async (stores, { env, mail, now }) => {
  const day = today(now, tz);
  const due = await dailyReport(stores, {
    key: `report/pickups/${day}`,
    hour: PICKUPS_REPORT_HOUR,
    list: async () => pickupsDue(await openOrders(stores), day),
    build: (orders) => farmPickupsToConfirm(orders, {
      date: day, links: mailLinks(env),
    }),
    env, mail, now,
  });

  return due.map((o) => o.id);
};

// The Venmo payments that arrived with no order number, or an amount
// that is not the order's total, since the last report. Once a day
// from VENMO_REPORT_HOUR. -> the transaction ids reported this run.
const venmoReport = async (stores, { env, mail, now }) => {
  const day = today(now, tz);
  const due = await dailyReport(stores, {
    key: `report/venmo/${day}`,
    hour: VENMO_REPORT_HOUR,
    list: () => unreportedPayments(stores),
    build: (payments) => farmVenmoUnmatched(payments, {
      date: day, links: mailLinks(env),
    }),
    onSent: (payments) => markReported(stores, payments, now),
    env, mail, now,
  });

  return due.map((v) => v.transactionId);
};

