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
//   morning     8:00 daily, always: the day in numbers and the on-farm
//               orders within two days still waiting on someone
//   venmo       18:00 daily, the Venmo payments that named no order or
//               the wrong amount, to ADMIN_EMAILS
//   tomorrow    18:00 daily, always: every order due tomorrow, by
//               method, with what to pack and where it goes
//   health      each run ends with invariant checks, a ledger line,
//               alerts for what went wrong, and a heartbeat ping

import terms from "../../../data/delivery.json" with { type: "json" };
import { cutoffFor } from "../../../assets/scripts/order/lib/dates.mjs";
import {
  addDays, instant, parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { alert, ping, readMark } from "./health.mjs";
import { log } from "./log.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { audienceConfigured, syncAudience } from "./news.mjs";
import { pollUnpaid, sendForOrder } from "./payments.mjs";
import {
  allOrders, amendOrder, getCustomer, needsAgreement, openOrders,
  questionOpen, reminderPrefs, setStatus,
} from "./records.mjs";
import { mailLinks, orderUrlFor, settingsUrlFor } from "./site.mjs";
import {
  bankTransferOffered, cancelInvoice, closeBankTransfer, getInvoice,
} from "./square.mjs";
import { adjust } from "./stock.mjs";
import {
  deliveryReminder, farmMorningReport, farmTomorrow, farmVenmoUnmatched,
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
export const TOMORROW_REPORT_HOUR = 18;

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

// Every order's work is its own try: one that throws goes on the
// report as an error and the run carries on. The run ends with the
// invariant checks, a line in the ledger, an alert for anything that
// went wrong, and the heartbeat: well when nothing did, /fail with the
// report when something did. A run that throws before any of that is
// caught by the function wrapper and alerted as jobs.crashed.
export const runJobs = async (stores, {
  now = new Date(),
  env = process.env,
  mail = sendMail,
  invoice = getInvoice,
  cancel = cancelInvoice,
  close = closeBankTransfer,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const report = {
    at: now.toISOString(), paid: [], reminded: [], abandoned: [],
    deliveryReminded: [], closed: [], bankTransferClosed: [], muted: [],
    pickupsToConfirm: [], venmoReported: [], tomorrow: null,
    errors: [], invariants: [],
  };
  const opts = { env, mail, now };
  const fail = (id, step, error) => {
    const message = String((error && error.message) || error);

    report.errors.push({ id, step, error: message });
    log.error({ event: "jobs.step_failed", id, step, error: message });
  };
  const attempt = async (id, step, work) => {
    try {
      return await work();
    } catch (error) {
      fail(id, step, error);

      return undefined;
    }
  };

  report.paid = (await attempt(null, "poll", async () => pollUnpaid(
    stores, await openOrders(stores), { invoice, ...opts }
  ))) || [];

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

  const workOrder = async (order) => {
    if (questionOpen(order)) return;

    if (order.status === "submitted") {
      if (order.paymentPending) return;

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
            log.error({
              event: "invoice.cancel_failed", id: order.id,
              error: String(error.message),
            });
          }
        }

        return;
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
          log.error({
            event: "bank_transfer.close_failed", id: order.id,
            error: String(error.message),
          });
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
  };

  // Re-read: the poll may have paid some.
  for (const order of await openOrders(stores)) {
    await attempt(order.id, "order", () => workOrder(order));
  }

  report.pickupsToConfirm = (await attempt(null, "morningReport",
    () => morningReport(stores, { env, mail, now, fetchImpl }))) || [];
  report.venmoReported = (await attempt(null, "venmoReport",
    () => venmoReport(stores, { env, mail, now }))) || [];
  report.tomorrow = await attempt(null, "tomorrowReport",
    () => tomorrowReport(stores, { env, mail, now }));
  // Farm news: once a day the audience in Resend and the records are
  // made to agree. Null when there is no audience to sync.
  report.audience = await attempt(null, "audienceSync",
    () => audienceSyncDaily(stores, { env, now, fetchImpl }));

  report.invariants = (await attempt(null, "invariants", async () =>
    checkInvariants(await openOrders(stores), now, prefs))) || [];

  await recordRun(stores, report, now);

  if (report.errors.length) {
    await alert(stores, "jobs.errors", {
      count: report.errors.length, errors: report.errors.slice(0, 10),
    }, { env, mail, now, fetchImpl });
  }
  if (report.invariants.length) {
    await alert(stores, "jobs.invariants", {
      count: report.invariants.length,
      violations: report.invariants.slice(0, 20),
    }, { env, mail, now, fetchImpl });
  }

  const healthy = !report.errors.length && !report.invariants.length;

  await ping(env.HEALTHCHECKS_JOBS_URL, {
    ok: healthy, body: healthy ? null : summarize(report), fetchImpl,
  });
  log.info({ event: "jobs.run", ...summarize(report) });

  return report;
};

// Farm news, once a day from AUDIENCE_SYNC_HOUR: the audience in Resend
// and the records made to agree (lib/news.mjs). -> the counts, or null
// when nothing was done this run.
const AUDIENCE_SYNC_HOUR = 5;

const audienceSyncDaily = async (stores, { env, now, fetchImpl }) => {
  if (!audienceConfigured(env)) return null;
  if (parts(now, tz).hour < AUDIENCE_SYNC_HOUR) return null;

  const key = `news/sync/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return null;

  const r = await syncAudience(stores, { env, now, fetchImpl });

  await stores.jobs.set(key, { at: now.toISOString() });

  return {
    created: r.created.length,
    resubscribed: r.resubscribed.length,
    unsubscribed: r.unsubscribed.length,
    optedOut: r.optedOut.length,
    imported: r.imported.length,
  };
};

// The report, in counts, for the ledger, the log and the heartbeat.
export const summarize = (report) => ({
  at: report.at,
  counts: Object.fromEntries([
    "paid", "reminded", "abandoned", "deliveryReminded", "closed",
    "bankTransferClosed", "muted", "pickupsToConfirm", "venmoReported",
  ].map((k) => [k, (report[k] || []).length])),
  tomorrow: report.tomorrow,
  audience: report.audience || null,
  errors: report.errors,
  invariants: report.invariants,
});

// --- Invariants ----------------------------------------------------
//
// What must be true of the open orders after a healthy run. A
// violation means the job ran but did not do its work: a logic bug,
// a store that would not write, a run that kept failing on one order.
// Each is a rule name and the order it names.

export const INVARIANT_GRACE = 30 * MINUTE;
export const PAY_LINK_GRACE = 20 * MINUTE;
export const VENMO_HOLD_GRACE = 24 * HOUR;

export const checkInvariants = (orders, now, prefs = new Map()) => {
  const t = now.getTime();
  const day = today(now, tz);
  const found = [];
  const muted = (order) => {
    const p = prefs.get(order.customer.email);

    return p ? !p.payment : false;
  };

  for (const o of orders) {
    try {
      const held = !!o.paymentPending || questionOpen(o);

      if (o.status === "submitted" && !held
        && t > abandonAt(o).getTime() + INVARIANT_GRACE) {
        found.push({ rule: "unpaid.past_cutoff", id: o.id });
      }
      if (o.status === "paid" && !questionOpen(o)
        && day > addDays(o.fulfilment.date, 1)) {
        found.push({ rule: "paid.not_closed", id: o.id });
      }
      if (o.status === "submitted" && !sent(o, "completeYourOrder")
        && t - Date.parse(o.submittedAt) > PAY_LINK_GRACE) {
        found.push({ rule: "order.no_pay_link", id: o.id });
      }
      if (o.status === "submitted" && !held && !muted(o)
        && reminderDue(o, new Date(t - INVARIANT_GRACE))) {
        found.push({ rule: "reminder.overdue", id: o.id });
      }
      if (o.paymentPending && o.paymentPending.source === "venmo"
        && t - Date.parse(o.paymentPending.at) > VENMO_HOLD_GRACE) {
        found.push({ rule: "venmo.unchecked", id: o.id });
      }
    } catch {
      // A record the rules cannot even read is its own violation.
      found.push({ rule: "order.unreadable", id: o.id });
    }
  }

  return found;
};

// --- The ledger ----------------------------------------------------
//
// One record per run in the jobs store, `run/<time>`, two days kept:
// the counts, the errors and the violations. `bin/nff jobs history`
// prints it; /api/health reads the latest.

export const LEDGER_KEEP = 48 * 60 * MINUTE;

export const recordRun = async (stores, report, now = new Date()) => {
  const key = `run/${now.toISOString()}`;

  try {
    await stores.jobs.set(key, summarize(report));

    const cutoff = `run/${new Date(now.getTime() - LEDGER_KEEP).toISOString()}`;

    for (const { key: k } of await stores.jobs.list("run/")) {
      if (k < cutoff) await stores.jobs.delete(k);
    }
  } catch (error) {
    log.error({ event: "jobs.ledger_failed", error: String(error.message) });
  }

  return key;
};

// The runs since an instant, newest first.
export const runsSince = async (stores, since) => {
  const floor = `run/${since.toISOString()}`;
  const keys = (await stores.jobs.list("run/"))
    .filter(({ key }) => key >= floor);
  const runs = await Promise.all(keys.map(({ key }) => stores.jobs.get(key)));

  return runs.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
};

// --- The day in numbers ---------------------------------------------

// What happened in the last day, for the morning report.
export const funnel = async (stores, now, { since } = {}) => {
  const from = since || new Date(now.getTime() - 24 * 60 * MINUTE);
  const iso = from.toISOString();
  const orders = await allOrders(stores);
  const within = (at) => !!at && at >= iso;
  const paidSource = (o) => {
    const entry = (o.history || []).find((h) => h.event === "paid");

    return entry ? entry.source || "" : "";
  };
  const paid = orders.filter((o) => within(o.paidAt));
  const runs = await runsSince(stores, from);
  const mail = await readMark(stores, "mail");
  const days = (mail && mail.days) || {};
  const day = today(now, tz);

  return {
    placed: orders.filter((o) => within(o.submittedAt)).length,
    paid: paid.length,
    paidByWebhook: paid.filter((o) => paidSource(o) === "webhook").length,
    paidByPoll: paid.filter((o) => paidSource(o) === "poll").length,
    paidByHand: paid.filter((o) => ["farm", "venmo"].includes(paidSource(o)))
      .length,
    abandoned: orders.filter((o) => within(o.abandonedAt)).length,
    cancelled: orders.filter((o) => within(o.cancelledAt)).length,
    openUnpaid: orders.filter((o) => o.status === "submitted").length,
    mailFailures: (days[day] || 0) + (days[addDays(day, -1)] || 0),
    runs: runs.length,
    jobErrors: runs.reduce((n, r) => n + (r.errors || []).length, 0),
    invariants: runs.reduce((n, r) => n + (r.invariants || []).length, 0),
  };
};

// A once-a-day farm email, recorded in the jobs store under `key`
// once it has gone (or once there was nothing to send). `build`
// returns the message. With `always` the email goes even when `list`
// is empty, so its absence means something. A mail failure leaves no
// record, so the next run tries again. -> what `list` returned, or
// null when nothing was done this run.
const dailyReport = async (stores, {
  key, hour, list, build, onSent, always = false, env, mail, now,
}) => {
  const to = adminEmails(env);

  if (parts(now, tz).hour < hour || !to.length) return null;
  if (await stores.jobs.get(key)) return null;

  const items = await list();

  if (items.length || always) {
    try {
      await mail({ to, idempotencyKey: key, ...build(items) }, { env });
    } catch (error) {
      log.error({
        event: "mail.failed", template: key, error: String(error.message),
      });

      return null;
    }
    if (onSent) await onSent(items);
  }
  await stores.jobs.set(key, { at: now.toISOString(), count: items.length });

  return items;
};

// The on-farm orders within PICKUPS_REPORT_DAYS of their date that
// still wait on someone: the farm to confirm, or the customer to pick
// again after a deny.
export const pickupsDue = (orders, day) => orders.filter((o) =>
  o.fulfilment.method === "onfarm"
  && (needsAgreement(o) || questionOpen(o))
  && o.fulfilment.date <= addDays(day, PICKUPS_REPORT_DAYS));

// 8:00 daily, always: the day in numbers, then the pickups waiting
// on a decision. Its going out well pings the alert channel's check,
// so a morning without it is itself an alert. -> the pickup ids
// reported this run.
const morningReport = async (stores, { env, mail, now, fetchImpl }) => {
  const day = today(now, tz);
  const sent = await dailyReport(stores, {
    key: `report/morning/${day}`,
    hour: PICKUPS_REPORT_HOUR,
    always: true,
    list: async () => {
      const open = await openOrders(stores);

      return [{
        stats: await funnel(stores, now),
        pickups: pickupsDue(open, day),
        holds: open.filter((o) => o.paymentPending
          && o.paymentPending.source === "venmo"),
      }];
    },
    build: ([{ stats, pickups, holds }]) => farmMorningReport(stats, pickups, {
      date: day, links: mailLinks(env), holds, now,
    }),
    onSent: () => ping(env.HEALTHCHECKS_ALERT_URL, { ok: true, fetchImpl }),
    env, mail, now,
  });

  return sent ? sent[0].pickups.map((o) => o.id) : [];
};

// 18:00 daily, always: every order due tomorrow, by method, with what
// the driver and the packer need. -> how many, or null when not sent
// this run.
export const dueOn = (orders, date) =>
  orders.filter((o) => o.fulfilment.date === date);

const tomorrowReport = async (stores, { env, mail, now }) => {
  const day = today(now, tz);
  const tomorrow = addDays(day, 1);
  const sent = await dailyReport(stores, {
    key: `report/tomorrow/${day}`,
    hour: TOMORROW_REPORT_HOUR,
    always: true,
    list: async () => dueOn(await openOrders(stores), tomorrow),
    build: (orders) => farmTomorrow(orders, {
      date: tomorrow, links: mailLinks(env),
    }),
    env, mail, now,
  });

  return sent ? sent.length : null;
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

  return (due || []).map((v) => v.transactionId);
};

