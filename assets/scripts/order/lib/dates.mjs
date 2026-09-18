// The three date rules, computed at request time. Every function takes
// `now` (a Date) and `terms` (data/delivery.json) and returns ISO dates
// with labels, so the browser and the functions cannot disagree.

import {
  addDays, instant, label, today, weekday,
} from "./zoned.mjs";

const isHoliday = (iso, terms) => terms.holidays.includes(iso);

const entry = (iso, extra = {}) => ({ date: iso, label: label(iso), ...extra });

// Every non-holiday weekday from tomorrow through the Friday of next
// week.
export const onFarmDates = (now, terms) => {
  const start = addDays(today(now, terms.timeZone), 1);
  let friday = today(now, terms.timeZone);

  while (weekday(friday) !== 5) friday = addDays(friday, 1);

  const end = addDays(friday, 7);
  const out = [];

  for (let d = start; d <= end; d = addDays(d, 1)) {
    const w = weekday(d);

    if (w >= 1 && w <= 5 && !isHoliday(d, terms)) out.push(entry(d));
  }

  return out;
};

// The Wednesday-noon cutoff that governs a delivery Thursday.
export const cutoffFor = (iso, terms) => {
  const { cutoffHour, weekday: deliveryDay, cutoffWeekday } = terms.delivery;
  const back = (deliveryDay - cutoffWeekday + 7) % 7;

  return instant(addDays(iso, -back), cutoffHour, 0, terms.timeZone);
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

// The next Scituate Saturdays on or after the published start. The
// current Saturday is still offered until its window opens.
export const scituateDates = (now, terms, count) => {
  const wanted = count || terms.scituate.datesToOffer;
  const { start, weekday: dropDay } = terms.scituate;
  const current = today(now, terms.timeZone);
  const out = [];
  let d = current > start ? current : start;

  for (let i = 0; out.length < wanted && i < 120; i++) {
    if (weekday(d) === dropDay && !isHoliday(d, terms)) {
      const opens = instant(d, terms.scituate.opensHour, 0, terms.timeZone);

      if (d > current || now.getTime() < opens.getTime()) out.push(entry(d));
    }

    d = addDays(d, 1);
  }

  return out;
};

export const allDates = (now, terms) => ({
  now: now.toISOString(),
  onfarm: onFarmDates(now, terms),
  scituate: scituateDates(now, terms),
  delivery: deliveryDates(now, terms),
});

export const datesFor = (method, now, terms) =>
  allDates(now, terms)[method] || [];
