// A buying group on the order page (#471). The page embeds nothing of
// a group: once POST /api/group accepts its code (typed in the code
// box, or carried by the link /order/?group=<code>), the answer brings
// the group's place and series, its member price list and its open
// rounds, and these fold them into what the page already holds.

import { buildModel } from "./events.mjs";

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
