// GET  /api/health   what the records say about the last hour, and
//                    200 or 503 with it, for an outside pinger
// POST /api/health   a beacon from the order page when a checkout
//                    could not be completed; becomes an alert
//
// The 503 rules are deliberately few: the jobs run is stale, or mail
// has failed repeatedly with no success since. Everything else is
// reported, not judged; the alerts carry the judgment.

import { runsSince } from "./lib/jobs.mjs";
import { json, readJson } from "./lib/http.mjs";
import { alert, readMark } from "./lib/health.mjs";
import { log, withLog } from "./lib/log.mjs";
import { openOrders } from "./lib/records.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

const MINUTE = 60_000;

export const JOBS_STALE_AFTER = 45 * MINUTE;
export const MAIL_FAILURES_FOR_ALARM = 3;

// Beacons the order page may send, and the alert kind each becomes.
const BEACONS = {
  "checkout.failed": "client.checkout_failed",
};

// Per-instance, best effort.
const RATE = { windowMs: 10 * MINUTE, max: 10 };
const hits = new Map();

const rateLimited = (ip, now) => {
  if (!ip) return false;

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > RATE.max;
};

const ago = (iso, now) => (iso ? Math.round((now - Date.parse(iso)) / MINUTE)
  : null);

export const snapshot = async (stores, {
  env = process.env, now = new Date(),
} = {}) => {
  const t = now.getTime();
  const [runs, mail, webhook, paid, order, open] = await Promise.all([
    runsSince(stores, new Date(t - 24 * 60 * MINUTE)),
    readMark(stores, "mail"),
    readMark(stores, "webhook"),
    readMark(stores, "paid"),
    readMark(stores, "order"),
    openOrders(stores),
  ]);
  const lastRun = runs[0] || null;
  const mailFails = (mail && mail.fails || [])
    .filter((x) => t - Date.parse(x) < 60 * MINUTE);
  // Failures count against mail until a send succeeds after the last
  // of them; never having succeeded does not count as fine.
  const mailOkSince = !mailFails.length || !!(mail && mail.lastOkAt
    && Date.parse(mail.lastOkAt) > Date.parse(mailFails[mailFails.length - 1]));
  const problems = [];

  if (!lastRun) {
    problems.push("no jobs run recorded in the last day");
  } else if (t - Date.parse(lastRun.at) > JOBS_STALE_AFTER) {
    problems.push(`last jobs run ${ago(lastRun.at, t)} minutes ago`);
  }
  if (lastRun && lastRun.errors && lastRun.errors.length) {
    problems.push(`last jobs run had ${lastRun.errors.length} error(s)`);
  }
  if (mailFails.length >= MAIL_FAILURES_FOR_ALARM && !mailOkSince) {
    problems.push(`${mailFails.length} mail failures in the last hour, ` +
      "none sent since");
  }

  return {
    ok: problems.length === 0,
    at: now.toISOString(),
    problems,
    jobs: {
      lastRunAt: lastRun ? lastRun.at : null,
      minutesAgo: lastRun ? ago(lastRun.at, t) : null,
      runsLastDay: runs.length,
      errorsLastRun: lastRun && lastRun.errors ? lastRun.errors.length : 0,
      invariantsLastRun: lastRun && lastRun.invariants
        ? lastRun.invariants.length : 0,
    },
    mail: {
      driver: env.MAIL_DRIVER || "log",
      lastOkAt: (mail && mail.lastOkAt) || null,
      lastFailAt: (mail && mail.lastFailAt) || null,
      failuresLastHour: mailFails.length,
    },
    webhook: { lastAt: webhook ? webhook.at : null },
    orders: {
      open: open.length,
      lastCreatedAt: order ? order.at : null,
      lastPaidAt: paid ? paid.at : null,
    },
    context: env.CONTEXT || null,
    log: !!(env.AXIOM_TOKEN && env.AXIOM_DATASET),
    heartbeat: !!env.HEALTHCHECKS_JOBS_URL,
  };
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  ip = "",
  mail,
  fetchImpl,
} = {}) => {
  if (req.method === "GET") {
    const s = await snapshot(stores, { env, now });

    log.info({ event: "health.checked", ok: s.ok, problems: s.problems });

    return json(s.ok ? 200 : 503, s);
  }

  if (req.method !== "POST") return json(405, { error: "GET or POST." });
  if (rateLimited(ip, now.getTime())) return json(202, { ok: true });

  const body = await readJson(req);
  const kind = body && BEACONS[body.kind];

  if (!kind) return json(400, { error: "Unknown beacon." });

  const detail = {
    message: String(body.message || "").slice(0, 300),
    status: Number(body.status) || null,
    attempts: Number(body.attempts) || null,
    orderId: String(body.orderId || "").slice(0, 40) || null,
    method: String(body.method || "").slice(0, 20) || null,
    page: String(body.page || "").slice(0, 200) || null,
  };

  await alert(stores, kind, detail, { env, mail, now, fetchImpl });

  return json(202, { ok: true });
};

export default withLog(async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: "/api/health",
  method: ["GET", "POST"],
};
