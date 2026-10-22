// Scheduled pickup locations beyond the drop site: the markets and
// pop-ups of data/markets.json that carry a `pickup` block. Their
// place, hours and season are the entry's own (the one source for
// them); the block adds only what ordering needs: an `id`, whether
// `customers` may choose it yet, the cutoff and the dates to offer.

import { dayName } from "./zoned.mjs";

const DAYS = [0, 1, 2, 3, 4, 5, 6].map(dayName);

// "Sundays, 9:00 AM – 1:00 PM" -> { weekday: 0, window: "9:00 AM – 1:00 PM",
// opensHour: 9, opensMinute: 0 }. A window that names AM or PM once
// ("4:00 – 7:00 PM") gives it to its start too.
const hoursOf = (when) => {
  const [days, window] = String(when).split(/,\s*/);
  const weekday = DAYS.findIndex((d) => days.startsWith(d));
  const [, hour, minute = "", half] = String(window)
    .match(/^(\d{1,2})(?::(\d\d))?\s*(AM|PM)?/) || [];
  const [, closing] = String(window).match(/(AM|PM)\s*$/) || [];
  const meridiem = half || closing;
  const afternoon = meridiem === "PM" && Number(hour) < 12;

  return {
    weekday, window, opensHour: Number(hour) + (afternoon ? 12 : 0),
    opensMinute: Number(minute) || 0,
  };
};

// The pickup sites among data/markets.json's entries, shaped as the
// drop site is (`terms.scituate`), so one set of date rules serves all.
export const pickupSites = (markets = []) => markets
  .filter((m) => m.pickup && m.pickup.id)
  .map((m) => {
    const { weekday, window, opensHour, opensMinute } = hoursOf(m.when);
    const { id, customers = false, cutoffDaysBefore = 1,
      cutoffHour = 24, datesToOffer = 2 } = m.pickup;

    return {
      id,
      name: m.name,
      customers,
      start: m.opens,
      end: m.closes,
      weekday,
      cutoffWeekday: (weekday - cutoffDaysBefore + 7) % 7,
      cutoffHour,
      opensHour,
      opensMinute,
      window,
      location: `${m.name}, ${m.where}`,
      short: m.where,
      datesToOffer,
    };
  });
