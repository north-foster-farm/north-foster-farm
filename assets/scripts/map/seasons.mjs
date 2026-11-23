// Seasons, numbers and the order (#861, phase 3 of
// docs/refactors/map.md): which day it is, what has ended, the rows'
// numbers, the list's order and what a link into the map opens. No
// DOM: seasons.js and schedule.js read the markup and write it.

// A date as YYYY-MM-DD on the visitor's clock, to compare with the
// dates in the markup.
export const dayOf = (d) => {
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// True for a data-until before today; an element with none never ends.
export const gone = (until, today) => until && until < today;

// The numbers of the rows showing, from 1 in the list's order: a row
// that is hidden leaves no gap. Rows are { key, hidden }.
export const numbersOf = (rows) => new Map(rows.filter((row) => !row.hidden)
  .map((row, i) => [row.key, i + 1]));

// The locations by the next date the farm attends: the farm (with no
// location) first, those with a date in /api/events in its order, the
// rest as built. Items are { location }; events are /api/events'.
export const arranged = (items, events) => {
  const at = (item) => {
    const i = events.findIndex((e) => e.location === item.location);

    return i < 0 ? events.length : i;
  };

  return [...items].sort((a, b) => {
    if (!a.location || !b.location) {
      return (a.location ? 1 : 0) - (b.location ? 1 : 0);
    }

    return at(a) - at(b) || items.indexOf(a) - items.indexOf(b);
  });
};

// What the hash, decoded, opens on a map with layers: #places the
// Places layer, and #places-scheduled too (the older link, from when
// Places had a filter); #place-… that place's card, by its slug.
// Nothing for any other hash.
export const hashTarget = (hash, hasLayers) => {
  if (!hasLayers || !hash.startsWith("place")) return null;

  return { slug: hash.startsWith("places") ? null : hash };
};
