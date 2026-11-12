// The pickup picker's hard states (#573), for James to judge the
// timetable on staging and deploy previews: each state is a
// `scheduled` list for /api/dates, built from the farm's own public
// series and places as the page embeds them, with what else the state
// needs (a draft, an order being changed, a pickup that lapses). Pure:
// the switcher (picker-states.js) answers the page's requests with it,
// and the screenshot spec (e2e/picker-shots.spec.mjs) routes them with
// it. Neither ever reaches a production build
// (partials/staging/picker-states.html, bin/check-staging.mjs).
//
// Every word here is staging's own, never a customer's: the sample
// group and order are made up, and a buying group's real place and
// series stay out of the page as they always do (#471).

import { farmScheduledDates } from "../order/lib/dates.mjs";
import { buildModel, cutoffOf } from "../order/lib/events.mjs";
import { horizon } from "../order/lib/schedule.mjs";
import { occurrenceId } from "../order/lib/scheduled.mjs";
import { addDays, label, today } from "../order/lib/zoned.mjs";

// The states, in the order the switcher lists them.
export const STATES = [
  { key: "several", name: "Several places" },
  { key: "one", name: "One place only" },
  { key: "shared", name: "A day with two places" },
  { key: "group", name: "Group round 60 days out" },
  { key: "closing", name: "Chosen pickup closes" },
  { key: "moved", name: "Draft whose date moved" },
  { key: "edit", name: "?edit= As booked" },
  { key: "lapsed", name: "Lapsed dialog" },
  { key: "nothing", name: "Nothing available" },
  { key: "loading", name: "Loading" },
  { key: "failed", name: "Failed load" },
];

export const isState = (key) => STATES.some((s) => s.key === key);

// The sample order ?edit= opens (the switcher answers for it alone).
export const SAMPLE_ORDER = "PICKER-SAMPLE";
// How long the loading state holds the lists back: long enough to see
// the skeleton, short of the page's own give-up (skeleton.js, 10 s).
export const LOADING_MS = 8000;
// How long until the closing state's chosen pickup closes.
export const CLOSING_MS = 30_000;

// The places a page may show: no buying group's (#471), nothing
// archived.
export const publicPlaces = ({ locations = [], series = [] }) => ({
  locations: locations.filter((l) => !l.private && !l.archived),
  series: series.filter((s) => !s.group && !s.archived),
});

// Every pickup open now through the horizon, as /api/dates lists them
// (lib/dates.mjs), whatever the schedule's lines say. `locations` and
// `series` are the page's own (publicPlaces).
export const openList = ({ now, timeZone, locations, series }) => {
  const places = publicPlaces({ locations, series });
  const terms = { timeZone, model: buildModel(places.locations,
    places.series) };
  const last = horizon(now, timeZone);

  return farmScheduledDates(now, terms, 400)
    .filter((d) => d.date <= last && Date.parse(d.cutoff) > now.getTime());
};

// The list an answer gives at `now` (epoch ms): what is still open, as
// the server's would be. null stays null, a failed load.
export const answerAt = (scheduled, now) => (scheduled === null ? null
  : scheduled.filter((d) => !d.cutoff || Date.parse(d.cutoff) > now));

const byDate = (list) => [...list].sort((a, b) => a.date.localeCompare(b.date)
  || String(a.window).localeCompare(String(b.window)));

const moveTo = (entry, date, timeZone) => ({
  ...entry,
  date,
  label: label(date),
  occurrence: occurrenceId(entry.series, date),
  cutoff: cutoffOf(date, timeZone).toISOString(),
});

// The list with a day of two places: as it is when it has one, or with
// another place's first pickup moved onto the first place's day.
export const withSharedDay = (list, timeZone) => {
  const places = (d) => new Set(list.filter((x) => x.date === d.date)
    .map((x) => x.location)).size;

  if (list.some((d) => places(d) > 1)) return list;

  const [first] = list;
  const other = first && list.find((d) => d.location !== first.location);

  if (!other) return list;

  return byDate(list.map((d) => (d === other
    ? moveTo(d, first.date, timeZone) : d)));
};

