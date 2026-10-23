// The words that say when and how an order is fulfilled, shared by
// the emails, the packing slips and the account pages so everyone
// reads the same words everywhere.

import terms from "./terms.mjs";
import {
  pickupTimes, windowLabel,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import {
  isScheduled, orderOccurrence,
} from "../../../assets/scripts/order/lib/dates.mjs";
import { company } from "./company.mjs";

// "10:00 AM – 4:00 PM" -> "10 AM and 4 PM", for "between ... and ...".
export const between = (window) =>
  window.replace(/:00/g, "").split(/\s*–\s*/).join(" and ");

// What the customer reads. The drop site, every market and every pop-up
// are one choice (draft wording); `placeOf(order).name` is the farm's
// own name for the place.
export const methodName = (method) => ({
  delivery: "Delivery",
  scheduled: "Scheduled pickup",
  scituate: "Scheduled pickup",
  market: "Scheduled pickup",
  onfarm: "On-farm pickup",
}[method] || method);

// "9 – 11 AM", "11 AM – 1 PM": a range the farm confirmed before W11d,
// on the hour.
const hoursRange = (from, to) => {
  const h = (x) => `${((x + 11) % 12) + 1}`;
  const m = (x) => (x < 12 ? "AM" : "PM");

  return m(from) === m(to)
    ? `${h(from)} – ${h(to)} ${m(to)}`
    : `${h(from)} ${m(from)} – ${h(to)} ${m(to)}`;
};

// "9 AM – noon": the window booked. A record from before W11d may
// carry the range the farm confirmed inside its window; that wins.
export const pickupWindow = (order) => {
  const o = order.fulfilment.onfarm || {};
  const times = pickupTimes(o);

  if (o.confirmed) return hoursRange(o.confirmed.from, o.confirmed.to);

  return times ? windowLabel(times) : String(o.window || "");
};

// "84 Foster Center Rd, Foster, RI 02825", skipping whatever the
// record lacks.
export const streetAddress = (a = {}) => [
  a.address1, a.address2, a.town,
  [a.state, a.zip].filter(Boolean).join(" "),
].filter(Boolean).join(", ");

// The farm as the email footer writes it.
const FARM = `${company.address.short || company.address.street}, ${
  company.address.city}, ${company.address.state} ${company.address.zip}`;

// "10:00 AM – 4:00 PM" -> "10 AM – 4 PM", the way pickup windows read.
const hours = (window) => window.replace(/:00/g, "");

// A packet's counts: "4 slips (1 revised), 1 cancelled", a zero part
// left out, and "No slips, 1 cancelled" when nothing is to pack.
export const packetCounts = ({ slips = 0, revised = 0, cancelled = 0 }) => [
  slips
    ? `${slips} slip${slips === 1 ? "" : "s"}${
      revised ? ` (${revised} revised)` : ""}`
    : "No slips",
  cancelled && `${cancelled} cancelled`,
].filter(Boolean).join(", ");

// A market's place line opens with its name ("Foster Farmers Market,
// Shady Acres Diner, ..."); a note that already names the series wants
// the rest.
const withoutName = (place, name) => (place.startsWith(`${name}, `)
  ? place.slice(name.length + 2) : place);

// Where and when an order is handed over, for any way of getting it:
// { method, name, window, place }. `place` is the address the order
// goes to or is collected from. A fulfilment type added later (a
// second drop site, a market) gets its words here and nowhere else.
export const placeOf = (order) => {
  const f = order.fulfilment;
  const of = {
    delivery: () => ({
      window: hours(terms.delivery.window),
      place: streetAddress(f.delivery || {}),
    }),
    // An occurrence gone from the data never reads as the farm or the
    // drop site: it is named by its id, with no place or hour.
    scheduled: () => {
      const o = orderOccurrence(terms, f);

      return o
        ? {
          occurrence: o.id, site: o.series, siteName: o.name, kind: o.kind,
          window: hours(o.window), place: o.place,
          address: withoutName(o.place, o.name),
        }
        : {
          occurrence: f.occurrence, window: "",
          siteName: f.occurrence ? `Pickup, ${f.occurrence}` : undefined,
          place: f.occurrence ? `Pickup, ${f.occurrence}` : "",
          address: f.occurrence ? `Pickup, ${f.occurrence}` : "",
        };
    },
    onfarm: () => ({ window: pickupWindow(order), place: FARM }),
  }[isScheduled(f) ? "scheduled" : f.method];

  const where = of ? of() : { window: "", place: "" };

  // `name` is the farm's own word for the place (a slip's heading);
  // the customer's is `methodName`.
  return {
    method: f.method,
    name: where.siteName || methodName(f.method),
    ...where,
  };
};
