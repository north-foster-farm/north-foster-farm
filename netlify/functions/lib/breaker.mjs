// The Resend send breaker (#267). Abnormal send activity is found by
// the code and shut down before it does damage, even when the cause
// turns out to be harmless. It trips on three things:
//
//   foreign   Resend reports an email.sent whose message id our send
//             path never recorded: the key is in use outside our code.
//   volume    sends in this hour or today are over data/breaker.json's
//             ceiling, plus any bulk send declared beforehand
//             (`bin/nff breaker declare`). Our own send path asks
//             first, so a loop in our code stops on our side.
//   reputation  bounces or complaints, within the last windowHours,
//             over the configured rate or count.
//
// Tripped, it writes a flag to the jobs store (not memory, so every
// function instance sees it), deletes the sending key through
// Resend's API with the full-access audience key, and alerts through
// Healthchecks, which does not use Resend. Mail that arrives while
// tripped is kept under breaker/unsent/ for `bin/nff breaker flush`.
// Only `bin/nff breaker reset` clears it. Nothing here resets itself.
//
// Keys in the jobs store:
//
//   breaker/state              the trip, while there is one
//   breaker/baseline           when it was last reset; older sends no
//                              longer count
//   breaker/ledger/<id>        a Resend message id we sent
//   breaker/sends/<hour>/<ms>-<uuid>   one per recipient, counted
//   breaker/events/<hour>/<kind>-<emailId>   a bounce or complaint
//   breaker/declared/<id>      a bulk send announced beforehand
//   breaker/unsent/<id>        mail held while tripped
//   breaker/incident/<at>      each trip, kept after a reset
//
// Hours and days are UTC.

import { randomUUID } from "node:crypto";

import thresholds from "../../../data/breaker.json" with { type: "json" };
import { ping } from "./health.mjs";
import { timedFetch } from "./http.mjs";
import { log } from "./log.mjs";
import { resendAllowed, resendRefusal } from "./resend-guard.mjs";

export const STATE = "breaker/state";
export const BASELINE = "breaker/baseline";
export const LEDGER = "breaker/ledger/";
export const SENDS = "breaker/sends/";
export const EVENTS = "breaker/events/";
export const DECLARED = "breaker/declared/";
export const UNSENT = "breaker/unsent/";
export const INCIDENT = "breaker/incident/";

const HOUR = 3600 * 1000;
const API = "https://api.resend.com";
const API_MS = 4000;

const hourKey = (date) => date.toISOString().slice(0, 13);
const dayKey = (date) => date.toISOString().slice(0, 10);

const recipients = (message) =>
  (Array.isArray(message.to) ? message.to : [message.to]).filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -> the state document while tripped, else null.
export const readState = (stores) => stores.jobs.get(STATE);

export const isTripped = async (stores) => !!(await readState(stores));

// Sends counted since the last reset: a key's "<ms>-<uuid>" name is
// its time.
const sinceReset = async (stores) => {
  const baseline = await stores.jobs.get(BASELINE);
  const from = baseline ? Date.parse(baseline.at) : 0;

  return (key) => Number(key.split("/").pop().split("-")[0]) > from;
};

// -> the number of sends recorded under a key prefix, since the reset.
const tally = async (stores, prefix, counted) =>
  (await stores.jobs.list(prefix)).filter(({ key }) => counted(key)).length;

export const counts = async (stores, now = new Date()) => {
  const counted = await sinceReset(stores);

  return {
    hour: await tally(stores, `${SENDS}${hourKey(now)}/`, counted),
    day: await tally(stores, `${SENDS}${dayKey(now)}`, counted),
  };
};

// Bulk sends announced beforehand, active at `now`.
export const declarations = async (stores, now = new Date()) => {
  const out = [];

  for (const { key } of await stores.jobs.list(DECLARED)) {
    const d = await stores.jobs.get(key);

    if (d) out.push({ id: key.slice(DECLARED.length), ...d });
  }

  return out.filter((d) => Date.parse(d.from) <= now.getTime()
    && now.getTime() < Date.parse(d.until));
};

