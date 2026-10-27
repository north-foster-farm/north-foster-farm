// Scheduled pickup on the order page: one picker over /api/dates'
// `scheduled` list, every occurrence open for pickup (the drop site, a
// market, a pop-up). The form's way and the stored method are both
// `scheduled`; a choice is an occurrence id ("K4Q7-261101"), the
// series' code and the date, and it is the picker's option value.

// An entry of /api/dates' `scheduled`, ready for a picker: its `value`
// and its `text`, date then place then window, the window as the
// server prints it ("Saturday, October 24: Drop site, Scituate,
// 10:00 – 11:00 AM").
export const scheduledChoice = (entry) => ({
  ...entry,
  value: entry.occurrence,
  text: `${entry.label}: ${[entry.name, entry.town, entry.window]
    .filter(Boolean).join(", ")}`,
});

export const scheduledChoices = (list) => (list || []).map(scheduledChoice);

// The names of the places a list reaches, in the order its dates come,
// each once.
export const placeNames = (choices) => [
  ...new Set(choices.filter((c) => c.name).map((c) => c.name)),
];

// "Drop site, Foster Farmers Market, and Summer Pop-up" for the card's
// Where; beyond three, "and more".
export const placesFact = (choices, shown = 3) => {
  const names = placeNames(choices);
  const some = names.slice(0, shown);

  if (names.length > shown) return `${some.join(", ")}, and more`;
  if (some.length < 3) return some.join(" and ");

  return `${some.slice(0, -1).join(", ")}, and ${some[some.length - 1]}`;
};

// Whether the list reaches only the drop site's series, so the card
// reads as the drop site's did before markets were added.
export const dropOnly = (choices, series) => choices.every(
  (c) => c.series === series
);

// An occurrence's id: its series' code and its date as YYMMDD.
export const occurrenceId = (series, date) => (
  `${series}-${String(date).slice(2).replaceAll("-", "")}`
);

// The occurrence a saved draft meant: its own, or, for a draft saved
// before scheduled pickup (method `scituate`), the drop site series'
// on its date. "" when it means none.
export const draftOccurrence = (f, series) => {
  if (f.occurrence) return f.occurrence;

  return f.method === "scituate" && f.date ? occurrenceId(series, f.date) : "";
};

// The day a fulfilment falls on. A scheduled one sends only its
// occurrence, so the day comes from the lists (`find` takes an id and
// returns an entry or nothing); every other way carries its `date`.
export const fulfilmentDate = (f, find) => f.date
  || (f.method === "scheduled" && (find(f.occurrence) || {}).date)
  || "";

// The drop site's series code: the model's series of kind "drop-site"
// (data/series.json). null when the farm has none.
export const dropSeriesCode = (model) => (
  (model.series.find((s) => s.kind === "drop-site") || {}).code || null
);

// The choice a picker lands on when the one wanted is gone: the next of
// the series the draft named (the old drop site draft), else the first.
// A named series with no entry left gives nothing, never another
// place's date.
export const fallbackChoice = (list, series = "") => (
  series ? list.find((d) => d.series === series) : list[0]
);

// How many distinct locations a list reaches (the entry's `location`
// code), for the card's "3 locations".
export const locationCount = (choices) => new Set(
  choices.map((c) => c.location || c.series)
).size;

// The link's words for a count: "1 location", "3 locations". The one
// place to write them, so the number is always the live count and
// never one typed into a page or a test.
export const locationsLabel = (count) => `${count} location${
  count === 1 ? "" : "s"}`;

// A location's address as lines: the venue's name, street line 1 and
// line 2 where it has them, then "City, ST 02857" (#323). Each line
// is a part; a phone shows one per row, a wide card joins them.
export const addressLines = (loc) => {
  if (!loc) return [];

  const state = [loc.state, loc.zip].filter(Boolean).join(" ");

  return [
    loc.name, loc.street, loc.street2,
    [loc.city, state].filter(Boolean).join(", "),
  ].filter(Boolean);
};

// A pickup's subtitle: the town, then the pickup's own name,
// "Scituate · Drop site", as on the Places cards. A name that already
// says its town says it alone: "Foster Farmers Market" (#439).
export const pickupName = (town, name) => {
  if (town && name && ` ${name} `.includes(` ${town} `)) return name;

  return [town, name].filter(Boolean).join(" · ");
};

// A pickup as its card's parts: the day, the hours, the subtitle and
// the address of the place it is at.
export const pickupParts = (entry, loc) => ({
  date: entry.label,
  time: entry.window,
  name: pickupName(entry.town || (loc || {}).town, entry.name),
  address: addressLines(loc),
});
