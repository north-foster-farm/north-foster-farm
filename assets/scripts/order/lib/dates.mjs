// The three date rules, computed at request time. Every function takes
// `now` (a Date) and `terms` (data/delivery.json, with `model` from
// lib/events.mjs added) and returns ISO dates with labels, so the
// browser and the functions cannot disagree. On-farm pickup also takes
// the farm's schedule (lib/schedule.mjs), the parsed windows, which
// alone decides its days and times (W11d); scheduled pickup its
// occurrence lines.

import {
  cutoffOf as eveningBefore, legacyOccurrence, occurrenceOf, offered,
  resolveOccurrence, seriesDates,
} from "./events.mjs";
import { bookable, horizon, windowLabel } from "./schedule.mjs";
import {
  addDays, instant, label, today, weekday,
} from "./zoned.mjs";

const isHoliday = (iso, terms) => terms.holidays.includes(iso);

const entry = (iso, extra = {}) => ({ date: iso, label: label(iso), ...extra });

// Every day in the schedule from tomorrow on, each with its windows
// (W11d). No weekday, holiday or horizon rule: a day is offered if the
// schedule has it.
export const onFarmDates = (now, terms, schedule = []) =>
  bookable(schedule, now, terms.timeZone).map(({ date, windows }) =>
    entry(date, {
      windows: windows.map((w) => ({ ...w, label: windowLabel(w) })),
    }));

// The Wednesday-noon cutoff that governs a delivery Thursday.
export const cutoffFor = (iso, terms) => {
  const { cutoffHour, weekday: day, cutoffWeekday } = terms.delivery;
  const back = (day - cutoffWeekday + 7) % 7;

  return instant(addDays(iso, -back), cutoffHour, 0, terms.timeZone);
};

// How far ahead a buying group's next round is looked for: its
// series runs every other week, so well within this.
const ROUND_AHEAD = 60;

// Every occurrence the schedule has a line for, from today through
// the horizon, with its line's action: [{ occurrence, action }], by
// date and then opening time. An occurrence with no line is not
// offered, and is left out here. An archived series never appears,
// and a buying group's series (#471) only when `terms.groups` names
// its group. A group's rounds are open unless the schedule says
// otherwise, so no line is needed to run one, and its next round is
// open whatever the horizon, one round at a time: orders gather for
// it until it closes (James, 6424212209), and the one after opens
// then.
export const scheduledLines = (now, terms, schedule = []) => {
  const { model } = terms;
  const first = today(now, terms.timeZone);
  const last = horizon(now, terms.timeZone);
  const lines = schedule.lines || [];
  const out = [];

  for (const s of offered(model, terms.groups || [])) {
    // A round today closed last night, so the next is tomorrow's on.
    const dates = s.group
      ? seriesDates(s, addDays(first, 1), addDays(first, ROUND_AHEAD))
        .slice(0, 1)
      : seriesDates(s, first, last);

    for (const date of dates) {
      const line = lines.find((l) => l.date === date && l.code === s.code)
        || (s.group ? { action: "pickup" } : null);

      if (!line) continue;

      const occurrence = occurrenceOf(model, s, date, line);

      if (!occurrence.archived) {
        out.push({ occurrence, action: line.action });
      }
    }
  }

  return out.sort((a, b) => a.occurrence.date.localeCompare(b.occurrence.date)
    || a.occurrence.opens.localeCompare(b.occurrence.opens));
};

// What a customer reads of an occurrence: where, and when it hands
// over.
const read = (o, extra = {}) => entry(o.date, {
  occurrence: o.id,
  series: o.series,
  name: o.name,
  location: o.location,
  town: o.town,
  place: o.place,
  short: o.short,
  window: o.window,
  ...extra,
});

// The occurrences open for pickup: from tomorrow through the horizon,
// by date and then start time, whose cutoff (11:59 PM the day before)
// has not passed. No minimum, no fee.
export const scheduledDates = (now, terms, schedule = []) =>
  scheduledLines(now, terms, schedule)
    .filter(({ action }) => action === "pickup")
    .map(({ occurrence: o }) => ({
      o, cutoff: eveningBefore(o.date, terms.timeZone),
    }))
    .filter(({ cutoff }) => now.getTime() <= cutoff.getTime())
    .map(({ o, cutoff }) => read(o, { cutoff: cutoff.toISOString() }));

