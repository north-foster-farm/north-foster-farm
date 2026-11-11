// The pickup-day picker's logic (#540, the design approved on #539):
// the week strip, its words, and which pickup a list lands on. The
// picker itself (order/pickup-picker.js) draws what this works out,
// on the order page, in the lapsed dialog and in the account's Change
// pickup. Weeks run Sunday to Saturday. Every entry is a scheduled
// choice (lib/scheduled.mjs): an /api/dates `scheduled` entry with its
// `value`, the occurrence id.

import {
  addressLines, fallbackChoice, locationCount, pickupName,
} from "./scheduled.mjs";
import { addDays, label, today, weekday } from "./zoned.mjs";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const month = {
  long: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" }),
  short: new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short",
  }),
};

const utc = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);

  return Date.UTC(y, m - 1, d);
};

const dayOf = (iso) => Number(iso.slice(8, 10));

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The words comms approved on #539 (comment 6793394356). Drafts until
// James signs off on the built picker.
export const CLOSED = "That pickup is no longer available. " +
  "Please choose another.";
export const NONE = "No pickup days are open right now.";
// The order page's error for no pickup chosen (lib/validate.mjs), also
// the account's Change pickup's and the lapsed dialog's.
export const CHOOSE = "Choose a pickup day and place.";

// The Sunday that starts the week a day is in.
export const weekStart = (iso) => addDays(iso, -weekday(iso));

// The weeks a list reaches, Sunday to Saturday, each with its seven
// days and the entries on each, in the list's order. Only weeks with
// a pickup are there, so paging skips an empty week between this one
// and a buying group's round further out. A day is `open` when it has
// a pickup; a day before today never has one.
export const pickerWeeks = (list) => {
  const days = new Map();

  for (const entry of list || []) {
    if (!days.has(entry.date)) days.set(entry.date, []);
    days.get(entry.date).push(entry);
  }

  const starts = [...new Set([...days.keys()].map(weekStart))].sort();

  return starts.map((start) => ({
    start,
    end: addDays(start, 6),
    days: WEEKDAYS.map((_, i) => {
      const date = addDays(start, i);
      const entries = days.get(date) || [];

      return {
        date, weekday: WEEKDAYS[i], number: dayOf(date), entries,
        open: entries.length > 0,
      };
    }),
  }));
};

// The week a day falls in, as an index into `weeks`; the first week
// when the day is not in any, or none is given.
export const weekIndex = (weeks, date) => {
  if (!date) return 0;

  const i = weeks.findIndex((w) => w.start === weekStart(date));

  return i < 0 ? 0 : i;
};

// A week's dates: "November 15 – 21", "November 29 – December 5", or
// on a phone "Nov 29 – Dec 5". Spoken, the dash is "to".
export const rangeText = (start, { short = false, spoken = false } = {}) => {
  const end = addDays(start, 6);
  const names = short ? month.short : month.long;
  const from = names.format(utc(start));
  const to = names.format(utc(end));
  const tail = from === to ? dayOf(end) : `${to} ${dayOf(end)}`;

  return `${from} ${dayOf(start)}${spoken ? " to " : " – "}${tail}`;
};

// "This week" or "Next week" by the week today is in; "" for a week
// after next, which is titled by its dates alone.
export const weekName = (start, todayIso) => {
  const now = weekStart(todayIso);

  if (start === now) return "This week";
  if (start === addDays(now, 7)) return "Next week";

  return "";
};

// The title between the arrows: "This week, November 15 – 21",
// "November 29 – December 5".
export const weekTitle = (start, todayIso, options = {}) => {
  const name = weekName(start, todayIso);
  const range = rangeText(start, options);

  return name ? `${name}, ${range}` : range;
};

// A week button's name in full: "Next week, November 22 to 28".
export const pagerLabel = (direction, start) => `${
  direction > 0 ? "Next" : "Previous"} week, ${
  rangeText(start, { spoken: true })}`;

// What the live region says after paging: "Next week, November 22 to
// 28, 3 pickup days".
export const pagedText = (week, todayIso) => `${
  weekTitle(week.start, todayIso, { spoken: true })}, ${
  plural(week.days.filter((d) => d.open).length, "pickup day")}`;

// A day's availability line: "1 pickup", "2 pickups", or "–".
export const availability = (n) => (n ? plural(n, "pickup") : "–");

// A day's name for a screen reader: "Saturday, November 21, 2
// pickups", or "Sunday, November 15, no pickups" for a greyed day.
export const dayLabel = (day) => `${label(day.date)}, ${
  day.entries.length ? availability(day.entries.length) : "no pickups"}`;

// A window as it is said, "10:00 to 11:00 AM".
export const spokenWindow = (window) => String(window || "")
  .replaceAll(" – ", " to ");

// The live region's line when choosing a day chooses its one pickup:
// "Pickup chosen: 10:00 to 11:00 AM, North Scituate, Drop site". A
// screen reader says "·" differently or not at all, so a comma.
export const chosenText = (entry) => `Pickup chosen: ${[
  spokenWindow(entry.window),
  pickupName(entry.town, entry.name).replaceAll(" · ", ", "),
].filter(Boolean).join(", ")}`;

const timeFormatters = new Map();

const clock = (date, timeZone) => {
  if (!timeFormatters.has(timeZone)) {
    timeFormatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", hour12: true,
    }));
  }

  // Newer ICU puts a narrow no-break space before AM and PM.
  return timeFormatters.get(timeZone).format(date).replace(/\s/g, " ");
};

