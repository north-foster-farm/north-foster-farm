// The smoke signals. Three things live here:
//
// Marks: small timestamps in the jobs store (`health/<key>`) written
// by the paths that matter, so /api/health can say when the last
// webhook arrived, the last mail went out, the last order was paid.
// A mark never fails the path that writes it.
//
// Heartbeats: one GET to a healthchecks.io URL when a run went well,
// one POST to its /fail URL with the report when it did not. The
// service pages the farm when the pings stop or turn to failures,
// through a channel that is neither Resend nor Netlify.
//
// Alerts: a farm email, one per kind per hour, for a failure on the
// critical path (an order that could not be created, mail that will
// not send, a job that threw), and the same to the alert check's
// /fail URL so it reaches a phone even when Resend is the problem,
// then a success ping so the check is ready to push the next one.
//
//   HEALTHCHECKS_JOBS_URL    the jobs run's heartbeat check
//   HEALTHCHECKS_ALERT_URL   the alert channel check (period: a day;
//                            the morning report pings it well)

import terms from "../../../data/delivery.json" with { type: "json" };
import { today } from "../../../assets/scripts/order/lib/zoned.mjs";
import { adminEmails, sendMail } from "./mail.mjs";
import { log } from "./log.mjs";
import { mailLinks } from "./site.mjs";
import { farmAlert } from "./templates.mjs";

const HOUR = 60 * 60_000;

export const ALERT_EVERY = HOUR;
export const PING_TIMEOUT = 3000;
export const MAIL_FAILURES_FOR_ALARM = 3;

const key = (name) => `health/${name}`;

// -> the mark, or null. Never throws.
export const mark = async (stores, name, extra = {}, now = new Date()) => {
  const record = { at: now.toISOString(), ...extra };

  try {
    await stores.jobs.set(key(name), record);
  } catch (error) {
    log.warn({ event: "health.mark_failed", name, error: String(error) });
  }

  return record;
};

export const readMark = async (stores, name) => {
  try {
    return await stores.jobs.get(key(name));
  } catch {
    return null;
  }
};

// A tally per day (`health/<name>/<day>`), for things worth counting
// but not keeping: declined payments, say. Never throws.
export const count = async (stores, name, now = new Date()) => {
  const day = today(now, terms.timeZone);
  const k = key(`${name}/${day}`);

  try {
    const current = (await stores.jobs.get(k)) || { n: 0 };

    await stores.jobs.set(k, {
      n: (current.n || 0) + 1, at: now.toISOString(),
    });
  } catch (error) {
    log.warn({ event: "health.count_failed", name, error: String(error) });
  }
};

export const readCount = async (stores, name, day) => {
  try {
    const record = await stores.jobs.get(key(`${name}/${day}`));

    return record ? record.n || 0 : 0;
  } catch {
    return 0;
  }
};

// Mail, kept as a rolling hour of failures beside the last success,
// so the health check can tell "one bounce" from "Resend is down",
// plus a count per day (two days kept) for the morning report.
export const noteMail = async (stores, ok, now = new Date(), detail = {}) => {
  const current = (await readMark(stores, "mail")) || { fails: [], days: {} };
  const recent = (current.fails || [])
    .filter((t) => now.getTime() - Date.parse(t) < HOUR);
  const day = today(now, terms.timeZone);
  const days = Object.fromEntries(Object.entries(current.days || {})
    .filter(([d]) => d >= today(new Date(now.getTime() - 48 * HOUR),
      terms.timeZone)));
  const next = ok
    ? { ...current, lastOkAt: now.toISOString(), fails: recent, days }
    : {
      ...current,
      lastFailAt: now.toISOString(),
      lastError: detail.error || null,
      fails: [...recent, now.toISOString()],
      days: { ...days, [day]: (days[day] || 0) + 1 },
    };

  return mark(stores, "mail", next, now);
};

