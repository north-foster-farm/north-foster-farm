// The words that say when and how an order is fulfilled, shared by
// the emails, the packing slips and the account pages so everyone
// reads the same words everywhere.

import terms from "../../../data/delivery.json" with { type: "json" };
import {
  pickupTimes, windowLabel,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import { company } from "./company.mjs";

// "10:00 AM – 4:00 PM" -> "10 AM and 4 PM", for "between ... and ...".
export const between = (window) =>
  window.replace(/:00/g, "").split(/\s*–\s*/).join(" and ");

export const methodName = (method) => ({
  delivery: "Delivery",
  scituate: "Drop site",
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

const FARM = `${company.address.street}, ${company.address.city}, ` +
  `${company.address.state} ${company.address.zip}`;

// Where and when an order is handed over, for any way of getting it:
// { method, name, window, place }. `place` is the address the order
// goes to or is collected from. A fulfilment type added later (a
// second drop site, a market) gets its words here and nowhere else.
export const placeOf = (order) => {
  const f = order.fulfilment;
  const of = {
    delivery: () => ({
      window: terms.delivery.window, place: streetAddress(f.delivery || {}),
    }),
    scituate: () => ({
      window: terms.scituate.window, place: terms.scituate.location,
    }),
    onfarm: () => ({ window: pickupWindow(order), place: FARM }),
  }[f.method];

  return {
    method: f.method,
    name: methodName(f.method),
    ...(of ? of() : { window: "", place: "" }),
  };
};