// A planned bulk send raises both ceilings by its expected count, for
// its window only.
export const declare = async (stores, {
  count, hours = 24, note = "", now = new Date(),
} = {}) => {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Declare how many emails to expect, a whole number.");
  }
  if (!(hours > 0 && hours <= 72)) {
    throw new Error("A declared window is up to 72 hours.");
  }

  const id = `${now.getTime()}-${randomUUID().slice(0, 8)}`;
  const record = {
    count,
    note,
    from: now.toISOString(),
    until: new Date(now.getTime() + hours * HOUR).toISOString(),
  };

  await stores.jobs.set(`${DECLARED}${id}`, record);

  return { id, ...record };
};

export const limits = async (stores, now = new Date()) => {
  const extra = (await declarations(stores, now))
    .reduce((sum, d) => sum + d.count, 0);

  return {
    hour: thresholds.perHour + extra,
    day: thresholds.perDay + extra,
    declared: extra,
  };
};

// Resend's keys, by name. The list does not say which key is the
// sending one, so RESEND_SENDING_KEY_NAME names it. The audience key
// (full access) is the one that may delete.
const revokeSendingKey = async (env, fetchImpl) => {
  if (!resendAllowed(env)) return { done: false, why: resendRefusal(env) };
  if (!env.RESEND_AUDIENCE_KEY) {
    return { done: false, why: "RESEND_AUDIENCE_KEY is not set" };
  }
  if (!env.RESEND_SENDING_KEY_NAME) {
    return { done: false, why: "RESEND_SENDING_KEY_NAME is not set" };
  }

  const call = (method, path) => timedFetch(fetchImpl, `${API}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${env.RESEND_AUDIENCE_KEY}` },
  }, {
    cap: API_MS,
    name: "Resend",
    fail: (text) => new Error(text),
  });

  try {
    const found = [];
    let after = null;

    for (let page = 0; page < 10; page++) {
      const res = await call("GET",
        `/api-keys?limit=100${after ? `&after=${after}` : ""}`);

      if (!res.ok) return { done: false, why: `listing keys: ${res.status}` };

      const body = await res.json();
      const keys = Array.isArray(body.data) ? body.data : [];

      found.push(...keys.filter((k) => k.name === env.RESEND_SENDING_KEY_NAME));
      if (!body.has_more || !keys.length) break;
      after = keys[keys.length - 1].id;
    }
    if (!found.length) {
      return {
        done: false,
        why: `no key named ${env.RESEND_SENDING_KEY_NAME} in Resend`,
      };
    }
    for (const k of found) {
      const res = await call("DELETE", `/api-keys/${k.id}`);

      if (!res.ok) return { done: false, why: `deleting a key: ${res.status}` };
    }

    return { done: true, deleted: found.length };
  } catch (error) {
    return { done: false, why: String(error) };
  }
};

// The phone, through Healthchecks: a /fail, then a success ping so
// the check can push the next one. Not Resend.
const alertTripped = async (env, fetchImpl, body) => {
  const url = env.HEALTHCHECKS_ALERT_URL;

  if (!url) return false;

  const failed = await ping(url, { ok: false, body, fetchImpl });

  await ping(url, { fetchImpl });

  return failed;
};

// Stop all sending, then do the rest. The flag is written first and
// with `create`, so of two racing trips one acts and sending has
// stopped even if a later step fails.
// -> the state document.
export const trip = async (stores, reason, detail = {}, {
  env = process.env, now = new Date(), fetchImpl = globalThis.fetch,
} = {}) => {
  const state = { tripped: true, at: now.toISOString(), reason, detail };

  if (!(await stores.jobs.create(STATE, state))) {
    return (await readState(stores)) || state;
  }

  log.error({ event: "resend.breaker_tripped", reason, ...detail });

  const key = await revokeSendingKey(env, fetchImpl);
  const alerted = await alertTripped(env, fetchImpl, {
    kind: "resend.breaker",
    reason,
    ...detail,
    keyDeleted: key.done,
    keyNote: key.why || null,
    at: state.at,
  });
  const final = { ...state, key, alerted };

  await stores.jobs.set(STATE, final);
  await stores.jobs.set(`${INCIDENT}${state.at}`, final);

  return final;
};

// Mail refused while tripped is kept to send after the reset.
const hold = async (stores, message, now) => {
  const kept = (await stores.jobs.list(UNSENT)).length;

  if (kept >= thresholds.unsentKeep) {
    log.error({ event: "resend.breaker_unsent_full", kept });

    return false;
  }

  const id = message.idempotencyKey
    ? encodeURIComponent(message.idempotencyKey)
    : `${now.toISOString()}-${randomUUID().slice(0, 8)}`;

  await stores.jobs.set(`${UNSENT}${id}`, { at: now.toISOString(), message });

  return true;
};

