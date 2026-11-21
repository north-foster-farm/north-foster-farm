// A buying group on the order page (#471). The page embeds nothing of
// a group: once POST /api/group accepts its code (typed in the code
// box, or carried by the link /order/?group=<code>), the answer brings
// the group's place and series, its member price list and its open
// rounds, and these fold them into what the page already holds.

import { buildModel, seriesDates } from "./events.mjs";
import {
  addDays, dayName, label, today,
} from "./zoned.mjs";

// "Every other": how often a group's series comes round, by its
// `every` weeks.
const EVERY = { 1: "Every", 2: "Every other", 3: "Every third",
  4: "Every fourth" };

// Group orders' When (#749 item 2): "Every other Sunday, 8:30 – 9:00
// AM", from the group's series in the model (lib/events.mjs).
export const roundsWhen = (series) => `${EVERY[series.every || 1]
  || "Every"} ${dayName(series.weekday)}, ${series.window}`;

// Group orders' When with no round open (#749 item 6): the day the
// next round opens for orders, "next order opens Sunday, December 6",
// or "Not currently scheduled" when the series has no date to come.
// A round opens as the one before it goes by (lib/dates.mjs
// scheduledLines), so with none open now, the next opens on the date
// of the one that would be next. `now` is a Date.
export const nextRoundOpens = (series, now, timeZone) => {
  const from = addDays(today(now, timeZone), 1);
  const [next] = series && !series.archived
    ? seriesDates(series, from, addDays(from, 400)) : [];

  return next ? `next order opens ${label(next)}` : "Not currently scheduled";
};

// "Orders close at 11:59 PM on Saturday, November 21": a round's
// cutoff (#749 item 5), an ISO instant, in the farm's zone.
export const ordersClose = (cutoff, timeZone) => {
  const at = new Date(cutoff);
  const time = at.toLocaleTimeString("en-US", {
    timeZone, hour: "numeric", minute: "2-digit",
  }).replace(/\s/gu, " ");
  const day = at.toLocaleDateString("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric",
  });

  return `Orders close at ${time} on ${day}`;
};

// The code a link carries, as typed into the box, or "".
export const groupFromQuery = (search) => {
  const value = new URLSearchParams(search).get("group") || "";

  return /^[A-Za-z0-9-]{6,40}$/.test(value) ? value.toUpperCase() : "";
};

// The terms with the group's place and series in the model, and the
// group named, so validateOrder offers its pickup as the server does.
// `raw` is the page's embedded locations and series; `places` the
// group's, from /api/group. With no group, the embedded model alone.
export const withPlaces = (terms, raw, group = null) => {
  const places = group ? group.places : { locations: [], series: [] };
  const known = (list, code) => list.some((x) => x.code === code);
  const locations = [
    ...raw.locations,
    ...places.locations.filter((l) => !known(raw.locations, l.code)),
  ];
  const series = [
    ...raw.series,
    ...places.series.filter((s) => !known(raw.series, s.code)),
  ];
  const rest = { ...terms };

  delete rest.groups;

  return {
    ...rest,
    model: buildModel(locations, series),
    ...(group ? { groups: [group.key] } : {}),
  };
};

// The scheduled list with the group's rounds in it, by date, each
// occurrence once. The list's own order is kept within a date.
export const mergeScheduled = (list, extra = []) => {
  const seen = new Set((list || []).map((d) => d.occurrence));
  const added = extra.filter((d) => !seen.has(d.occurrence));

  return [...(list || []), ...added]
    .map((d, i) => [d, i])
    .sort(([a, i], [b, j]) => a.date.localeCompare(b.date) || i - j)
    .map(([d]) => d);
};
