// The scheduled work, decided in America/New_York from the records
// alone, so a run at any minute does the right thing and a repeat
// run does nothing twice. Every order is paid when it is recorded, so
// nothing here chases money; the jobs mind what happens after.
//
//   delivery    18:00 the day before a delivery: cooler reminder
//   close       an order the day after fulfillment is fulfilled,
//               and completed in Square (lib/complete.mjs)
//   square      a Venmo order whose Square copy failed gets another
//               try, so the dashboard sees it
//   question    an order with an open question from the farm (a
//               delivery it couldn't leave) is left alone: not closed,
//               until the customer answers
//   hold        a missed delivery nobody chose for by `question.until`
//               is cancelled the day after: stock back, everything
//               refunded but a kept fee, the customer told (C8). One
//               whose email failed is emailed again first, and its
//               hold runs from then
//   rescue      a Venmo checkout the customer approved but whose page
//               never finished it (the tab closed) is captured and
//               recorded, once the page has had ten minutes
//   checkouts   a Venmo checkout nobody finished is dropped after a day
//   auth        sign-in links and sessions past their expiry are
//               deleted (#189)
//   open        7:00 daily: a Square order the site made whose payment
//               failed is reported after a day, in the morning report
//               too, and cancelled unless the Square deletion kill
//               switch is set (#241; lib/square.mjs)
//   profiles    7:00 daily: a Square customer profile a checkout made,
//               whose payment never succeeded, is reported after a day,
//               in the morning report too, and deleted unless the
//               same kill switch is set (#236)
//   morning     8:00 daily, always: the day in numbers, the on-farm
//               orders within two days still waiting on the customer,
//               a warning when the pickup schedule runs short, and the
//               messages to the farm not yet marked answered
//   tomorrow    18:00 daily, always: every order due tomorrow, by
//               method, with what to pack and where it goes
//   packing     6:00 daily, always: the packing slips as one PDF, or
//               "nothing to print"; then, all day, an order due today
//               that changes after it was printed (lib/packing.mjs)
//   packingEve  15:00 daily, always: every slip for tomorrow, so the
//               6:00 packet carries only what came after it (#515)
//   audience    once a day from 05:00: the farm-news audience in Resend
//               and the records made to agree
//   rotation    8:00 on Dec 1 and weekly after, to the developer: the
//               secrets the rotation log shows as due (lib/rotation.mjs)
//   refunds     once a day from 07:00: every refund not yet settled
//               asked of Square or PayPal, and the farm alerted to one
//               that failed or stalled (lib/settle.mjs, #215)
//   drift       once a day from 07:00: every paid order from today on
//               compared with its Square copy, and the farm told of a
//               change made in Square (lib/drift.mjs, #293)
//   hidden      once a day from 07:00: a tier the order page won't
//               sell (archived or `inStock: false`) that Square counts
//               above 0 is an invariant, told once per SKU and count
//               (#499)
//   health      each run ends with invariant checks, a ledger line,
//               alerts for what went wrong, and a heartbeat ping

