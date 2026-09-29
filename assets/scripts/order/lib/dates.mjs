// The three date rules, computed at request time. Every function takes
// `now` (a Date) and `terms` (data/delivery.json) and returns ISO dates
// with labels, so the browser and the functions cannot disagree. On-farm
// pickup also takes the farm's schedule (lib/schedule.mjs), the parsed
// windows, which alone decides its days and times (W11d).

import { bookable, windowLabel } from "./schedule.mjs";
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

// The last moment to order for a day: its `cutoffHour` on the
// `cutoffWeekday` at or before it. Hour 24 is the end of that day.
const cutoffOf = (iso, rules, timeZone) => {
  const { cutoffHour, weekday: day, cutoffWeekday } = rules;
  const back = (day - cutoffWeekday + 7) % 7;

  return instant(addDays(iso, -back), cutoffHour, 0, timeZone);
};

// The Wednesday-noon cutoff that governs a delivery Thursday.
export const cutoffFor = (iso, terms) =>
  cutoffOf(iso, terms.delivery, terms.timeZone);

// The drop site's cutoff for its Saturday: the end of Friday.
export const dropCutoffFor = (iso, terms) =>
  cutoffOf(iso, terms.scituate, terms.timeZone);

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

// The next Scituate Saturdays on or after the published start whose
// cutoff has not passed (inclusive, as for delivery).
export const scituateDates = (now, terms, count) => {
  const wanted = count || terms.scituate.datesToOffer;
  const { start, weekday: dropDay } = terms.scituate;
  const current = today(now, terms.timeZone);
  const out = [];
  let d = current > start ? current : start;

  for (let i = 0; out.length < wanted && i < 120; i++) {
    if (weekday(d) === dropDay && !isHoliday(d, terms)) {
      const cutoff = dropCutoffFor(d, terms);

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
  scituate: scituateDates(now, terms),
  delivery: deliveryDates(now, terms),
});

export const datesFor = (method, now, terms, schedule) =>
  allDates(now, terms, schedule)[method] || [];
