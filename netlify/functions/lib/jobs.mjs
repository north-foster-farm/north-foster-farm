// The scheduled work, decided in America/New_York from the records
// alone, so a run at any minute does the right thing and a repeat
// run does nothing twice. Every order is paid when it is recorded, so
// nothing here chases money; the jobs mind what happens after.
//
//   delivery    18:00 the day before a delivery: cooler reminder
//   close       an order the day after fulfilment is fulfilled
//   square      a Venmo order whose Square copy failed gets another
//               try, so the dashboard sees it
//   question    an order with an open question from the farm (a denied
//               pickup window) is left alone: not closed, until the
//               customer answers
//   checkouts   a Venmo checkout nobody finished is dropped after a day
//   morning     8:00 daily, always: the day in numbers and the on-farm
//               orders within two days still waiting on someone
//   tomorrow    18:00 daily, always: every order due tomorrow, by
//               method, with what to pack and where it goes
//   audience    once a day from 05:00: the farm-news audience in Resend
//               and the records made to agree
//   health      each run ends with invariant checks, a ledger line,
//               alerts for what went wrong, and a heartbeat ping

import terms from "../../../data/delivery.json" with { type: "json" };
import { cutoffFor } from "../../../assets/scripts/order/lib/dates.mjs";
import {
  addDays, instant, parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { syncSquare } from "./checkout.mjs";
import { alert, ping, readCount, readMark } from "./health.mjs";
import { log } from "./log.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { audienceConfigured, syncAudience } from "./news.mjs";
import { sendForOrder } from "./payments.mjs";
import {
  allOrders, getCustomer, needsAgreement, openOrders, questionOpen,
  reminderPrefs, setStatus, sweepCheckouts,
} from "./records.mjs";
import { mailLinks, orderUrlFor, settingsUrlFor } from "./site.mjs";
import {
  deliveryReminder, farmMorningReport, farmTomorrow,
} from "./templates.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DELIVERY_REMINDER_HOUR = 18;
export const PICKUPS_REPORT_HOUR = 8;
export const PICKUPS_REPORT_DAYS = 2;
export const TOMORROW_REPORT_HOUR = 18;

const tz = terms.timeZone;

const sent = (order, key) => !!(order.emails && order.emails[key]);

// When a customer can no longer change or cancel an order themselves:
// the delivery cutoff, or midnight before a pickup.
export const cutoffAt = (order) => {
  const date = order.fulfilment.date;

  return order.fulfilment.method === "delivery"
    ? cutoffFor(date, terms)
    : instant(date, 0, 0, tz);
};

export const deliveryReminderAt = (order) =>
  instant(addDays(order.fulfilment.date, -1), DELIVERY_REMINDER_HOUR, 0, tz);

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
  square,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const report = {
    at: now.toISOString(), deliveryReminded: [], closed: [], squareSynced: [],
    muted: [], checkoutsSwept: 0, pickupsToConfirm: [], tomorrow: null,
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

  // A customer's reminder settings, read once per run however many
  // orders they have open. A reminder they turned off is skipped and
  // reported, never sent; fulfilment still closes on its clock.
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
    if (order.status !== "paid") return;

    if (!order.square && order.payment && order.payment.via === "venmo") {
      const synced = await syncSquare(stores, order, {
        ...opts, square, fetchImpl,
      });

      if (synced.square) report.squareSynced.push(order.id);
    }

    if (questionOpen(order)) return;

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
  };

  for (const order of await openOrders(stores)) {
    await attempt(order.id, "order", () => workOrder(order));
  }

  report.checkoutsSwept = (await attempt(null, "checkouts",
    () => sweepCheckouts(stores, now))) || 0;
  report.pickupsToConfirm = (await attempt(null, "morningReport",
    () => morningReport(stores, { env, mail, now, fetchImpl }))) || [];
  report.tomorrow = await attempt(null, "tomorrowReport",
    () => tomorrowReport(stores, { env, mail, now }));
  // Farm news: once a day the audience in Resend and the records are
  // made to agree. Null when there is no audience to sync.
  report.audience = await attempt(null, "audienceSync",
    () => audienceSyncDaily(stores, { env, now, fetchImpl }));

  report.invariants = (await attempt(null, "invariants", async () =>
    checkInvariants(await openOrders(stores), now))) || [];

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
    "deliveryReminded", "closed", "squareSynced", "muted", "pickupsToConfirm",
  ].map((k) => [k, (report[k] || []).length])),
  checkoutsSwept: report.checkoutsSwept || 0,
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

export const SQUARE_SYNC_GRACE = 24 * HOUR;

export const checkInvariants = (orders, now) => {
  const t = now.getTime();
  const day = today(now, tz);
  const found = [];

  for (const o of orders) {
    try {
      if (o.status === "paid" && !questionOpen(o)
        && day > addDays(o.fulfilment.date, 1)) {
        found.push({ rule: "paid.not_closed", id: o.id });
      }
      // Nothing makes an unpaid order any more; one still open is
      // from before the checkout moved onto the page and needs a
      // person.
      if (o.status === "submitted") {
        found.push({ rule: "legacy.unpaid", id: o.id });
      }
      if (o.status === "paid" && !o.square
        && t - Date.parse(o.paidAt || o.submittedAt) > SQUARE_SYNC_GRACE) {
        found.push({ rule: "square.missing", id: o.id });
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
  const via = (o) => (o.payment && o.payment.via) || "";
  const paid = orders.filter((o) => within(o.paidAt));
  const runs = await runsSince(stores, from);
  const mail = await readMark(stores, "mail");
  const days = (mail && mail.days) || {};
  const day = today(now, tz);
  const yesterday = addDays(day, -1);

  return {
    placed: paid.length,
    paidByCard: paid.filter((o) => via(o) === "square").length,
    paidByVenmo: paid.filter((o) => via(o) === "venmo").length,
    declined: (await readCount(stores, "declined", day))
      + (await readCount(stores, "declined", yesterday)),
    cancelled: orders.filter((o) => within(o.cancelledAt)).length,
    refunded: orders.filter((o) => o.refund && within(o.refund.at)).length,
    open: orders.filter((o) => o.status === "paid").length,
    mailFailures: (days[day] || 0) + (days[yesterday] || 0),
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
    list: async () => [{
      stats: await funnel(stores, now),
      pickups: pickupsDue(await openOrders(stores), day),
    }],
    build: ([{ stats, pickups }]) => farmMorningReport(stats, pickups, {
      date: day, links: mailLinks(env), now,
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