import terms from "./terms.mjs";
import {
  cutoffFor, isScheduled,
} from "../../../assets/scripts/order/lib/dates.mjs";
import {
  cutoffOf as eveningBefore,
} from "../../../assets/scripts/order/lib/events.mjs";
import {
  coverUntil, parseSchedule,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import {
  addDays, instant, parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import {
  cancelOrder, listMessages, missedUntold, tellMissed,
} from "./admin.mjs";
import { announceNew, rescueCheckout, syncSquare } from "./checkout.mjs";
import { reconcile } from "./drift.mjs";
import { finishEditVenmo } from "./edit.mjs";
import {
  deleteOldMessages, scrubOldOrders, scrubPasses,
} from "./forget.mjs";
import { alert, escalate, ping, readCount, readMark } from "./health.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { quietAccounts } from "./retention.mjs";
import { completeInSquare } from "./complete.mjs";
import { farmEmails, sendMail } from "./mail.mjs";
import { audienceConfigured, syncAudience } from "./news.mjs";
import {
  changedAfterPrint, packingDaily, packingEve,
} from "./packing.mjs";
import { confirmationSent, sendForOrder } from "./payments.mjs";
import { sweepStrandedCredit } from "./credit.mjs";
import { workRounds } from "./rounds.mjs";
import { checkRefunds } from "./settle.mjs";
import * as paypalApi from "./paypal.mjs";
import {
  OPEN, allOrders, amendOrder, answerQuestion, dropMadeCustomer,
  dueOn as owedOn,
  getCustomer, getOrder, listCheckouts, listMadeCustomers, openOrders,
  ordersFor, paymentsOf, questionOpen, refundsOf, reminderPrefs, setStatus,
  sweepAuth, sweepCheckouts,
} from "./records.mjs";
import { remindersOn } from "./reminders.mjs";
import { rotationDaily } from "./rotation.mjs";
import {
  archivedOnHand, hiddenCounts, hiddenInStock,
} from "./stock.mjs";
import { mailLinks, orderUrlFor, settingsUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import { deletionsPaused } from "./square-pause.mjs";
import { ORDER_ID } from "./square.mjs";
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

// A reminder sent before a missed delivery was for that trip; the new
// day gets its own (#193).
const reminded = (order) => sent(order, "deliveryReminder")
  && !(order.attempted
    && order.emails.deliveryReminder.at < order.attempted.at);

// When a customer can no longer change or cancel an order themselves:
// the delivery or drop-site cutoff, or midnight before an on-farm
// pickup.
export const cutoffAt = (order) => {
  const { date, method } = order.fulfilment;

  if (method === "delivery") return cutoffFor(date, terms);
  if (isScheduled(order.fulfilment)) return eveningBefore(date, tz);

  return instant(date, 0, 0, tz);
};

// Whether a customer's change may still land: before the cutoff, or
// while the farm's question waits on them (lib/account.mjs's gate).
// The Venmo rescue asks before it captures a change (#292).
export const editOpen = (order, now) => order.status === "paid"
  && !order.cancelRequested
  && (now.getTime() < cutoffAt(order).getTime() || questionOpen(order));

export const deliveryReminderAt = (order) =>
  instant(addDays(order.fulfilment.date, -1), DELIVERY_REMINDER_HOUR, 0, tz);

// A missed delivery's hold (C8) runs to the end of `until`, and only
// once the customer was told: an untold miss is emailed again first.
export const holdExpired = (order, now) => questionOpen(order)
  && order.question.kind === "missed" && !!order.question.until
  && !missedUntold(order)
  && today(now, tz) > order.question.until;

// Every order's work is its own try: one that throws goes on the
// report as an error and the run carries on. The run ends with the
// invariant checks, a line in the ledger, an alert for anything that
// went wrong, and the heartbeat: well when nothing did, /fail with the
// report when something did. A run that throws before any of that is
// caught by the function wrapper and alerted as jobs.crashed.
export const runJobs = async (stores, {
  now = clock(),
  // The real time, whatever `now` is: a run as of another time (the
  // toolbar's clock, or its "as of") must not sweep or scrub shared
  // records early (#294). Tests may set it.
  realNow = new Date(),
  env = process.env,
  mail = sendMail,
  square,
  // Null when PayPal is not configured: no checkout can be rescued.
  paypal = paypalApi.configured(env) ? paypalApi : null,
  fetchImpl = globalThis.fetch,
  // The catalog as indexCatalog makes it, for tests of the archived
  // and hidden checks; the real one by default.
  catalogIndex,
  // Square's stock read (lib/square.mjs inventoryCounts), for tests of
  // the hidden check.
  inventory,
  // The end-to-end suite's run as of another day (lib/e2e.mjs) works
  // only the orders it names, so shared staging orders keep their state,
  // and only their own jobs (reminder, close, missed notice and the
  // rest of workOrder): no sweep, report, ledger line or heartbeat.
  // Those read every record, and on staging's stores ran the e2e call
  // past the function's 30 s (#516).
  orderIds = null,
} = {}) => {
  const report = {
    at: now.toISOString(), announced: [], deliveryReminded: [], closed: [],
    squareSynced: [], muted: [], missedTold: [], holdsExpired: [], rebuilt: [],
    checkoutsRescued: [], checkoutsSwept: 0, authSwept: 0, squareOpen: [],
    customersMade: [], pickupsToConfirm: [], scrubbed: [], tomorrow: null,
    packing: null, packingEve: null, changedAfterPrint: [], rotation: null,
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
  // reported, never sent; fulfillment still closes on its clock.
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
    if (!OPEN.includes(order.status)) return;

    const first = paymentsOf(order)[0];

    if (!order.square && first && first.via === "venmo") {
      const synced = await syncSquare(stores, order, {
        ...opts, square, fetchImpl,
      });

      if (synced.square) report.squareSynced.push(order.id);
    }

    // The emails of a paid order are sent after the answer that took
    // the payment (lib/checkout.mjs announceNew); one that never went
    // out, for any reason, goes now. An unpaid order the farm made
    // (#181) gets its confirmation when it is paid, not here. One the
    // old site confirmed (`paymentReceived`) was told, and one whose
    // day has passed is past telling (#490).
    if (order.status === "paid" && !confirmationSent(order)
      && today(now, tz) <= order.fulfilment.date) {
      await announceNew(stores, order, opts);
      report.announced.push(order.id);
    }

    // A missed-delivery email that failed goes again; its hold starts
    // from the day it reaches them. A failure alerts from sendForOrder.
    if (missedUntold(order)) {
      const told = await tellMissed(stores, order, opts);

      if (!missedUntold(told)) report.missedTold.push(order.id);

      return;
    }

    // Decided from the order as listed, so look again just before the
    // cancel: a customer who answered meanwhile is not cancelled.
    const fresh = holdExpired(order, now) && await getOrder(stores, order.id);

    if (fresh && holdExpired(fresh, now)) {
      // The question stays open until the cancel has gone through, so
      // a refund that fails is tried again next run, by the same key.
      await cancelOrder(stores, order.id, {
        now, env, mail, square, paypal: paypal || undefined, fetchImpl,
        source: "hold", key: `refund-hold-${order.id}`,
        reason: `Order ${order.id}, not rescheduled after a missed delivery`,
      });
      await amendOrder(stores, order.id, {
        question: answerQuestion(await getOrder(stores, order.id), "expired",
          "jobs", now),
      }, "question.expired", now);
      report.holdsExpired.push(order.id);

      return;
    }

    if (questionOpen(order)) return;

    const isDelivery = order.fulfilment.method === "delivery";

    if (isDelivery && !reminded(order)
      && now.getTime() >= deliveryReminderAt(order).getTime()
      && today(now, tz) < order.fulfilment.date
      && await wants(order, "delivery")) {
      await sendForOrder(stores, order, "deliveryReminder",
        deliveryReminder(order, {
          orderUrl: orderUrlFor(env, order.id),
          settingsUrl: settingsUrlFor(env),
          links: mailLinks(env),
        }), {
          ...opts,
          idempotencyKey:
            `${order.id}-deliveryReminder-${order.fulfilment.date}`,
        });
      report.deliveryReminded.push(order.id);
    }

    if (today(now, tz) > order.fulfilment.date) {
      const closed = await setStatus(
        stores, order.id, "fulfilled", now, { source: "jobs" }
      );

      // Null when the order was deleted since the list was read
      // (#357): nothing to close in Square, and nothing to report.
      if (!closed) return;
      // Cancelled since the list was read: the cancel stands.
      if (closed.status !== "fulfilled") return;

      // An order still owed (#181) is closed here and completed in
      // Square when the farm records the money (`orders pay`): Square
      // will not complete an order nobody has paid for.
      if (owedOn(closed) === 0) {
        await completeInSquare(stores, closed, {
          now, env, mail, square, fetchImpl,
        });
      }
      report.closed.push(order.id);
    }
  };

  // Named orders are read by id; workOrder passes over one not open.
  const orders = orderIds
    ? (await Promise.all(orderIds.map((id) => getOrder(stores, id))))
      .filter(Boolean)
    : await openOrders(stores);

  for (const order of orders) {
    await attempt(order.id, "order", () => workOrder(order));
  }

  if (orderIds) {
    log.info({ event: "jobs.run", scope: "orders", ...summarize(report) });

    return report;
  }

  // Before the sweep, so an approved payment is never dropped unpaid.
  // A checkout whose rescue failed is kept by the sweep for the next run.
  const unrescued = new Set();

  if (paypal) {
    for (const checkout of (await attempt(null, "checkouts",
      () => listCheckouts(stores))) || []) {
      const saved = await attempt(checkout.order && checkout.order.id,
        "rescue", () => rescueCheckout(stores, checkout, {
          ...opts, paypal, square, fetchImpl, finishEdit: finishEditVenmo,
          editOpen,
        }).catch((error) => {
          if (checkout.order) unrescued.add(checkout.order.id);

          throw error;
        }));

      if (saved) {
        report.checkoutsRescued.push(saved.id);
        await attempt(saved.id, "announce",
          () => announceNew(stores, saved, opts));
      }
    }
  }

  report.rebuilt = (await attempt(null, "rebuild",
    () => rebuildDaily(stores, { env, now: realNow, fetchImpl, fail }))) || [];
  report.checkoutsSwept = (await attempt(null, "checkouts",
    () => sweepCheckouts(stores, realNow, { keep: unrescued }))) || 0;
  report.authSwept = (await attempt(null, "auth",
    () => sweepAuth(stores, realNow))) || 0;
  report.scrubbed = (await attempt(null, "retention",
    () => scrubDaily(stores, realNow))) || [];
  report.quiet = await attempt(null, "quietAccounts",
    () => quietDaily(stores, { env, mail, now: realNow }));
  // Square's orders are shared data: the sweep reads the real time.
  report.squareOpen = (await attempt(null, "squareSweep",
    () => squareDaily(stores, "open", realNow, () => sweepSquareOrders(
      stores, { env, now: realNow, square, fetchImpl },
    )))) || [];
  for (const o of report.squareOpen) {
    if (o.error) fail(o.orderId, "squareCancel", o.error);
  }
  report.customersMade = (await attempt(null, "customers",
    () => squareDaily(stores, "profiles", realNow, () => sweepMadeCustomers(
      stores, { env, now: realNow, square, fetchImpl },
    )))) || [];
  for (const c of report.customersMade) {
    if (c.error) fail(c.orderId, "customerDelete", c.error);
  }
  report.pickupsToConfirm = (await attempt(null, "morningReport",
    () => morningReport(stores, {
      env, mail, now, fetchImpl, catalogIndex,
    }))) || [];
  report.tomorrow = await attempt(null, "tomorrowReport",
    () => tomorrowReport(stores, { env, mail, now }));
  report.packing = await attempt(null, "packing",
    () => packingDaily(stores, { env, mail, now, fetchImpl }));
  report.packingEve = await attempt(null, "packingEve",
    () => packingEve(stores, { env, mail, now, fetchImpl }));
  report.changedAfterPrint = (await attempt(null, "changedAfterPrint",
    () => changedAfterPrint(stores, { env, mail, now }))) || [];
  report.rotation = await attempt(null, "rotationReminder",
    () => rotationDaily(stores, { env, mail, now }));
  report.escalated = (await attempt(null, "escalation",
    () => escalate(stores, { env, mail, now }))) || [];
  // Farm news: once a day the audience in Resend and the records are
  // made to agree. Null when there is no audience to sync.
  report.audience = await attempt(null, "audienceSync",
    () => audienceSyncDaily(stores, { env, now, fetchImpl }));
  report.refunds = await attempt(null, "refundCheck",
    () => refundCheckDaily(stores, {
      env, mail, now, square, paypal, fetchImpl, fail,
    }));

  report.drift = await attempt(null, "squareDrift",
    () => driftDaily(stores, { env, mail, now, square, fetchImpl, fail }));

  // A buying group's rounds (#471): closed once their close has
  // passed, and each host reward settled at the next round's close.
  // Every run; nothing is done twice. A round that cannot settle (no
  // host on record) goes on the report as an error and is tried
  // again next run.
  report.rounds = await attempt(null, "rounds", async () => {
    const r = await workRounds(stores, {
      now, terms, env, mail, ...(square ? { square } : {}),
    });

    for (const e of r.errors) fail(`${e.group}/${e.round}`, "rounds", e.error);

    return { closed: r.closed, settled: r.settled };
  });

  // Credit a submission spent a day ago and never settled goes back
  // to its member (lib/credit.mjs). Every run; nothing twice.
  report.creditSwept = (await attempt(null, "creditSweep",
    () => sweepStrandedCredit(stores, { now }))) || [];

  const hidden = (await attempt(null, "stockHidden", () =>
    stockHiddenDaily(stores, { env, now, catalogIndex, inventory })))
    || NONE_HIDDEN;

  report.invariants = [
    ...(await attempt(null, "invariants", async () =>
      checkInvariants(await openOrders(stores), now))) || [],
    ...hidden.violations,
  ];

  await recordRun(stores, report, now);

  if (report.errors.length) {
    await alert(stores, "jobs.errors", {
      count: report.errors.length, errors: report.errors.slice(0, 10),
    }, { env, mail, now, fetchImpl });
  }

  let told = null;

  if (report.invariants.length) {
    // A hidden SKU is told once (stockHiddenDaily), so the hourly mute
    // must not swallow the run that tells it.
    const once = hidden.violations.length > 0;

    told = await alert(stores, "jobs.invariants", {
      count: report.invariants.length,
      violations: report.invariants.slice(0, 20),
    }, { env, mail, now, fetchImpl, ...(once ? { dedupe: false } : {}) });
  }
  // Hidden stock is marked told once its alert is sent, as
  // archivedInStock does, so a failed send tells it on the next run.
  if (!hidden.violations.length || told === "sent") {
    await attempt(null, "stockHidden", hidden.settle);
  }

  const healthy = !report.errors.length && !report.invariants.length;

  await ping(env.HEALTHCHECKS_JOBS_URL, {
    ok: healthy, body: healthy ? null : summarize(report), fetchImpl,
  });
  log.info({ event: "jobs.run", ...summarize(report) });

  return report;
};

// Retention (#189), once a day: orders placed more than seven years
// ago lose their customer's details, help and contact messages more
// than seven years old are deleted, and a minimum pass that can no
// longer be used loses its email (lib/forget.mjs). -> the order ids.
const scrubDaily = async (stores, now) => {
  const key = `retention/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return [];

  const ids = await scrubOldOrders(stores, now);
  const messages = await deleteOldMessages(stores, now);
  const passes = await scrubPasses(stores, now);

  await stores.jobs.set(key, {
    at: now.toISOString(), scrubbed: ids.length, messages: messages.length,
    passes: passes.length,
  });

  return ids;
};

// Quiet accounts (#189), once a day, after the scrub: a year without
// interaction takes the customer off farm news and sends the notice
// once (lib/retention.mjs). Never a deletion. At most QUIET_PER_RUN a
// day; those left over, and a notice that failed, go the next day.
// -> the counts, or null when this day has run.
const quietDaily = async (stores, { env, mail, now }) => {
  const key = `quiet/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return null;

  const r = await quietAccounts(stores, { env, mail, now });
  const counts = {
    noticed: r.noticed.length, failed: r.failed.length, left: r.left,
  };

  await stores.jobs.set(key, { at: now.toISOString(), ...counts });
  if (r.failed.length) {
    throw new Error(`${r.failed.length} quiet-account notice(s) failed`);
  }

  return counts;
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
// the site made (its version tag and an order id for reference) with no
// tender, no record and no Venmo checkout waiting is one: the farm's
// own orders, paid orders and change orders to a recorded order never
// are. The sweep reports them and cancels them, unless the Square
// deletion kill switch is set (lib/square-pause.mjs, deletionsPaused): then
// it only reports. It changes at most SQUARE_SWEEP_MAX in a run (a
// backlog would outrun the run's time); the rest are reported as
// `later` and wait for the next day's sweep.

export const SQUARE_OPEN_GRACE = 24 * HOUR;
export const SQUARE_SWEEP_MAX = 25;

export const leftOpen = (o) => o.tenders === 0 && Boolean(o.siteVersion)
  && ORDER_ID.test(o.referenceId || "");

// -> [{ squareOrderId, orderId, createdAt, total, cancelled, later?,
// error? }], or null when Square is not configured. `cancel` unset
// means unless the kill switch is set.
export const sweepSquareOrders = async (stores, {
  env = process.env,
  now = new Date(),
  square = squareApi,
  fetchImpl = globalThis.fetch,
  cancel,
  max = SQUARE_SWEEP_MAX,
} = {}) => {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return null;

  const allowed = cancel ?? !(await deletionsPaused(stores, env));
  let tries = 0;

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

    if (allowed && tries >= max) {
      item.later = true;
    } else if (allowed) {
      tries += 1;
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
// weighed. Otherwise it is reported and deleted, unless the Square
// deletion kill switch is set (lib/square-pause.mjs, deletionsPaused): then
// it is only reported. Square keeps the cancelled order. The note
// holds the customer's email, so while the switch is set it is kept
// MADE_CUSTOMER_KEEP and then dropped; the profile stays.

export const MADE_CUSTOMER_GRACE = 24 * HOUR;
export const MADE_CUSTOMER_KEEP = 30 * 24 * HOUR;

// -> [{ customerId, orderId, at, deleted, later?, error? }] for the
// profiles with no paid order behind them, or null when Square is not
// configured. `remove` unset means unless the kill switch is set; at
// most `max` are deleted in a run, as for the orders.
export const sweepMadeCustomers = async (stores, {
  env = process.env,
  now = new Date(),
  square = squareApi,
  fetchImpl = globalThis.fetch,
  remove: asked,
  max = SQUARE_SWEEP_MAX,
} = {}) => {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return null;

  const paused = await deletionsPaused(stores, env);
  const remove = asked ?? !paused;
  let tries = 0;

  const cutoff = now.getTime() - MADE_CUSTOMER_GRACE;
  const out = [];

  for (const made of await listMadeCustomers(stores)) {
    if (!(Date.parse(made.at) < cutoff)) continue;
    // Only the switch ages a note out: a report run (remove false, the
    // switch unset) forgets nothing the next real run would delete.
    if (!remove && paused
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

    if (remove && tries >= max) {
      item.later = true;
    } else if (remove) {
      tries += 1;
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

// Refunds, once a day from REFUND_CHECK_HOUR: each one not yet settled
// asked of its processor (lib/settle.mjs). A refund the processor
// could not be asked about goes on the report as an error, and is
// asked again tomorrow. -> the counts, or null when nothing was done
// this run.
export const REFUND_CHECK_HOUR = 7;

const refundCheckDaily = async (stores, {
  env, mail, now, square, paypal, fetchImpl, fail,
}) => {
  if (parts(now, tz).hour < REFUND_CHECK_HOUR) return null;

  const key = `refunds/check/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return null;

  const r = await checkRefunds(stores, {
    env, mail, now, fetchImpl, paypal,
    ...(square ? { square } : {}),
  });

  for (const e of r.errors) fail(e.id, "refundCheck", e.error);
  await stores.jobs.set(key, { at: now.toISOString() });

  return {
    checked: r.checked,
    completed: r.completed.length,
    failed: r.failed.length,
    stalled: r.stalled.length,
    pending: r.pending.length,
  };
};

// Orders changed in Square, once a day from DRIFT_CHECK_HOUR (see
// lib/drift.mjs). A run that errors keeps no mark and tries again.
// -> the counts, or null when nothing was done this run.
export const DRIFT_CHECK_HOUR = 7;

const driftDaily = async (stores, {
  env, mail, now, square, fetchImpl, fail,
}) => {
  if (parts(now, tz).hour < DRIFT_CHECK_HOUR) return null;
  if (!env.SQUARE_ACCESS_TOKEN && env.SQUARE_ENV !== "fake") return null;

  const key = `drift/check/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return null;

  const r = await reconcile(stores, {
    env, mail, now, fetchImpl, ...(square ? { square } : {}),
  });

  for (const e of r.errors) fail(e.id, "squareDrift", e.error);
  if (!r.errors.length) {
    await stores.jobs.set(key, { at: now.toISOString() });
  }

  return {
    checked: r.checked,
    flagged: r.found.filter((f) => f.status === "flagged").length,
    errors: r.errors.length,
  };
};

// Stock nobody can order (#499), once a day from STOCK_HIDDEN_HOUR:
// each tier the order page won't sell, archived or `inStock: false`,
// that Square counts above 0 goes on the run's invariants as
// `stock.hidden`, so the jobs.invariants alert tells the farm. A
// hiatus or discontinued tier with stock sells, as it should, and is
// not one. A SKU at a count already told is not told again; one whose
// count changes, or that goes to 0 and comes back, is. The told counts
// are kept under `stock/hidden`, the day's mark under
// `stock/hidden/<day>`, and both are written by `settle`, which the run
// calls once the alert is sent, or at once when there is nothing new
// to tell. A Square that doesn't answer, or an alert that isn't sent,
// leaves no mark, so the next run asks again.
// -> { violations: [{ rule, id, why, count }] newly found, settle }.
export const STOCK_HIDDEN_HOUR = 7;
export const HIDDEN_TOLD = "stock/hidden";

const NONE_HIDDEN = { violations: [], settle: async () => {} };

const stockHiddenDaily = async (stores, {
  env, now, catalogIndex, inventory,
}) => {
  if (parts(now, tz).hour < STOCK_HIDDEN_HOUR) return NONE_HIDDEN;

  const key = `${HIDDEN_TOLD}/${today(now, tz)}`;

  if (await stores.jobs.get(key)) return NONE_HIDDEN;

  const list = await hiddenCounts({ catalogIndex, env, inventory });

  if (!list) return NONE_HIDDEN;

  const found = hiddenInStock(list);
  const told = ((await stores.jobs.get(HIDDEN_TOLD)) || {}).counts || {};
  const fresh = found.filter((i) => told[i.sku] !== i.count);

  if (fresh.length) {
    log.warn({ event: "stock.hidden_in_stock",
      skus: fresh.map((i) => i.sku) });
  }

  return {
    violations: fresh.map((i) => ({
      rule: "stock.hidden", id: i.sku, why: i.why, count: i.count,
    })),
    settle: async () => {
      await stores.jobs.set(HIDDEN_TOLD, {
        at: now.toISOString(),
        counts: Object.fromEntries(found.map((i) => [i.sku, i.count])),
      });
      await stores.jobs.set(key, {
        at: now.toISOString(), count: found.length,
      });
    },
  };
};

// A money change that takes effect on a date (data/delivery.json,
// money.changes) reaches the order page and the functions by itself;
// the pages Hugo rendered need a build on or after the day. The first
// run on the day (the farm's zone) posts the build hook once, kept
// under rebuild/<day> so a later run does not post it again; one that
// is missed starts it up to REBUILD_WITHIN_DAYS late. A hook that
// fails leaves no mark and is tried again next run. With no hook set
// (PICKUP_SCHEDULE_HOOK, on Netlify too) nothing is posted and the
// morning report's reminder says to deploy by hand.
// -> the change days it started a build for.
export const REBUILD_WITHIN_DAYS = 7;
export const REBUILD_TIMEOUT = 10_000;

const rebuildDaily = async (stores, { env, now, fetchImpl, fail }) => {
  const hook = env.PICKUP_SCHEDULE_HOOK;
  const day = today(now, tz);
  const started = [];

  if (!hook) return started;

  for (const { from } of terms.money.changes || []) {
    if (from > day || day > addDays(from, REBUILD_WITHIN_DAYS)) continue;

    const key = `rebuild/${from}`;

    if (await stores.jobs.get(key)) continue;

    // A hook that hangs must not hold the run: ten seconds, then it
    // counts as unanswered and is tried again next run.
    const res = await fetchImpl(hook, {
      method: "POST", signal: AbortSignal.timeout(REBUILD_TIMEOUT),
    }).catch(() => null);

    if (!res || !res.ok) {
      fail(null, "rebuild", res ? `build hook answered ${res.status}`
        : "build hook did not answer");
      continue;
    }
    await stores.jobs.set(key, { at: now.toISOString() });
    started.push(from);
  }

  return started;
};

// The report, in counts, for the ledger, the log and the heartbeat.
export const summarize = (report) => ({
  at: report.at,
  counts: Object.fromEntries([
    "announced", "deliveryReminded", "closed", "squareSynced", "muted",
    "missedTold", "holdsExpired", "rebuilt", "checkoutsRescued",
    "pickupsToConfirm", "scrubbed", "changedAfterPrint", "squareOpen",
    "customersMade",
  ].map((k) => [k, (report[k] || []).length])),
  squareCancelled: (report.squareOpen || []).filter((o) => o.cancelled)
    .length,
  customersDeleted: (report.customersMade || []).filter((c) => c.deleted)
    .length,
  packing: report.packing || null,
  packingEve: report.packingEve || null,
  checkoutsSwept: report.checkoutsSwept || 0,
  authSwept: report.authSwept || 0,
  tomorrow: report.tomorrow,
  rotation: report.rotation || null,
  audience: report.audience || null,
  quiet: report.quiet || null,
  refunds: report.refunds || null,
  drift: report.drift || null,
  rounds: report.rounds || null,
  creditSwept: (report.creditSwept || []).length,
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
      if (OPEN.includes(o.status) && !questionOpen(o)
        && day > addDays(o.fulfilment.date, 1)) {
        found.push({ rule: "paid.not_closed", id: o.id });
      }
      // Nothing makes an unpaid order any more; one still open is
      // from before the checkout moved onto the page and needs a
      // person.
      if (o.status === "submitted") {
        found.push({ rule: "legacy.unpaid", id: o.id });
      }
      if (OPEN.includes(o.status) && !o.square
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

export const recordRun = async (stores, report, now = clock()) => {
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
    open: orders.filter((o) => OPEN.includes(o.status)).length,
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
  const to = farmEmails(env);

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

      // The run's error, so the heartbeat and the jobs.errors alert
      // see a report that never went out.
      throw error;
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

const morningReport = async (stores, {
  env, mail, now, fetchImpl, catalogIndex,
}) => {
  const day = today(now, tz);
  const sent = await dailyReport(stores, {
    key: `report/morning/${day}`,
    hour: PICKUPS_REPORT_HOUR,
    always: true,
    list: async () => [{
      stats: await funnel(stores, now),
      pickups: pickupsDue(await openOrders(stores), day),
      archived: await archivedOnHand(stores, { catalogIndex, env }),
      messages: await listMessages(stores),
      square: {
        ...await squareFinds(stores, day),
        paused: await deletionsPaused(stores, env),
      },
    }],
    build: ([{
      stats, pickups, archived, messages, square,
    }]) => farmMorningReport(stats, pickups, {
      date: day, links: mailLinks(env), now, schedule: coverage(env, now),
      archived, messages, square, reminders: remindersOn(day),
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
