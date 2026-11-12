// The pickup picker as a timetable (#573, Round 2 of the picker
// bracket on #540): one row per place and routine, one column per
// week, and every open pickup one tap. This works out what the board
// holds; order/pickup-picker.js draws it on the order page, in the
// lapsed dialog and in the account's Change pickup. Which pickup is
// chosen, and the notes about it, stay with lib/picker.mjs.
//
// Every entry is a scheduled choice (lib/scheduled.mjs). An entry may
// carry `booked` (the pickup an order being changed holds, shown "As
// booked"), `closed` (the pickup that just closed, shown struck and
// never chosen) and `round` (a buying group's round, lib/group.mjs).

import { addressOf, orderBy, spokenWindow, weekStart } from "./picker.mjs";
import { pickupName } from "./scheduled.mjs";
import { addDays, dayName, label, weekday } from "./zoned.mjs";

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
  "Nov", "Dec",
];

const dayOf = (iso) => Number(iso.slice(8, 10));
const monthOf = (iso) => SHORT_MONTHS[Number(iso.slice(5, 7)) - 1];

// "Nov 8 – 14", "Nov 29 – Dec 5": a week's dates under its column's
// name.
export const weekRange = (start) => {
  const end = addDays(start, 6);
  const tail = monthOf(start) === monthOf(end) ? dayOf(end)
    : `${monthOf(end)} ${dayOf(end)}`;

  return `${monthOf(start)} ${dayOf(start)} – ${tail}`;
};

// The columns, in the order they stand. "booked" holds only a booked
// pickup from before this week (an order changed after its day went
// by); "later" anything past next week, such as a buying group's
// round.
export const COLUMNS = ["booked", "this", "next", "later"];

// Draft wording (#573).
export const COLUMN_NAMES = {
  booked: "Booked", this: "This week", next: "Next week", later: "Later",
};

// Which column a day falls in, by the week today is in. Weeks run
// Sunday to Saturday, as the farm's horizon does (lib/schedule.mjs).
export const columnOf = (date, todayIso) => {
  const now = weekStart(todayIso);

  if (date < now) return "booked";
  if (date < addDays(now, 7)) return "this";
  if (date < addDays(now, 14)) return "next";

  return "later";
};

// The columns a list needs: only those with a pickup in them, each
// with its name and, for this week and next, its dates. An empty
// column is never drawn, so "Later" comes only with a round out there.
export const boardColumns = (list, todayIso) => {
  const used = new Set((list || []).map((d) => columnOf(d.date, todayIso)));
  const now = weekStart(todayIso);
  const starts = { this: now, next: addDays(now, 7) };

  return COLUMNS.filter((key) => used.has(key)).map((key) => ({
    key,
    name: COLUMN_NAMES[key],
    range: starts[key] ? weekRange(starts[key]) : "",
  }));
};

const join = (words) => (words.length > 2
  ? `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`
  : words.join(" and "));

// A routine as the farm says it: "Saturdays, 10:00 – 11:00 AM" when
// the board shows it more than once on that weekday, "Saturday, 12:00
// – 5:00 PM" for a single date, and "Tuesdays and Saturdays, ..." for
// a routine on two weekdays. Only the dates on the board count, so a
// market with one date left in the horizon reads in the singular.
export const routineText = (dates, window = "") => {
  const counts = new Map();

  for (const date of dates) {
    const n = weekday(date);

    counts.set(n, (counts.get(n) || 0) + 1);
  }

  const days = [...counts.keys()].sort((a, b) => a - b)
    .map((n) => (counts.get(n) > 1 ? `${dayName(n)}s` : dayName(n)));

  return [join(days), window].filter(Boolean).join(", ");
};

// A chip's face: "Sat 21", or "Sun Dec 6" where the column's name
// says nothing of the month (Later, Booked).
export const chipText = (date, column) => {
  const face = SHORT_DAYS[weekday(date)];

  return column === "this" || column === "next"
    ? `${face} ${dayOf(date)}`
    : `${face} ${monthOf(date)} ${dayOf(date)}`;
};

// A chip's own line where the board is wide enough: "Order by Fri",
// the weekday of its cutoff in the farm's zone. "" without one.
export const chipCutoff = (cutoff, timeZone) => {
  if (!cutoff) return "";

  const words = orderBy(cutoff, timeZone);
  const day = /^Order by (\w{3})/.exec(words);

  return day ? `Order by ${day[1]}` : "";
};