// Every occurrence the farm attends (pickup or attend) in the same
// stretch, with its status, for the home page and the map. Skipped
// ones are left out.
export const eventDates = (now, terms, schedule = []) =>
  scheduledLines(now, terms, schedule)
    .filter(({ action }) => action !== "skip")
    .map(({ occurrence: o, action }) => read(o, {
      kind: o.kind,
      status: action,
      lat: o.lat,
      lng: o.lng,
      ...o.href && { href: o.href },
    }));

// The farm's own booking: any live occurrence of a series, whatever
// the schedule says, in the next 400 days (or the first `count`).
export const farmScheduledDates = (now, terms, count = Infinity) => {
  const first = today(now, terms.timeZone);
  const last = addDays(first, 400);
  const out = [];

  for (const s of terms.model.series.filter((x) => !x.archived)) {
    for (const date of seriesDates(s, first, last)) {
      const o = occurrenceOf(terms.model, s, date);

      if (!o.archived) {
        out.push(read(o, {
          cutoff: eveningBefore(date, terms.timeZone).toISOString(),
        }));
      }
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date)
    || a.window.localeCompare(b.window)).slice(0, count);
};

// An occurrence by id, however old (the farm's change to a past order
// reaches it), or null. An archived one resolves too.
export const occurrenceFor = (terms, id) =>
  resolveOccurrence(terms.model, id);

// Whether an order's fulfilment is a scheduled pickup, in the model's
// shape or in the Stage 1 shape (`scituate`, or `market` and a site)
// that the migration has not yet rewritten.
export const isScheduled = (f) => Boolean(f)
  && ["scheduled", "scituate", "market"].includes(f.method);

// A fulfilment in the model's shape: a Stage 1 scheduled pickup
// (`scituate`, or `market` and a site) read as `scheduled` and the
// occurrence it means; anything else as it is.
export const modelled = (terms, f) => {
  if (!f || !isScheduled(f) || f.method === "scheduled") return f;

  const { site, ...rest } = f;
  const id = legacyOccurrence(terms.model, f.method, site, f.date);

  return { ...rest, method: "scheduled", ...id && { occurrence: id } };
};

// The occurrence an order's fulfilment names, either shape, or null
// when it names none or the one it names no longer resolves.
export const orderOccurrence = (terms, f) => {
  if (!isScheduled(f)) return null;

  const id = f.method === "scheduled" ? f.occurrence
    : legacyOccurrence(terms.model, f.method, f.site, f.date);

  return id ? occurrenceFor(terms, id) : null;
};

// The next delivery Thursdays whose cutoff has not passed. The cutoff
// itself is inclusive: an order at exactly 12:00:00 still makes it.
export const deliveryDates = (now, terms, count) => {
  const wanted = count || terms.delivery.datesToOffer;
  const start = today(now, terms.timeZone);
  const out = [];

  for (let d = addDays(start, 1), i = 0; out.length < wanted && i < 60; i++) {
    if (weekday(d) === terms.delivery.weekday && !isHoliday(d, terms)) {
      const cutoff = cutoffFor(d, terms);

      if (now.getTime() <= cutoff.getTime()) {
        out.push(entry(d, { cutoff: cutoff.toISOString() }));
      }
    }

    d = addDays(d, 1);
  }

  return out;
};

export const allDates = (now, terms, schedule) => ({
  now: now.toISOString(),
  onfarm: onFarmDates(now, terms, schedule),
  delivery: deliveryDates(now, terms),
  scheduled: scheduledDates(now, terms, schedule),
});

// The dates a way of getting the order offers. `all` lists every live
// occurrence, not just the schedule's: the farm's own booking.
export const datesFor = (method, now, terms, schedule, all) => {
  if (method === "scheduled" && all) {
    return farmScheduledDates(now, terms);
  }

  return allDates(now, terms, schedule)[method] || [];
};
