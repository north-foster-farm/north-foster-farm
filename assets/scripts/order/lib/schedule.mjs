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
// A line that names a series by its code instead of times decides one
// occurrence of it (data/series.json): `pickup` opens it for orders,
// `attend` means the farm goes and takes none, `skip` that it doesn't
// go. A pickup or attend line may narrow the series' window. No
// occurrence has a default: every in-season date of every series the
// schedule must cover needs its line.
//
//   2026-11-01 K4Q7 pickup
//   2026-11-08 K4Q7 pickup 10:00-12:00
//   2026-11-15 K4Q7 attend
//   2026-11-22 K4Q7 skip
//
// Times are the farm's wall clock (America/New_York), 24-hour.

import { CODE, hasDate, seriesDates } from "./events.mjs";
import { addDays, dayName, today, weekday } from "./zoned.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;
export const ACTIONS = ["pickup", "attend", "skip"];

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

// The raw text -> { windows, lines, errors }. `windows` is sorted by
// date and start, one entry per window: { date, id, from, to }.
// `lines` holds the occurrence lines: { date, code, action } or
// { date, code, action, id, from, to } for a narrower window. Every
// problem is reported, not only the first.
export const parseSchedule = (raw) => {
  const errors = [];
  const windows = [];
  const lines = [];
  const text = typeof raw === "string" ? raw : "";

  if (!text.trim()) {
    return {
      windows, lines, errors: ["PICKUP_SCHEDULE is missing or empty."],
    };
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
    if (!RANGE.test(ranges[0])) {
      const [code, action, ...rest] = ranges;

      if (!CODE.test(code)) {
        errors.push(`${date}: "${code}" is not a time range like ` +
          "09:00-12:00 or a series code.");
      } else if (!ACTIONS.includes(action)) {
        errors.push(`${date} ${code}: say pickup, attend or skip.`);
      } else if (!rest.length) {
        lines.push({ date, code, action });
      } else if (rest.length === 1 && action !== "skip") {
        const w = parseRange(rest[0]);

        if (w.error) {
          errors.push(`${date} ${code}: ${w.error}.`);
        } else {
          lines.push({ date, code, action, ...w });
        }
      } else {
        errors.push(`"${entry}": a pickup or attend line takes at most ` +
          "one window, and a skip line none.");
      }
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

  lines.sort((a, b) => (a.date + a.code < b.date + b.code ? -1 : 1));

  for (let i = 1; i < lines.length; i += 1) {
    const [a, b] = [lines[i - 1], lines[i]];

    if (a.date === b.date && a.code === b.code) {
      errors.push(`${a.date}: ${a.code} has two lines.`);
    }
  }

  return { windows, lines, errors };
};

// This week's Monday, as an ISO date.
const monday = (iso) => addDays(iso, -((weekday(iso) + 6) % 7));

// The first day the schedule must reach: the Monday of the week after
// next.
export const coverUntil = (now, timeZone) =>
  addDays(monday(today(now, timeZone)), 7 * COVER_WEEKS);

const hhmm = (h, m) => Number(h) * 60 + Number(m || 0);

// What is wrong with the occurrence lines, against the series' own
// facts: a known, unarchived series, a date it has, a window within its
// hours. -> [message]
const lineErrors = (lines, model) => {
  const errors = [];

  for (const l of lines) {
    const s = model.seriesOf(l.code);

    if (!s) {
      errors.push(`${l.date}: "${l.code}" is not a series (the series ` +
        `are ${model.series.map((k) => k.code).join(", ")}).`);
      continue;
    }
    if (s.archived) {
      errors.push(`${l.date}: ${l.code} is archived and can't be ` +
        "scheduled.");
      continue;
    }
    if (!hasDate(s, l.date)) {
      errors.push(`${l.date}: ${l.code} (${s.name}) has no occurrence ` +
        `then (its days run ${s.start} to ${s.end || "until further " +
        "notice"}, on ${dayName(s.weekday)}s).`);
      continue;
    }
    if (l.from && (hhmm(...l.from.split(":")) < hhmm(s.opensHour,
      s.opensMinute) || hhmm(...l.to.split(":")) > hhmm(s.closesHour,
      s.closesMinute))) {
      errors.push(`${l.date}: ${l.id} is outside ${l.code}'s hours (${
        s.window}).`);
    }
  }

  return errors;
};

// The days whose occurrences need a line: tomorrow through the later of
// the day before the schedule must reach and the horizon.
export const coverage = (now, timeZone) => {
  const until = addDays(coverUntil(now, timeZone), -1);
  const end = horizon(now, timeZone);

  return {
    first: addDays(today(now, timeZone), 1), last: end > until ? end : until,
  };
};

// Every in-season date of every live series from tomorrow through the
// coverage window needs a line. -> [message]
const missingErrors = (lines, model, now, timeZone) => {
  const { first, last } = coverage(now, timeZone);
  const errors = [];

  for (const s of model.series.filter((x) => !x.archived)) {
    for (const date of seriesDates(s, first, last)) {
      if (!lines.some((l) => l.date === date && l.code === s.code)) {
        errors.push(`${date}: ${s.code} (${s.name}) needs a line: ` +
          `"${date} ${s.code} pickup", attend or skip.`);
      }
    }
  }

  return errors;
};

// Everything a deploy needs of the schedule (amendments 2 and 3): it
// parses, has the right shape, still offers something, and reaches
// into the week after next. -> { ok, windows, errors, last }.
//
// `model` (lib/events.mjs) holds the occurrence lines to the data, and
// requires a line for every occurrence the coverage window holds.
export const checkSchedule = (raw, { now = new Date(), timeZone,
  model } = {}) => {
  const { windows, lines, errors } = parseSchedule(raw);
  const day = today(now, timeZone);
  const last = windows.length ? windows[windows.length - 1].date : null;

  if (!errors.length && !windows.length) {
    errors.push("PICKUP_SCHEDULE has no windows.");
  }
  if (windows.length && !windows.some((w) => w.date > day)) {
    errors.push(`Every window is already past (the last is ${last}).`);
  }

  if (model) {
    errors.push(...lineErrors(lines, model),
      ...missingErrors(lines, model, now, timeZone));
  }

  const until = coverUntil(now, timeZone);

  if (windows.length && last < until) {
    errors.push(`The schedule must reach the week of ${until}; its last ` +
      `window is on ${last}.`);
  }

  return { ok: !errors.length, windows, lines, errors, last };
};

// The last day offered: the Saturday of the week after this one, weeks
// starting on Sunday (James, #267). From Sunday Oct 18 or Wednesday
// Oct 21 that is Oct 31; from Sunday Oct 25 it is Nov 7.
export const horizon = (now, timeZone) => {
  const day = today(now, timeZone);

  return addDays(day, 13 - weekday(day));
};

// The windows a customer can book now: from tomorrow through the
// horizon, booking open until midnight before (W11d-A).
// -> [{ date, windows: [...] }], each date once.
export const bookable = (windows, now, timeZone) => {
  const day = today(now, timeZone);
  const end = horizon(now, timeZone);
  const out = [];

  for (const w of windows) {
    if (w.date <= day || w.date > end) continue;

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