// One heartbeat. `ok` false posts the report to /fail. Never throws.
export const ping = async (url, {
  ok = true, body = null, fetchImpl = globalThis.fetch,
} = {}) => {
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT);

  try {
    const res = await fetchImpl(ok ? url : `${url.replace(/\/$/, "")}/fail`, {
      method: ok && !body ? "GET" : "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body).slice(0, 10_000) : undefined,
      signal: controller.signal,
    });

    return res.ok;
  } catch (error) {
    log.warn({ event: "health.ping_failed", error: String(error) });

    return false;
  } finally {
    clearTimeout(timer);
  }
};

// A failure on the critical path, with what it reached. `kind` is
// dotted and stable (order.create_failed, mail.failed, jobs.errors,
// ...); `detail` is what a person needs to act. Deduplicated per kind
// for an hour, so a storm is one email, unless `dedupe` is false.
// `mute` narrows that clock: function.crashed keeps one per function.
//
// The alert check pushes to a phone only when it changes state, so
// each /fail is followed by a success ping: every alert is a "down"
// push and then an "up", and the next alert pushes again (#248).
//
// -> { status: "sent" | "muted" | "skipped", to, mailError, failed,
//      rearmed }
export const raise = async (stores, kind, detail = {}, {
  env = process.env,
  mail = sendMail,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  dedupe = true,
  mute = kind,
} = {}) => {
  log.error({ event: "alert", kind, ...detail });

  const last = dedupe ? await readMark(stores, `alert/${mute}`) : null;
  const to = adminEmails(env);

  if (last && now.getTime() - Date.parse(last.at) < ALERT_EVERY) {
    await mark(stores, `alert/${mute}`, {
      at: last.at, muted: (last.muted || 0) + 1, lastAt: now.toISOString(),
    }, now);

    return {
      status: "muted", to, mailError: null, failed: false, rearmed: false,
    };
  }
  if (dedupe) await mark(stores, `alert/${mute}`, { muted: 0 }, now);

  let sent = false;
  let mailError = null;

  if (to.length) {
    try {
      await mail({
        to,
        idempotencyKey: `alert-${kind}-${now.getTime()}`,
        ...farmAlert(kind, detail, { at: now, links: mailLinks(env) }),
      }, { env });
      sent = true;
    } catch (error) {
      mailError = String(error);
      log.error({ event: "alert.mail_failed", kind, error: mailError });
    }
  }

  const url = env.HEALTHCHECKS_ALERT_URL;
  const failed = await ping(url, {
    ok: false, body: { kind, ...detail, at: now.toISOString() }, fetchImpl,
  });
  const rearmed = url ? await ping(url, { fetchImpl }) : false;

  return {
    status: sent ? "sent" : "skipped", to, mailError, failed, rearmed,
  };
};

// -> "sent" | "muted" | "skipped".
export const alert = async (stores, kind, detail = {}, options = {}) =>
  (await raise(stores, kind, detail, options)).status;

// The mail drivers that put an email where a person reads it: Resend,
// or the staging outbox.
export const DELIVERING = ["resend", "outbox"];

// The CLI's `alert test`: one alert through the real path, past the
// hourly mute, to prove it reaches the farm's inbox and the phone.
// Refuses unless both channels are configured (#164: a test that
// cannot fail proves nothing).
export const alertTest = async (stores, {
  env = process.env, now = new Date(), ...options
} = {}) => {
  const missing = [
    !env.HEALTHCHECKS_ALERT_URL && "HEALTHCHECKS_ALERT_URL",
    !adminEmails(env).length && "ADMIN_EMAILS",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Not set: ${missing.join(", ")}. An alert here would ` +
      "reach nobody.");
  }

  const r = await raise(stores, "alert.test", {
    message: "A test from bin/nff alert test. Nothing is wrong.",
    context: env.SITE_CONTEXT || env.CONTEXT || null,
  }, { env, now, ...options, dedupe: false });
  const driver = env.MAIL_DRIVER || "log";

  // The log and file drivers write the email where nobody reads it.
  return {
    ...r, driver,
    delivered: r.status === "sent" && DELIVERING.includes(driver),
  };
};