// A chip's name for a screen reader, complete beside its group's
// (the place and the routine): "Saturday, November 21, next week",
// with "as booked" or "closed" after it.
export const chipName = (entry, column) => [
  label(entry.date),
  COLUMN_NAMES[column].toLowerCase(),
  entry.booked && "as booked",
  entry.closed && "closed",
].filter(Boolean).join(", ");

// The place an entry is at, for grouping: its location code. A booked
// entry carries none (lib/picker.mjs bookedEntry), so it takes the
// location of another entry of its series, and stands alone without
// one.
const placeKey = (entry, bySeries) => entry.location
  || bySeries.get(entry.series) || entry.series || entry.value;

const spokenName = (text) => text.replaceAll(" · ", ", ");

// The board: its columns, and its places in the order their first
// pickup comes, each with its routines (a series at that place) in
// the same order, and each routine's entries by column. `locate(entry)`
// gives the entry's location (data/locations.json) or null.
//
// A place with one routine is one row headed by the pickup's name,
// "North Scituate · Drop site". A place with several is headed by the
// town and the venue, "Pawtucket · Jordan's Jungle", with a row for
// each routine named on its own.
export const board = (list, { today: todayIso, locate = () => null }) => {
  const entries = list || [];
  const bySeries = new Map(entries.filter((d) => d.location)
    .map((d) => [d.series, d.location]));
  const places = new Map();

  for (const entry of entries) {
    const key = placeKey(entry, bySeries);

    if (!places.has(key)) places.set(key, { key, routines: new Map() });

    const { routines } = places.get(key);
    const series = entry.series || entry.value;

    if (!routines.has(series)) routines.set(series, []);
    routines.get(series).push(entry);
  }

  const columns = boardColumns(entries, todayIso);

  return {
    columns,
    places: [...places.values()].map(({ key, routines }) => {
      const groups = [...routines.entries()];
      const several = groups.length > 1;
      // The place's facts come from an entry that has them: a booked
      // one that has gone carries no name or window.
      const all = groups.flatMap(([, list]) => list);
      const first = all.find((d) => !d.booked) || all[0];
      const loc = locate(first) || null;
      const town = first.town || (loc || {}).town || "";
      const address = addressOf(first, loc)
        .filter((line) => !several || !loc || line !== loc.name);
      const title = several
        ? pickupName(town, loc ? loc.name : "") || town
        : pickupName(town, first.name) || first.place || "";

      const routinesOut = groups.map(([series, list]) => {
        const named = list.find((d) => !d.booked) || list[0];
        const open = list.filter((d) => !d.closed && !d.booked);
        const when = routineText(
          (open.length ? open : list).map((d) => d.date), named.window,
        );
        const name = several ? named.name || "" : "";

        return {
          key: series,
          name,
          when,
          round: list.some((d) => d.round),
          // With several routines at a place, each is a group of its
          // own, named in full: "Thanksgiving Prep, Saturday, 12:00 to
          // 5:00 PM".
          spoken: several
            ? [name, spokenWindow(when)].filter(Boolean).join(", ") : "",
          cells: columns.map((c) => list
            .filter((d) => columnOf(d.date, todayIso) === c.key)),
        };
      });

      return {
        key,
        title,
        address: address.join(", "),
        several,
        // The place's legend for a screen reader: its name and address,
        // and with one routine, the routine too.
        spoken: spokenName([
          title, address.join(", "),
          several ? "" : spokenWindow(routinesOut[0].when),
        ].filter(Boolean).join(", ")),
        routines: routinesOut,
      };
    }),
  };
};

// The summary under the board: the chosen pickup's day and hours, its
// name, and the order-by line. `booked` is the value of the pickup an
// order being changed holds, if any, which titles it "Your pickup, as
// booked" or "Moving to" (draft wording, #573).
export const summary = (entry, loc, { timeZone, booked = "" } = {}) => {
  let title = "Your pickup";

  if (booked) title = entry.value === booked ? "Your pickup, as booked"
    : "Moving to";

  return {
    title,
    when: [entry.label, entry.window].filter(Boolean).join(", "),
    name: pickupName(entry.town || (loc || {}).town, entry.name),
    orderBy: orderBy(entry.cutoff, timeZone),
  };
};