// The details panel's last line: "Order by Friday, November 20, 11:59
// PM", from the entry's `cutoff` in the farm's zone. "" without one.
export const orderBy = (cutoff, timeZone) => {
  if (!cutoff) return "";

  const at = new Date(cutoff);

  return `Order by ${label(today(at, timeZone))}, ${clock(at, timeZone)}`;
};

// An occurrence id's date, "K4Q7-261121" -> "2026-11-21"; "" when the
// id carries none.
export const occurrenceDate = (id) => {
  const found = /-(\d{2})(\d{2})(\d{2})$/.exec(String(id || ""));

  return found ? `20${found[1]}-${found[2]}-${found[3]}` : "";
};

// The note when a draft's pickup has closed and the picker chose the
// series' next: it names both dates.
export const movedNote = (wanted, next) => {
  const was = occurrenceDate(wanted);

  return `Your saved pickup${was ? ` on ${label(was)}` : ""} is no ` +
    `longer available, so we chose the next one, on ${next.label}.`;
};

// Which pickup a list lands on, and the note above it. `want` is a
// draft's or a link's occurrence, `current` the one chosen before the
// list changed; `series` is the old drop site draft's, whose closed
// date falls to the series' next (lapsed or not, never another
// place's); `booked` is the pickup an order being changed holds,
// offered "As booked" when the list no longer has it. `quiet` keeps
// the closed note back for a pickup the list may yet gain (a buying
// group's round, before its code is checked). -> { value, note,
// booked }, `booked` true when the choice is the booked one.
export const resolveChoice = ({
  list, current = "", want = "", series = "", booked = null, quiet = false,
}) => {
  const wanted = want || current;
  const none = { value: "", note: "", booked: false };

  if (!wanted) return none;
  if (list.some((d) => d.value === wanted)) {
    return { ...none, value: wanted };
  }
  if (booked && booked.value === wanted) {
    return { ...none, value: wanted, booked: true };
  }
  if (series) {
    const next = fallbackChoice(list, series);

    if (next) {
      return { ...none, value: next.value, note: movedNote(wanted, next) };
    }
  }

  return { ...none, note: quiet || !list.length ? "" : CLOSED };
};

// The list with the booked pickup in its place by date, for the card
// marked "As booked".
export const withBooked = (list, booked) => {
  const out = list.filter((d) => d.value !== booked.value);
  const at = out.findIndex((d) => d.date > booked.date);

  out.splice(at < 0 ? out.length : at, 0, booked);

  return out;
};

// The pickup an order being changed holds, as an entry the picker can
// show "As booked": from the order's derived pickup (#316), which has
// its name, place and window but no cutoff. null for an order that is
// not a scheduled pickup.
export const bookedEntry = (order) => {
  const p = order && order.pickup;
  const date = order && order.fulfilment && order.fulfilment.date;

  if (!p || !p.occurrence || !date) return null;

  return {
    value: p.occurrence, occurrence: p.occurrence, date, label: label(date),
    window: p.gone ? "" : p.window || "", name: p.gone ? "" : p.name || "",
    town: "", place: p.place || "", short: "", series: p.series || "",
    booked: true,
  };
};

// The address the details panel shows: the location's lines when the
// page has its location (data/locations.json), else the entry's own
// short address, a line to each part.
export const addressOf = (entry, loc) => {
  if (loc) return addressLines(loc);
  if (entry.short) return entry.short.split(", ");

  const parts = String(entry.place || "").split(", ").filter(Boolean);

  return parts[0] === entry.name ? parts.slice(1) : parts;
};

// The details panel for a pickup: its name, the address and the
// order-by line.
export const detailsOf = (entry, loc, timeZone) => ({
  name: pickupName(entry.town || (loc || {}).town, entry.name),
  address: addressOf(entry, loc),
  orderBy: orderBy(entry.cutoff, timeZone),
});

// The earliest cutoff in a list, as epoch milliseconds, for the timer
// that refreshes the lists when that pickup closes; null when none has
// one.
export const earliestCutoff = (list) => {
  const times = (list || []).map((d) => Date.parse(d.cutoff))
    .filter(Number.isFinite);

  return times.length ? Math.min(...times) : null;
};

// The entries still open at `now` (epoch milliseconds): those whose
// cutoff is later, and those with none. A buying group's rounds come
// once from /api/group and are joined to every list after, so a round
// that closes with the page open is dropped here; kept, its passed
// cutoff would stay the earliest and the lists would refresh about
// once a second (#540).
export const stillOpen = (list, now) => (list || []).filter((d) => {
  const at = Date.parse(d.cutoff);

  return !Number.isFinite(at) || at > now;
});

// The note to show after a list is drawn again. A refresh (the cutoff
// timer, a retry) brings no draft or link, so the note that said why
// nothing, or another pickup, is chosen would be lost: it stays while
// the choice is the one it was about and the list has pickups. `shown`
// is the note on the picker before, `before` the choice then.
export const keptNote = ({ pick, before, shown, some }) => {
  if (pick.note) return pick.note;

  return some && pick.value === before ? shown : "";
};

// Whether every pickup is at one place, so the cards leave the place
// to the details panel.
export const onePlace = (list) => locationCount(list) <= 1;
