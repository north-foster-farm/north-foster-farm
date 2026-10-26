// The farm's scheduled pickups: locations (a place), series (what
// recurs at a location over a season, or happens once) and
// occurrences (one date of a series). data/locations.json and
// data/series.json are the one source; every location and series has a
// generated 4-character code with no meaning, and an occurrence is
// named by its series code and date, `K4Q7-261101`. Which occurrences
// customers may book is the farm's pickup schedule's
// (lib/schedule.mjs), never a flag here. A location or series is
// archived (`archived: true`), never deleted: it still resolves, for the
// orders that name it, but is never offered.

import {
  addDays, dayName, instant, weekday,
} from "./zoned.mjs";

// The order-id alphabet: no I, L, O, 0 or 1.
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE = /^[A-HJKMNP-Z2-9]{4}$/;
const OCCURRENCE = /^([A-HJKMNP-Z2-9]{4})-(\d\d)(\d\d)(\d\d)$/;

// A code not in `taken`; `pick(n)` returns an integer below n.
export const newCode = (taken, pick) => {
  for (;;) {
    const code = Array.from({ length: 4 },
      () => ALPHABET[pick(ALPHABET.length)]).join("");

    if (!taken.includes(code)) return code;
  }
};

// "K4Q7", "2026-11-01" -> "K4Q7-261101".
export const occurrenceId = (code, iso) =>
  `${code}-${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;

// "K4Q7-261101" -> { series: "K4Q7", date: "2026-11-01" }, or null for
// anything that is not an occurrence id.
export const parseOccurrence = (id) => {
  const m = OCCURRENCE.exec(typeof id === "string" ? id : "");

  if (!m) return null;

  const date = `20${m[2]}-${m[3]}-${m[4]}`;
  const real = new Date(`${date}T12:00:00Z`);

  return !Number.isNaN(real.getTime())
    && real.toISOString().slice(0, 10) === date
    ? { series: m[1], date } : null;
};

// "18:00" -> { hour: 18, minute: 0 }.
const clock = (hhmm) => {
  const [hour, minute] = String(hhmm).split(":").map(Number);

  return { hour, minute: minute || 0 };
};

// "6:00 PM", the way the farm's hours read.
const twelve = ({ hour, minute }) => `${((hour + 11) % 12) + 1}:${
  String(minute).padStart(2, "0")}`;
const half = ({ hour }) => (hour < 12 ? "AM" : "PM");

// "18:00", "20:00" -> "6:00 – 8:00 PM"; "11:00", "15:00" ->
// "11:00 AM – 3:00 PM".
export const rangeWindow = (start, end) => {
  const [from, to] = [clock(start), clock(end)];

  return half(from) === half(to)
    ? `${twelve(from)} – ${twelve(to)} ${half(to)}`
    : `${twelve(from)} ${half(from)} – ${twelve(to)} ${half(to)}`;
};

const hours = (opens, closes) => {
  const [from, to] = [clock(opens), clock(closes)];

  return {
    opens,
    closes,
    opensHour: from.hour,
    opensMinute: from.minute,
    closesHour: to.hour,
    closesMinute: to.minute,
    window: rangeWindow(opens, closes),
  };
};

// The place line a location gives under a series' name.
const placeOf = (loc, name) => [name, loc.name, loc.street, loc.city]
  .filter(Boolean).join(", ");

// The series with their location's facts folded in, and lookups.
// -> { locations, series, location(code), seriesOf(code) }
export const buildModel = (locations = [], series = []) => {
  const place = (code) => locations.find((l) => l.code === code);
  const where = (s, loc, over = {}) => {
    const here = place(over.location) || loc;

    return {
      location: here ? here.code : s.location,
      town: s.town || (here && here.town) || "",
      place: s.place || (here ? placeOf(here, s.name) : ""),
      short: s.short || (here
        ? here.short || [here.name, here.street, here.city].filter(Boolean)
          .join(", ")
        : ""),
      lat: here && here.lat,
      lng: here && here.lng,
      locationArchived: Boolean(here && here.archived),
    };
  };
  const shaped = series.map((s) => ({
    ...s,
    end: s.end || null,
    archived: Boolean(s.archived),
    weekday: weekday(s.start),
    ...hours(s.opens, s.closes),
    ...where(s, place(s.location)),
    overrides: s.overrides || {},
  }));

  return {
    locations,
    series: shaped,
    location: place,
    seriesOf: (code) => shaped.find((s) => s.code === code) || null,
    where: (s, over) => where(
      series.find((x) => x.code === s.code), place(s.location), over
    ),
  };
};

// Whether the series has an occurrence on this date.
export const hasDate = (s, iso) => iso >= s.start
  && (!s.end || iso <= s.end) && weekday(iso) === s.weekday;

// The dates a series has from `from` through `to`, inclusive.
export const seriesDates = (s, from, to) => {
  const out = [];

  for (let d = from > s.start ? from : s.start; d <= to; d = addDays(d, 1)) {
    if (hasDate(s, d)) out.push(d);
  }

  return out;
};

// An occurrence: the series' facts for one of its dates, with that
// day's own location or hours where the series carries them, and a
// schedule line's narrower window where the farm set one.
// `line` is { from, to } as the schedule parses it.
export const occurrenceOf = (model, s, iso, line = null) => {
  const over = s.overrides[iso] || {};
  const base = model.where(s, over);
  const span = line && line.from
    ? hours(line.from, line.to)
    : hours(over.opens || s.opens, over.closes || s.closes);

  return {
    id: occurrenceId(s.code, iso),
    date: iso,
    series: s.code,
    name: s.name,
    kind: s.kind,
    archived: s.archived || base.locationArchived,
    href: s.href,
    instagram: s.instagram,
    ...base,
    ...span,
  };
};

// The occurrence an id names, whatever its state (archived still
// resolves), or null when the series or the date doesn't exist.
export const resolveOccurrence = (model, id) => {
  const parsed = parseOccurrence(id);
  const s = parsed && model.seriesOf(parsed.series);

  return s && hasDate(s, parsed.date)
    ? occurrenceOf(model, s, parsed.date) : null;
};

// The Stage 1 ways of naming a pickup (`scituate`, or `market` and a
// site id) as an occurrence id, for orders and links that predate the
// model. -> id or null.
export const legacyOccurrence = (model, method, site, iso) => {
  const wanted = method === "scituate" ? "scituate"
    : method === "market" ? site : null;
  const s = wanted && model.series.find((x) => x.legacySite === wanted);

  return s && hasDate(s, iso) ? occurrenceId(s.code, iso) : null;
};

// The last moment to order for an occurrence: 11:59 PM the day before.
export const cutoffOf = (iso, timeZone) =>
  instant(addDays(iso, -1), 23, 59, timeZone);

// What is wrong between the registry (every code ever used), the data
// files and the schedule's lines. Archived, never deleted, so a
// registered code that does not resolve is a deletion. -> [message]
export const checkIntegrity = ({
  locations = [], series = [], registered = [], lines = [], today: day,
}) => {
  const errors = [];
  const all = [...locations, ...series];
  const defined = all.map((x) => x.code);

  for (const code of new Set(defined)) {
    if (defined.indexOf(code) !== defined.lastIndexOf(code)) {
      errors.push(`"${code}" is used by more than one location or series.`);
    }
  }
  for (const code of defined) {
    if (!CODE.test(String(code))) {
      errors.push(`"${code}" is not a 4-character code from ${ALPHABET}.`);
    }
    if (!registered.includes(code)) {
      errors.push(`"${code}" is not in data/registry.json. Add it there ` +
        "(append only).");
    }
  }
  for (const code of registered) {
    if (!defined.includes(code)) {
      errors.push(`"${code}" is registered but no data file defines it ` +
        'any more. Restore it and set "archived": true; a location or ' +
        "series is never deleted.");
    }
  }
  for (const code of new Set(registered)) {
    if (registered.indexOf(code) !== registered.lastIndexOf(code)) {
      errors.push(`"${code}" is registered twice.`);
    }
  }
  for (const s of series) {
    const loc = locations.find((l) => l.code === s.location);
    const inSeason = !s.archived && (!s.end || s.end >= day);

    if (!loc) {
      errors.push(`Series ${s.code} (${s.name}) names location ` +
        `"${s.location}", which doesn't exist.`);
    } else if (loc.archived && inSeason) {
      errors.push(`Series ${s.code} (${s.name}) is still in season at ` +
        `archived location ${loc.code}.`);
    }
  }
  for (const l of lines) {
    if (!series.some((s) => s.code === l.code)) {
      errors.push(`${l.date}: the schedule names "${l.code}", which is ` +
        "not a series.");
    }
  }

  return errors;
};

// "Sundays, 9:00 AM – 1:00 PM": a recurring series as the market list
// prints it.
export const whenOf = (s) => `${dayName(s.weekday)}s, ${s.window}`;
