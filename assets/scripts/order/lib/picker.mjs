// The pickup picker's choosing logic (#540, kept by the timetable of
// #573): which pickup a list lands on, the notes about it, the booked
// pickup of an order being changed, and the words the live region and
// the summary say. lib/timetable.mjs lays the board out, and the
// picker itself (order/pickup-picker.js) draws both, on the order
// page, in the lapsed dialog and in the account's Change pickup. Weeks
// run Sunday to Saturday. Every entry is a scheduled choice
// (lib/scheduled.mjs): an /api/dates `scheduled` entry with its
// `value`, the occurrence id.

import { addressLines, fallbackChoice, pickupName } from "./scheduled.mjs";
import { addDays, label, today, weekday } from "./zoned.mjs";

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

// A window as it is said, "10:00 to 11:00 AM".
export const spokenWindow = (window) => String(window || "")
  .replaceAll(" – ", " to ");

// The live region's line when a pickup is chosen: "Pickup chosen:
// Saturday, November 21, 10:00 to 11:00 AM, North Scituate, Drop
// site". A screen reader says "·" differently or not at all, so a
// comma. `loc` is the entry's location, for its town.
export const chosenText = (entry, loc = null) => `Pickup chosen: ${[
  entry.label,
  spokenWindow(entry.window),
  pickupName(entry.town || (loc || {}).town, entry.name)
    .replaceAll(" · ", ", "),
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

// The summary's last line: "Order by Friday, November 20, 11:59 PM",
// from the entry's `cutoff` in the farm's zone. "" without one.
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

// A place's address, as the timetable's row head shows it: the
// location's lines when the page has its location
// (data/locations.json), else the entry's own short address, a part
// to each line.
export const addressOf = (entry, loc) => {
  if (loc) return addressLines(loc);
  if (entry.short) return entry.short.split(", ");

  const parts = String(entry.place || "").split(", ").filter(Boolean);

  return parts[0] === entry.name ? parts.slice(1) : parts;
};

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

// The pickup to show struck on the board as "Closed" after a list is
// drawn again: the one chosen before, when it is the pickup the closed
// note is about and the page still knows it. null otherwise. It is
// never a radio, so it can't be chosen or sent; the next list drops it
// (#573, the timetable's moment 4).
export const closedEntry = ({ pick, before, known }) => {
  if (pick.note !== CLOSED || !before || !known) return null;

  return { ...known, value: before, closed: true, booked: false };
};