// The send path asks before it calls Resend. Reserves the sends it
// allows. Never throws: a store that cannot answer lets the mail go
// (orders need the store too), and says so in the log.
// -> { allowed: true } or { allowed: false, reason }
export const guard = async (stores, message, {
  env = process.env, now = new Date(), fetchImpl = globalThis.fetch,
} = {}) => {
  try {
    const n = recipients(message).length;

    if (await isTripped(stores)) {
      await hold(stores, message, now);

      return { allowed: false, reason: "tripped" };
    }

    const [used, ceiling] = await Promise.all([
      counts(stores, now), limits(stores, now),
    ]);
    const over = used.hour + n > ceiling.hour ? "hour"
      : used.day + n > ceiling.day ? "day" : null;

    if (over) {
      await trip(stores, "volume", {
        window: over, used: used[over], limit: ceiling[over],
      }, { env, now, fetchImpl });
      await hold(stores, message, now);

      return { allowed: false, reason: "volume" };
    }
    for (let i = 0; i < n; i++) {
      await stores.jobs.set(
        `${SENDS}${hourKey(now)}/${now.getTime()}-${randomUUID()}`,
        { n: 1 },
      );
    }

    return { allowed: true };
  } catch (error) {
    log.error({ event: "resend.breaker_unavailable", error: String(error) });

    return { allowed: true };
  }
};

// After Resend accepts a message: its id goes in the ledger. Never
// throws.
export const recordSend = async (stores, id, now = new Date()) => {
  if (!id) return;
  try {
    await stores.jobs.set(`${LEDGER}${id}`, { at: now.toISOString() });
  } catch (error) {
    log.error({ event: "resend.ledger_failed", error: String(error) });
  }
};

// An email.sent from Resend. The webhook can beat the ledger write by
// a moment, so a miss is looked up again before it counts.
export const onSent = async (stores, event, {
  env = process.env, now = new Date(), fetchImpl = globalThis.fetch,
  wait = sleep,
} = {}) => {
  const id = event.data && event.data.email_id;

  if (!id) return { handled: false, reason: "no email id" };

  for (let i = 0; i < thresholds.ledgerTries; i++) {
    const entry = await stores.jobs.get(`${LEDGER}${id}`);

    if (entry) {
      await stores.jobs.set(`${LEDGER}${id}`, {
        ...entry, confirmedAt: now.toISOString(),
      });
      await sweep(stores, now);

      return { handled: true, matched: true };
    }
    if (i < thresholds.ledgerTries - 1) await wait(thresholds.ledgerWaitMs);
  }

  const state = await trip(stores, "foreign", { emailId: id },
    { env, now, fetchImpl });

  return { handled: true, matched: false, tripped: !!state };
};

const EVENT_KINDS = {
  "email.bounced": "bounced",
  "email.complained": "complained",
};

// The rates over the last windowHours.
export const reputation = async (stores, now = new Date()) => {
  const counted = await sinceReset(stores);
  let sent = 0;
  let bounced = 0;
  let complained = 0;

  for (let h = 0; h < thresholds.windowHours; h++) {
    const hk = hourKey(new Date(now.getTime() - h * HOUR));

    sent += await tally(stores, `${SENDS}${hk}/`, counted);
    bounced += (await stores.jobs.list(`${EVENTS}${hk}/bounced-`)).length;
    complained += (await stores.jobs.list(`${EVENTS}${hk}/complained-`))
      .length;
  }

  return { sent, bounced, complained };
};

export const onFeedback = async (stores, event, {
  env = process.env, now = new Date(), fetchImpl = globalThis.fetch,
} = {}) => {
  const kind = EVENT_KINDS[event.type];
  const id = event.data && event.data.email_id;

  if (!kind || !id) return { handled: false, reason: "ignored" };

  await stores.jobs.set(`${EVENTS}${hourKey(now)}/${kind}-${id}`,
    { at: now.toISOString() });

  const seen = await reputation(stores, now);
  const { bounce, complaint } = thresholds;
  const reason = seen.complained >= complaint.count ? "complaints"
    : seen.sent >= bounce.minSends && seen.bounced >= bounce.minBounces
      && seen.bounced / seen.sent >= bounce.rate ? "bounces" : null;

  if (reason) {
    await trip(stores, reason, seen, { env, now, fetchImpl });
  }

  return { handled: true, tripped: !!reason, ...seen };
};

