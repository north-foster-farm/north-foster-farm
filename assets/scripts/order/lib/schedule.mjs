// The farm's pickup schedule (W11d): the on-farm windows it offers,
// set by James in the PICKUP_SCHEDULE environment variable and read
// on every request. There is no default: a missing or broken schedule
// fails the deploy (check:schedule) before a customer can meet it.
//
// The format, one window per entry; entries are separated by new
// lines, commas or semicolons, and a date can carry several windows:
//
//   2026-10-06 09:00-12:00 13:00-17:00
//   2026-10-07 09:00-12:00
//   # a comment, and blank lines, are ignored
//
// Times are the farm's wall clock (America/New_York), 24-hour.

import { addDays, today, weekday } from "./zoned.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

// How far ahead the schedule must reach: into the week after next,
// counted from this week's Monday (James, amendment 3).
export const COVER_WEEKS = 2;

const realDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1
    && date.getUTCDate() === d;
};

const minutes = (h, m) => Number(h) * 60 + Number(m);

// "09:00-12:00" -> { id, from, to }, or a reason it is not a window.
const parseRange = (text) => {
  const m = RANGE.exec(text);

  if (!m) return { error: `"${text}" is not a time range like 09:00-12:00` };

  const [, fh, fm, th, tm] = m;

  if (Number(fh) > 23 || Number(th) > 23 || Number(fm) > 59
    || Number(tm) > 59) {
    return { error: `"${text}" has a time that doesn't exist` };
  }
  if (minutes(th, tm) <= minutes(fh, fm)) {
    return { error: `"${text}" ends before it starts` };
  }

  return { id: text, from: `${fh}:${fm}`, to: `${th}:${tm}` };
};

// The raw text -> { windows, errors }. `windows` is sorted by date and
// start, one entry per window: { date, id, from, to }. Every problem
// is reported, not only the first.
export const parseSchedule = (raw) => {
  const errors = [];
  const windows = [];
  const text = typeof raw === "string" ? raw : "";

  if (!text.trim()) {
    return { windows, errors: ["PICKUP_SCHEDULE is missing or empty."] };
  }

  const entries = text.split(/\n/)
    .map((line) => line.replace(/#.*/, ""))
    .flatMap((line) => line.split(/[,;]/))
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [date, ...ranges] = entry.split(/\s+/);

    if (!DATE.test(date) || !realDate(date)) {
      errors.push(`"${entry}": "${date}" is not a date like 2026-10-06.`);
      continue;
    }
    if (!ranges.length) {
      errors.push(`"${entry}": give the date at least one time range.`);
      continue;
    }
    for (const range of ranges) {
      const w = parseRange(range);

      if (w.error) {
        errors.push(`${date}: ${w.error}.`);
      } else {
        windows.push({ date, ...w });
      }
    }
  }

  windows.sort((a, b) => (a.date + a.from < b.date + b.from ? -1 : 1));

  for (let i = 1; i < windows.length; i += 1) {
    const a = windows[i - 1];
    const b = windows[i];

    if (a.date === b.date && b.from < a.to) {
      errors.push(`${a.date}: ${a.id} and ${b.id} overlap.`);
    }
  }

  return { windows, errors };
};

// This week's Monday, as an ISO date.
const monday = (iso) => addDays(iso, -((weekday(iso) + 6) % 7));

// The first day the schedule must reach: the Monday of the week after
// next.
export const coverUntil = (now, timeZone) =>
  addDays(monday(today(now, timeZone)), 7 * COVER_WEEKS);

// Everything a deploy needs of the schedule (amendments 2 and 3): it
// parses, has the right shape, still offers something, and reaches
// into the week after next. -> { ok, windows, errors, last }.
export const checkSchedule = (raw, { now = new Date(), timeZone }) => {
  const { windows, errors } = parseSchedule(raw);
  const day = today(now, timeZone);
  const last = windows.length ? windows[windows.length - 1].date : null;

  if (!errors.length && !windows.length) {
    errors.push("PICKUP_SCHEDULE has no windows.");
  }
  if (windows.length && !windows.some((w) => w.date > day)) {
    errors.push(`Every window is already past (the last is ${last}).`);
  }

  const until = coverUntil(now, timeZone);

  if (windows.length && last < until) {
    errors.push(`The schedule must reach the week of ${until}; its last ` +
      `window is on ${last}.`);
  }

  return { ok: !errors.length, windows, errors, last };
};

// The windows a customer can book now: from tomorrow on, booking open
// until midnight before (W11d-A). -> [{ date, windows: [...] }], each
// date once.
export const bookable = (windows, now, timeZone) => {
  const day = today(now, timeZone);
  const out = [];

  for (const w of windows) {
    if (w.date <= day) continue;

    const last = out[out.length - 1];
    const entry = { id: w.id, from: w.from, to: w.to };

    if (last && last.date === w.date) {
      last.windows.push(entry);
    } else {
      out.push({ date: w.date, windows: [entry] });
    }
  }

  return out;
};

// Before W11d a pickup named one of two fixed windows; their times,
// for the records made then.
const LEGACY = {
  morning: { from: "09:00", to: "12:00" },
  afternoon: { from: "13:00", to: "17:00" },
};

// An order's pickup window as { from, to }, however old the record: its
// own times, else its id ("09:00-12:00"), else the fixed pair's.
export const pickupTimes = (onfarm) => {
  const o = onfarm || {};
  const id = RANGE.exec(o.window || "");

  if (o.from && o.to) return { from: o.from, to: o.to };
  if (id) return { from: `${id[1]}:${id[2]}`, to: `${id[3]}:${id[4]}` };

  return LEGACY[o.window] || null;
};

// "9 AM – noon", "1 – 5 PM", "11:30 AM – 1 PM": a window for people.
export const windowLabel = ({ from, to }) => {
  const clock = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);

    if (h === 12 && m === 0) return { text: "noon", half: "" };
    if (h === 0 && m === 0) return { text: "midnight", half: "" };

    const hour = ((h + 11) % 12) + 1;

    return {
      text: m ? `${hour}:${String(m).padStart(2, "0")}` : `${hour}`,
      half: h < 12 ? "AM" : "PM",
    };
  };
  const a = clock(from);
  const b = clock(to);
  const start = a.half && a.half !== b.half ? `${a.text} ${a.half}`
    : a.text;
  const end = b.half ? `${b.text} ${b.half}` : b.text;

  return `${start} – ${end}`;
};
