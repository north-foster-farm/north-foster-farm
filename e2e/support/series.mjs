// The farm's markets and pop-ups in the list shapes the pages read,
// from data/series.json and data/locations.json (the one source), for
// the specs that work out what a build shows.

import locationData from "../../data/locations.json" with { type: "json" };
import seriesData from "../../data/series.json" with { type: "json" };

const place = (code) => locationData.locations.find((l) => l.code === code);

// { name, opens, closes }, the season of each market.
export const markets = seriesData.series
  .filter((s) => s.kind === "market")
  .map((s) => ({ name: s.name, opens: s.start, closes: s.end }));

// One entry per pop-up, as data/events.json once listed them.
export const events = seriesData.series
  .filter((s) => s.kind === "pop-up")
  .map((s) => {
    const loc = place(s.location);

    return {
      id: s.code,
      kind: "pop-up",
      name: s.name,
      place: loc.name,
      date: s.start,
      start: s.opens,
      end: s.closes,
      address: {
        street: loc.street, city: loc.city, state: loc.state, zip: loc.zip,
      },
    };
  });