// Old records go, a few at a time, whenever a send is confirmed.
export const sweep = async (stores, now = new Date(), batch = 50) => {
  const cutoff = now.getTime() - thresholds.keepHours * HOUR;
  let removed = 0;

  for (const { key } of await stores.jobs.list(LEDGER)) {
    if (removed >= batch) break;

    const entry = await stores.jobs.get(key);

    if (entry && Date.parse(entry.at) < cutoff) {
      await stores.jobs.delete(key);
      removed += 1;
    }
  }
  for (const prefix of [SENDS, EVENTS]) {
    for (const { key } of await stores.jobs.list(prefix)) {
      if (removed >= batch) break;
      if (Date.parse(`${key.slice(prefix.length, prefix.length + 13)}:00Z`)
        < cutoff) {
        await stores.jobs.delete(key);
        removed += 1;
      }
    }
  }

  return removed;
};

// Everything `bin/nff breaker status` shows.
export const status = async (stores, now = new Date()) => {
  const state = await readState(stores);
  const ledger = await stores.jobs.list(LEDGER);
  const unconfirmed = [];

  for (const { key } of ledger) {
    const entry = await stores.jobs.get(key);

    if (entry && !entry.confirmedAt
      && now.getTime() - Date.parse(entry.at) > 15 * 60 * 1000) {
      unconfirmed.push(key.slice(LEDGER.length));
    }
  }

  return {
    state,
    counts: await counts(stores, now),
    limits: await limits(stores, now),
    declared: await declarations(stores, now),
    reputation: await reputation(stores, now),
    unsent: (await stores.jobs.list(UNSENT)).length,
    unconfirmed,
  };
};

// The incident, as the text for incidents/ (docs/rollback.md).
export const incidentReport = (
  state,
  { by = "bin/nff", now = new Date() } = {},
) =>
  [
    `# Resend send breaker, ${state.at}`,
    "",
    `- Reason: ${state.reason}`,
    `- Detail: ${JSON.stringify(state.detail)}`,
    `- Sending key: ${state.key && state.key.done
      ? `deleted (${state.key.deleted})`
      : `NOT deleted: ${state.key ? state.key.why : "unknown"}`}`,
    `- Phone alert: ${state.alerted ? "accepted by Healthchecks" : "NOT sent"}`,
    `- Reset: ${now.toISOString()} by ${by}`,
    "",
    "What the cause was, and what was done about it:",
    "",
  ].join("\n");

// James's deliberate act, after a new sending key is in Netlify. Sends
// before now stop counting; held mail stays for `flush`.
export const reset = async (stores, { now = new Date() } = {}) => {
  const state = await readState(stores);

  await stores.jobs.set(BASELINE, { at: now.toISOString() });
  await stores.jobs.delete(STATE);

  return { state, unsent: (await stores.jobs.list(UNSENT)).length };
};

// Held mail, sent through `send` (sendMail) now the breaker is clear.
// Mail older than unsentMaxAgeHours is reported, not sent: a sign-in
// link that old is dead.
export const flush = async (stores, send, {
  now = new Date(), dryRun = false,
} = {}) => {
  const out = { sent: 0, stale: 0, failed: 0, held: [] };

  if (await isTripped(stores)) throw new Error("The breaker is still tripped.");

  for (const { key } of await stores.jobs.list(UNSENT)) {
    const held = await stores.jobs.get(key);

    if (!held) continue;
    out.held.push({ key, at: held.at, subject: held.message.subject });
    if (now.getTime() - Date.parse(held.at)
      > thresholds.unsentMaxAgeHours * HOUR) {
      out.stale += 1;
      if (!dryRun) await stores.jobs.delete(key);
      continue;
    }
    if (dryRun) continue;
    try {
      await send(held.message);
      await stores.jobs.delete(key);
      out.sent += 1;
    } catch (error) {
      out.failed += 1;
      log.error({ event: "resend.flush_failed", error: String(error) });
      if (await isTripped(stores)) break;
    }
  }

  return out;
};
