// The yearly secret rotation reminder (docs/secrets.md, "Schedule").
// Every secret rotates between Dec 1 and Jan 1. The jobs email
// DEV_NOTIFICATIONS_EMAIL on Dec 1, then weekly, with what the
// rotation log (docs/rotation-log.md) still shows as not rotated in
// that window. The last reminder, in the last week of December, is
// the loud one.
//
// The log is one line per rotation: name, date, environment, reason,
// who, split by `|` or `,` (a Markdown bullet or table row is fine).
// A line whose second field is not a YYYY-MM-DD date is prose, a
// header or a rule, and is skipped. The prod lane owns the file; this
// only reads it, and a missing file is a log with nothing rotated.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import terms from "../../../data/delivery.json" with { type: "json" };
import {
  parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { devEmails, sendMail } from "./mail.mjs";
import { mailLinks } from "./site.mjs";
import { rotationReminder } from "./templates.mjs";

const tz = terms.timeZone;

// The days of December a reminder is due on, a week apart. The last
// is in the last week of the month and is the final, louder one.
export const REMINDER_DAYS = [1, 8, 15, 22, 29];
export const FINAL_FROM_DAY = 25;
export const REMINDER_HOUR = 8;

const here = dirname(fileURLToPath(import.meta.url));

// Where the deployed function finds the log (netlify.toml
// `included_files`), then where a checkout has it.
const LOG_PATHS = [
  resolve(process.env.LAMBDA_TASK_ROOT || process.cwd(),
    "docs/rotation-log.md"),
  resolve(here, "../../../docs/rotation-log.md"),
];

export const readRotationLog = async (paths = LOG_PATHS) => {
  for (const path of paths) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return null;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// -> [{ name, date, environment, reason, who }]
export const parseRotationLog = (text) => {
  const entries = [];

  for (const line of String(text || "").split("\n")) {
    const body = line
      .replace(/^\s*(?:[-*+]\s+)?/, "")
      .replace(/^\||\|\s*$/g, "");
    const fields = body
      .split(body.includes("|") ? "|" : ",")
      .map((f) => f.replace(/[`*]/g, "").trim());

    if (fields.length < 2 || !ISO.test(fields[1])) continue;

    const [name, date, environment = "", reason = "", ...who] = fields;

    entries.push({ name, date, environment, reason, who: who.join(", ") });
  }

  return entries;
};

// The reminder due on `day` (a YYYY-MM-DD in the farm's zone): the
// latest scheduled day on or before it, or null outside December.
// A missed run is caught up by the next. -> { on, start, final } | null
export const reminderFor = (day) => {
  const [year, month, dom] = day.split("-").map(Number);

  if (month !== 12) return null;

  const slot = Math.max(...REMINDER_DAYS.filter((d) => d <= dom));

  return {
    on: `${year}-12-${String(slot).padStart(2, "0")}`,
    start: `${year}-12-01`,
    final: slot >= FINAL_FROM_DAY,
  };
};

// What the log shows as not yet rotated since `start`: each
// name-and-environment's latest rotation, when it came before the
// window. Oldest first.
export const stillDue = (entries, start) => {
  const latest = new Map();

  for (const e of entries) {
    const key = `${e.name}\u0000${e.environment}`;
    const have = latest.get(key);

    if (!have || e.date > have.date) latest.set(key, e);
  }

  return [...latest.values()]
    .filter((e) => e.date < start)
    .sort((a, b) => a.date.localeCompare(b.date) ||
      a.name.localeCompare(b.name));
};

// Run by the 15-minute jobs. Sends the due reminder once, from 8:00,
// and records it under its scheduled day. After the first, a reminder
// goes only if the log shows something still due. Silent outside December and
// with no address to send to. A mail failure leaves no record, so the
// next run tries again. -> { on, final, due } | null
export const rotationDaily = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
  readLogText = readRotationLog,
} = {}) => {
  const to = devEmails(env);
  const reminder = reminderFor(today(now, tz));

  if (!reminder || !to.length || parts(now, tz).hour < REMINDER_HOUR) {
    return null;
  }

  const key = `rotation/${reminder.on}`;

  if (await stores.jobs.get(key)) return null;

  const text = await readLogText();
  const due = stillDue(parseRotationLog(text), reminder.start);
  const first = reminder.on === reminder.start;

  // Weekly reminders chase only what the log shows still due; a log
  // that shows nothing at all is not proof that all is done.
  if (!first && text !== null && !due.length &&
    parseRotationLog(text).length) {
    await stores.jobs.set(key, { at: now.toISOString(), due: 0 });

    return null;
  }

  try {
    await mail({
      to,
      idempotencyKey: key,
      ...rotationReminder({
        due, start: reminder.start, final: reminder.final,
        logFound: text !== null, links: mailLinks(env),
      }),
    }, { env });
  } catch (error) {
    log.error({
      event: "mail.failed", template: key, error: String(error.message),
    });

    throw error;
  }
  await stores.jobs.set(key, { at: now.toISOString(), due: due.length });

  return { on: reminder.on, final: reminder.final, due: due.length };
};
