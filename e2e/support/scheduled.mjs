// Canned scheduled pickup: /api/dates answered with a `scheduled` list
// of the drop site, a market and a pop-up, in the shape piece A1
// (#310) posted on #309, so a spec can reach every kind of place on a
// local build, whatever the schedule opens today. VFVQ and WAC5 are
// the real series codes; the pop-up's is made up.

import { dates } from "./canned.mjs";
import { addDays, today } from "../../assets/scripts/order/lib/zoned.mjs";

export const DROP = {
  series: "VFVQ", name: "Drop site", location: "G4C6", town: "Scituate",
  place: "Drop site, Village Green, North Scituate",
  short: "Village Green, North Scituate", window: "10:00 – 11:00 AM",
};

export const FOSTER = {
  series: "WAC5", name: "Foster Farmers Market", location: "D8RW",
  town: "Foster",
  place: "Foster Farmers Market, Shady Acres Diner, 164 Danielson Pike, Foster",
  short: "Shady Acres Diner, 164 Danielson Pike, Foster",
  window: "9:00 AM – 1:00 PM",
};

export const POPUP = {
  series: "ZQ3M", name: "Summer Concert", location: "H7TN", town: "Scituate",
  place: "Summer Concert, The Green, Scituate", short: "The Green, Scituate",
  window: "6:00 – 8:00 PM",
};

const LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
});

// An occurrence's id: the series code, a dash, the date as YYMMDD.
export const occurrence = (series, date) => `${series.series}-${
  date.slice(2).replaceAll("-", "")}`;

// An entry of `scheduled` for `place` on `date` ("2026-11-01"), cutoff
// 11:59 PM New York the day before (03:59 UTC, in daylight time).
const entry = (place, date) => ({
  occurrence: occurrence(place, date),
  date,
  label: LABEL.format(new Date(`${date}T12:00:00Z`)),
  ...place,
  cutoff: `${date}T03:59:00.000Z`,
});

// The canned lists with `scheduled` made from `places`
// ([{ place, days: [offset, ...] }], each day counted from today), in
// date order.
export const datesWith = (places = [
  { place: DROP, days: [3, 10] },
  { place: FOSTER, days: [9, 11] },
  { place: POPUP, days: [6] },
]) => {
  const start = today(new Date(), "America/New_York");

  return {
    ...dates(),
    scheduled: places
      .flatMap(({ place, days }) =>
        days.map((n) => entry(place, addDays(start, n))))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
};

export const cannedScheduled = (page, lists = datesWith()) => page.route(
  "**/api/dates", (route) => route.fulfill({ json: lists }),
);