// A made-up buying group's round `days` out, as /api/group would give
// it, marked a round (lib/group.mjs asRounds).
export const sampleRound = (now, timeZone, days = 60) => {
  const date = addDays(today(now, timeZone), days);

  return {
    occurrence: occurrenceId("SMPL", date), date, label: label(date),
    series: "SMPL", name: "Sample buying group", location: "",
    town: "", place: "Sample buying group", short: "",
    window: "8:30 – 9:00 AM",
    cutoff: cutoffOf(date, timeZone).toISOString(), round: true,
  };
};

// The pickup an order being changed holds, a week before the first
// place's first pickup, so the list no longer has it: "As booked".
const bookedFor = (list, timeZone) => {
  const [first] = list;

  return first ? moveTo(first, addDays(first.date, -7), timeZone) : null;
};

// A paid order holding `booked`, for /api/account/orders, in the shape
// the order page's ?edit= reads (order-form.js startEdit).
export const sampleOrder = ({ booked, sku, now }) => ({
  id: SAMPLE_ORDER,
  canChange: true,
  submittedAt: now.toISOString(),
  payments: [{ amount: 700 }],
  refunds: [],
  keptFee: 0,
  lines: sku ? [{ sku, qty: 1 }] : [],
  customer: { firstName: "Sample", lastName: "Customer",
    email: "picker-states@example.com" },
  fulfilment: { method: "scheduled", occurrence: booked.occurrence,
    date: booked.date },
  pickup: { occurrence: booked.occurrence, name: booked.name,
    window: booked.window, place: booked.place, series: booked.series,
    gone: false },
  totals: { perks: [] },
  code: "",
});

// The drop site's series code (data/series.json, kind "drop-site"),
// which an old draft falls back to.
export const dropCodeOf = (series = []) => (series
  .find((s) => s.kind === "drop-site") || {}).code || "";

// The state's parts, from `list`, every pickup open now (openList, or
// /api/dates' own). -> {
//   scheduled: the list /api/dates answers, or null for a failed load;
//     every answer drops a pickup whose cutoff has passed, so the
//     closing state's pickup closes on the page's own timer;
//   delay: how long to hold the first answer, in ms;
//   draft: a draft's fulfilment to restore;
//   order: the sample order ?edit= opens;
//   lapse: the pickup that lapses as the customer pays, which the
//     lapsed dialog shows struck beside the rest;
// }
export const stateParts = (key, {
  now, timeZone, list, dropCode = "", sku = "",
}) => {
  const all = byDate(list || []);
  const [first] = all;
  // The drop site's pickups; the first pickup's series without one.
  const drop = all.filter((d) => d.series === (dropCode || (first || {})
    .series));
  const base = { scheduled: all, delay: 0, draft: null, order: null,
    lapse: null };

  const booked = bookedFor(drop, timeZone);
  const states = {
    one: () => ({ scheduled: drop }),
    shared: () => ({ scheduled: withSharedDay(all, timeZone) }),
    group: () => ({ scheduled: [...all, sampleRound(now, timeZone)] }),
    closing: () => {
      const soon = { ...first, cutoff: new Date(now.getTime() + CLOSING_MS)
        .toISOString() };

      return { scheduled: [soon, ...all.slice(1)],
        draft: { method: "scheduled", occurrence: soon.occurrence } };
    },
    // A draft saved before scheduled pickup, on a drop site date that
    // has closed: the picker moves it to the series' next.
    moved: () => (booked
      ? { draft: { method: "scituate", date: booked.date } } : {}),
    edit: () => (booked ? { order: sampleOrder({ booked, sku, now }) } : {}),
    lapsed: () => ({ lapse: first,
      draft: { method: "scheduled", occurrence: first.occurrence } }),
    nothing: () => ({ scheduled: [] }),
    loading: () => ({ delay: LOADING_MS }),
    failed: () => ({ scheduled: null }),
  };
  // With nothing open, a state that needs a pickup shows the list as
  // it is.
  const needs = new Set(["closing", "lapsed"]);

  if (!states[key] || (needs.has(key) && !first)) return base;

  return { ...base, ...states[key]() };
};
