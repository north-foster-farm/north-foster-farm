// Scheduled pickup on the order page: one picker over /api/dates'
// `scheduled` list, every occurrence open for pickup (the drop site, a
// market, a pop-up). The form's way and the stored method are both
// `scheduled`; a choice is an occurrence id ("K4Q7-261101"), the
// series' code and the date, and it is the picker's option value.

// An entry of /api/dates' `scheduled`, ready for a picker: its `value`
// and its `text`, date then place then window, the window as the
// server prints it ("Saturday, October 24: Drop site, North Scituate,
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

// "Drop site, Foster Farmers’ Market, and Summer Pop-up" for the card's
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

// The Where line of the home page's Pickup days card (James,
// 2026-10-26; the order page's card has its own since #534, a count
// and a "(map)" link): with one location, its short address, which
// data/locations.json holds; with several, how many, as a link to the
// map; with none open, `built`, the drop site the page was built with.
// -> { text, link }, where `link` says the text is the map link.
export const whereLine = (choices, built = "") => {
  if (!choices.length) return { text: built, link: false };

  const count = locationCount(choices);

  if (count > 1) return { text: locationsLabel(count), link: true };

  return { text: choices[0].short || built, link: false };
};

// A location's address as lines: the venue's name, street line 1 and
// line 2 where it has them, then "City, ST 02857" (#323). Each line
// is a part; a phone shows one per row, a wide card joins them.
export const addressLines = (loc) => {
  if (!loc) return [];

  const state = [loc.state, loc.zip].filter(Boolean).join(" ");

  return [
    loc.name !== loc.street && loc.name, loc.street, loc.street2,
    [loc.city, state].filter(Boolean).join(", "),
  ].filter(Boolean);
};

// A pickup's subtitle: the town, then the pickup's own name,
// "North Scituate · Drop site", as on the Places cards. A name that
// already says its town says it alone: "Foster Farmers’ Market" (#439).
export const pickupName = (town, name) => {
  if (town && name && ` ${name} `.includes(` ${town} `)) return name;

  return [town, name].filter(Boolean).join(" · ");
};

// Hugo's urlize, as layouts/partials/map.html names a pin from a
// location's name: lowercase, punctuation dropped, runs of spaces and
// hyphens made one hyphen.
const urlize = (text) => String(text).toLowerCase()
  .replace(/[^a-z0-9 _-]/g, "")
  .replace(/[\s_-]+/g, "-")
  .replace(/^-|-$/g, "");

// A pickup as its card's parts (#703): the radio's value, the
// subtitle, the hours, the place's name when it is not its street,
// the street (with its second line) and "City, ST 02857". `copy` is
// what Copy puts on the clipboard, the street address on one line
// without the place's name; `map` is the home page's map open at the
// location's card on the Places tab (map.html's data-map-slug). A
// place it does not know gives no address and no map, and a private
// one (a buying group's) no map, since the home map never pins it.
export const pickupCard = (entry, loc) => {
  const at = loc || {};
  const street = [at.street, at.street2].filter(Boolean).join(", ");
  const state = [at.state, at.zip].filter(Boolean).join(" ");
  const city = [at.city, state].filter(Boolean).join(", ");
  const slug = at.private ? ""
    : at.slug || (at.name ? urlize(at.name) : "");

  return {
    value: entry.value || entry.occurrence,
    name: pickupName(entry.town || at.town, entry.name),
    time: entry.window || "",
    place: at.name && at.name !== at.street ? at.name : "",
    street,
    city,
    copy: [street, city].filter(Boolean).join(", "),
    map: slug ? `/#place-${slug}` : "",
  };
};

// A buying group's round as its card's parts (#749 item 5): as a
// pickup's, but its first line is its date ("Sunday, November 22")
// and the next the place's name, since a round is always the group's
// one place. A private place has no map.
export const roundCard = (entry, loc) => ({
  ...pickupCard(entry, loc),
  name: entry.label,
  place: (loc && loc.name) || entry.name || "",
});

// The pickups grouped by date (#703): one group per date, dates in
// order, each headed by its day and date ("Saturday, November 21")
// and holding that date's cards in the list's order. `place` takes a
// location's code and gives the location, or nothing.
// -> [{ date, heading, pickups }]
export const pickupDays = (choices, place = () => null) => {
  const days = new Map();

  for (const entry of choices || []) {
    if (!days.has(entry.date)) {
      days.set(entry.date, {
        date: entry.date, heading: entry.label, pickups: [],
      });
    }
    days.get(entry.date).pickups
      .push(pickupCard(entry, place(entry.location)));
  }

  return [...days.values()].sort((a, b) => (a.date < b.date ? -1
    : a.date > b.date ? 1 : 0));
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
