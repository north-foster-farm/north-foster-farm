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
// /fail URL so it reaches a phone even when Resend is the problem.
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
  if (process.env.NODE_TEST_CONTEXT && fetchImpl === globalThis.fetch) {
    return false;
  }

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

// A failure on the critical path. `kind` is dotted and stable
// (order.create_failed, mail.failed, jobs.errors, ...); `detail` is
// what a person needs to act. Deduplicated per kind for an hour, so a
// storm is one email. -> "sent" | "muted" | "skipped".
export const alert = async (stores, kind, detail = {}, {
  env = process.env,
  mail = sendMail,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) => {
  log.error({ event: "alert", kind, ...detail });

  const last = await readMark(stores, `alert/${kind}`);

  if (last && now.getTime() - Date.parse(last.at) < ALERT_EVERY) {
    await mark(stores, `alert/${kind}`, {
      at: last.at, muted: (last.muted || 0) + 1, lastAt: now.toISOString(),
    }, now);

    return "muted";
  }
  await mark(stores, `alert/${kind}`, { muted: 0 }, now);

  const to = adminEmails(env);
  let sent = false;

  if (to.length) {
    try {
      await mail({
        to,
        idempotencyKey: `alert-${kind}-${now.getTime()}`,
        ...farmAlert(kind, detail, { at: now, links: mailLinks(env) }),
      }, { env });
      sent = true;
    } catch (error) {
      log.error({ event: "alert.mail_failed", kind, error: String(error) });
    }
  }
  await ping(env.HEALTHCHECKS_ALERT_URL, {
    ok: false, body: { kind, ...detail, at: now.toISOString() }, fetchImpl,
  });

  return sent ? "sent" : "skipped";
};
