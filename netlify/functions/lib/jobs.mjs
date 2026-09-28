// The scheduled work, decided in America/New_York from the records
// alone, so a run at any minute does the right thing and a repeat
// run does nothing twice. Every order is paid when it is recorded, so
// nothing here chases money; the jobs mind what happens after.
//
//   delivery    18:00 the day before a delivery: cooler reminder
//   close       an order the day after fulfilment is fulfilled
//   square      a Venmo order whose Square copy failed gets another
//               try, so the dashboard sees it
//   question    an order with an open question from the farm (a pickup
//               time it gave up) is left alone: not closed, until the
//               customer answers
//   rescue      a Venmo checkout the customer approved but whose page
//               never finished it (the tab closed) is captured and
//               recorded, once the page has had ten minutes
//   checkouts   a Venmo checkout nobody finished is dropped after a day
//   auth        sign-in links and sessions past their expiry are
//               deleted (#189)
//   open        7:00 daily: a Square order the site made whose payment
//               failed is reported after a day, in the morning report
//               too, and cancelled when SQUARE_SWEEP_CANCEL is "true"
//               (#241)
//   profiles    7:00 daily: a Square customer profile a checkout made,
//               whose payment never succeeded, is reported after a day,
//               in the morning report too, and deleted when
//               SQUARE_CUSTOMER_CLEANUP is "true" (#236)
//   morning     8:00 daily, always: the day in numbers, the on-farm
//               orders within two days still waiting on the customer,
//               and a warning when the pickup schedule runs short
//   tomorrow    18:00 daily, always: every order due tomorrow, by
//               method, with what to pack and where it goes
//   audience    once a day from 05:00: the farm-news audience in Resend
//               and the records made to agree
//   health      each run ends with invariant checks, a ledger line,
//               alerts for what went wrong, and a heartbeat ping

import terms from "../../../data/delivery.json" with { type: "json" };
import {
  cutoffFor, dropCutoffFor,
} from "../../../assets/scripts/order/lib/dates.mjs";
import {
  coverUntil, parseSchedule,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import {
  addDays, instant, parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { rescueCheckout, syncSquare } from "./checkout.mjs";
import { finishEditVenmo } from "./edit.mjs";
import { alert, ping, readCount, readMark } from "./health.mjs";
import { log } from "./log.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { audienceConfigured, syncAudience } from "./news.mjs";
import { sendForOrder } from "./payments.mjs";
import * as paypalApi from "./paypal.mjs";
import {
  allOrders, dropMadeCustomer, getCustomer, getOrder, listCheckouts,
  listMadeCustomers, openOrders, ordersFor, paymentsOf, questionOpen,
  refundsOf, reminderPrefs, setStatus, sweepAuth, sweepCheckouts,
} from "./records.mjs";
import { mailLinks, orderUrlFor, settingsUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import { ORDER_ID, SOURCE_NAME } from "./square.mjs";
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
// the delivery or drop-site cutoff, or midnight before an on-farm
// pickup.
export const cutoffAt = (order) => {
  const { date, method } = order.fulfilment;

  if (method === "delivery") return cutoffFor(date, terms);
  if (method === "scituate") return dropCutoffFor(date, terms);

  return instant(date, 0, 0, tz);
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
  // Null when PayPal is not configured: no checkout can be rescued.
  paypal = paypalApi.configured(env) ? paypalApi : null,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const report = {
    at: now.toISOString(), deliveryReminded: [], closed: [], squareSynced: [],
    muted: [], checkoutsRescued: [], checkoutsSwept: 0, authSwept: 0,
    squareOpen: [], customersMade: [], pickupsToConfirm: [], tomorrow: null,
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

    const first = paymentsOf(order)[0];

    if (!order.square && first && first.via === "venmo") {
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

  // Before the sweep, so an approved payment is never dropped unpaid.
  if (paypal) {
    for (const checkout of (await attempt(null, "checkouts",
      () => listCheckouts(stores))) || []) {
      const saved = await attempt(checkout.order && checkout.order.id,
        "rescue", () => rescueCheckout(stores, checkout, {
          ...opts, paypal, square, fetchImpl, finishEdit: finishEditVenmo,
        }));

      if (saved) report.checkoutsRescued.push(saved.id);
    }
  }

  report.checkoutsSwept = (await attempt(null, "checkouts",
    () => sweepCheckouts(stores, now))) || 0;
  report.authSwept = (await attempt(null, "auth",
    () => sweepAuth(stores, now))) || 0;
  report.squareOpen = (await attempt(null, "squareSweep",
    () => squareDaily(stores, "open", now, () => sweepSquareOrders(stores, {
      env, now, square, fetchImpl,
    })))) || [];
  for (const o of report.squareOpen) {
    if (o.error) fail(o.orderId, "squareCancel", o.error);
  }
  report.customersMade = (await attempt(null, "customers",
    () => squareDaily(stores, "profiles", now, () => sweepMadeCustomers(
      stores, { env, now, square, fetchImpl },
    )))) || [];
  for (const c of report.customersMade) {
    if (c.error) fail(c.orderId, "customerDelete", c.error);
  }
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

// The Square sweeps run once a day, from SQUARE_SWEEP_HOUR, an hour
// before the morning report says what they found. They ask Square
// about every order or profile they weigh, and until their switch is
// on they find the same ones again, so every run would be 96 times the
// calls for nothing new. The day's finds are kept under
// square/<name>/<day>: { at, count, done }, `done` being those
// cancelled or deleted. A run that fails keeps no mark, so the next
// run tries again. -> what the sweep found, or null when it did not run.
export const SQUARE_SWEEP_HOUR = 7;

const squareDaily = async (stores, name, now, sweep) => {
  if (parts(now, tz).hour < SQUARE_SWEEP_HOUR) return null;

  const key = `square/${name}/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return null;

  const found = await sweep();

  if (found) {
    await stores.jobs.set(key, {
      at: now.toISOString(), count: found.length,
      done: found.filter((f) => f.cancelled || f.deleted).length,
    });
  }

  return found;
};

// What today's sweeps found, for the morning report: { open,
// cancelled, profiles, deleted }.
const squareFinds = async (stores, day) => {
  const open = await stores.jobs.get(`square/open/${day}`);
  const profiles = await stores.jobs.get(`square/profiles/${day}`);

  return {
    open: (open && open.count) || 0, cancelled: (open && open.done) || 0,
    profiles: (profiles && profiles.count) || 0,
    deleted: (profiles && profiles.done) || 0,
  };
};

// --- Square orders left open (#241) ----------------------------------
//
// A card payment that fails for any reason but a decline leaves its
// Square order OPEN: the page may still retry it under the same keys,
// so nothing cancels it then. A day on, it is left over. Only an order
// the site made (its source and an order id for reference) with no
// tender, no record and no Venmo checkout waiting is one: the farm's
// own orders, paid orders and change orders to a recorded order never
// are. The sweep reports them, and cancels them only when
// SQUARE_SWEEP_CANCEL is "true".

export const SQUARE_OPEN_GRACE = 24 * HOUR;

export const leftOpen = (o) => o.tenders === 0 && o.source === SOURCE_NAME
  && ORDER_ID.test(o.referenceId || "");

// -> [{ squareOrderId, orderId, createdAt, total, cancelled, error? }],
// or null when Square is not configured.
export const sweepSquareOrders = async (stores, {
  env = process.env,
  now = new Date(),
  square = squareApi,
  fetchImpl = globalThis.fetch,
  cancel = env.SQUARE_SWEEP_CANCEL === "true",
} = {}) => {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return null;

  const found = await square.searchOpenOrders({
    before: new Date(now.getTime() - SQUARE_OPEN_GRACE),
  }, { env, fetchImpl });
  const waiting = new Set((await listCheckouts(stores))
    .map((c) => c.order && c.order.id).filter(Boolean));
  const out = [];

  for (const o of found.filter(leftOpen)) {
    if (waiting.has(o.referenceId)) continue;
    if (await getOrder(stores, o.referenceId)) continue;

    const item = {
      squareOrderId: o.id, orderId: o.referenceId, createdAt: o.createdAt,
      total: o.total, cancelled: false,
    };

    if (cancel) {
      try {
        const r = await square.cancelOrder(o.id, {
          env, fetchImpl, unpaid: true,
        });

        item.cancelled = r.cancelled;
      } catch (error) {
        item.error = String((error && error.message) || error);
      }
    }
    out.push(item);
  }

  return out;
};

// --- Square profiles a failed checkout made (#236) -------------------
//
// A profile checkout made (records.mjs, noteMadeCustomer) is weighed a
// day on, well past the page's retries and a Venmo checkout's life.
// It stays, and its note goes, when the order was recorded, when the
// customer has any other order here, or when Square shows a paid order
// for that profile from any channel (a later attempt, the market). A
// Square order for it made in the last day (a retry that may be paying
// now) leaves it for a later run, as does a retry of the same order,
// which notes it again and so restarts the day. A
// profile that was found rather than made is never noted, so never
// weighed. Otherwise it is reported, and deleted only when
// SQUARE_CUSTOMER_CLEANUP is "true". Square keeps the cancelled order.
// The note holds the customer's email, so while the switch is off it
// is kept MADE_CUSTOMER_KEEP and then dropped; the profile stays.

export const MADE_CUSTOMER_GRACE = 24 * HOUR;
export const MADE_CUSTOMER_KEEP = 30 * 24 * HOUR;

// -> [{ customerId, orderId, at, deleted, error? }] for the profiles
// with no paid order behind them, or null when Square is not
// configured.
export const sweepMadeCustomers = async (stores, {
  env = process.env,
  now = new Date(),
  square = squareApi,
  fetchImpl = globalThis.fetch,
  remove = env.SQUARE_CUSTOMER_CLEANUP === "true",
} = {}) => {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return null;

  const cutoff = now.getTime() - MADE_CUSTOMER_GRACE;
  const out = [];

  for (const made of await listMadeCustomers(stores)) {
    if (!(Date.parse(made.at) < cutoff)) continue;
    if (!remove
      && Date.parse(made.at) < now.getTime() - MADE_CUSTOMER_KEEP) {
      await dropMadeCustomer(stores, made.customerId);
      continue;
    }

    if (await getOrder(stores, made.orderId)
      || (await ordersFor(stores, made.email)).length) {
      await dropMadeCustomer(stores, made.customerId);
      continue;
    }

    const orders = await square.customerOrders(made.customerId, {
      since: new Date(cutoff),
    }, { env, fetchImpl });

    if (orders.paid) {
      await dropMadeCustomer(stores, made.customerId);
      continue;
    }
    if (orders.recent) continue;

    const item = {
      customerId: made.customerId, orderId: made.orderId, at: made.at,
      deleted: false,
    };

    if (remove) {
      try {
        await square.deleteCustomer(made.customerId, { env, fetchImpl });
        await dropMadeCustomer(stores, made.customerId);
        item.deleted = true;
      } catch (error) {
        item.error = String((error && error.message) || error);
      }
    }
    out.push(item);
  }

  return out;
};

// The report, in counts, for the ledger, the log and the heartbeat.
export const summarize = (report) => ({
  at: report.at,
  counts: Object.fromEntries([
    "deliveryReminded", "closed", "squareSynced", "muted", "checkoutsRescued",
    "pickupsToConfirm", "squareOpen", "customersMade",
  ].map((k) => [k, (report[k] || []).length])),
  squareCancelled: (report.squareOpen || []).filter((o) => o.cancelled)
    .length,
  customersDeleted: (report.customersMade || []).filter((c) => c.deleted)
    .length,
  checkoutsSwept: report.checkoutsSwept || 0,
  authSwept: report.authSwept || 0,
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
  const via = (o) => (paymentsOf(o)[0] || {}).via || "";
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
    refunded: orders
      .filter((o) => refundsOf(o).some((r) => within(r.at))).length,
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
// still wait on the customer to pick again, after the farm gave up
// their time.
export const pickupsDue = (orders, day) => orders.filter((o) =>
  o.fulfilment.method === "onfarm"
  && questionOpen(o)
  && o.fulfilment.date <= addDays(day, PICKUPS_REPORT_DAYS));

// 8:00 daily, always: the day in numbers, then the pickups waiting
// on a decision. Its going out well pings the alert channel's check,
// so a morning without it is itself an alert. -> the pickup ids
// reported this run.
// How far the pickup schedule reaches, against how far it must.
const coverage = (env, now) => {
  const { windows } = parseSchedule(env.PICKUP_SCHEDULE);

  return {
    last: windows.length ? windows[windows.length - 1].date : null,
    until: coverUntil(now, tz),
  };
};

const morningReport = async (stores, { env, mail, now, fetchImpl }) => {
  const day = today(now, tz);
  const sent = await dailyReport(stores, {
    key: `report/morning/${day}`,
    hour: PICKUPS_REPORT_HOUR,
    always: true,
    list: async () => [{
      stats: await funnel(stores, now),
      pickups: pickupsDue(await openOrders(stores), day),
      square: await squareFinds(stores, day),
    }],
    build: ([{ stats, pickups, square }]) => farmMorningReport(stats,
      pickups, {
        date: day, links: mailLinks(env), now, schedule: coverage(env, now),
        square,
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
