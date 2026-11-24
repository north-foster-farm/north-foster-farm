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
import {
  dayName, weekday,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { company } from "./company.mjs";

// "10:00 AM – 4:00 PM" -> "10:00 AM and 4:00 PM", for
// "between ... and ...".
export const between = (window) =>
  window.split(/\s*–\s*/).join(" and ");

// What the customer reads. The drop site, every market and every pop-up
// are one choice (draft wording); `placeOf(order).name` is the farm's
// own name for the place.
export const methodName = (method) => ({
  delivery: "Delivery",
  scheduled: "Pick-up days",
  scituate: "Pick-up days",
  market: "Pick-up days",
  onfarm: "On-farm pickup",
}[method] || method);

// Whether a fulfilment is at a buying group's round (#749), by its
// occurrence's series in the data.
export const isGroupRound = (f) => isScheduled(f)
  && (orderOccurrence(terms, f) || {}).kind === "group";

// The order type as the customer reads it: a group's round is "Group
// orders" (#749 item 10), past orders that read "Pick-up days"
// included; every other order its method's name.
export const orderTypeName = (f) => (isGroupRound(f) ? "Group orders"
  : methodName(f.method));

// "9 – 11 AM", "11 AM – 1 PM": a range the farm confirmed before W11d,
// on the hour.
const hoursRange = (from, to) => {
  const h = (x) => `${((x + 11) % 12) + 1}`;
  const m = (x) => (x < 12 ? "AM" : "PM");

  return m(from) === m(to)
    ? `${h(from)} – ${h(to)} ${m(to)}`
    : `${h(from)} ${m(from)} – ${h(to)} ${m(to)}`;
};

// "9:00 AM – 12:00 PM": the window booked. A record from before W11d may
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

// A packet's counts: "4 slips (1 revised), 1 cancelled", a zero part
// left out, and "No slips, 1 cancelled" when nothing is to pack.
export const packetCounts = ({ slips = 0, revised = 0, cancelled = 0 }) => [
  slips
    ? `${slips} slip${slips === 1 ? "" : "s"}${
      revised ? ` (${revised} revised)` : ""}`
    : "No slips",
  cancelled && `${cancelled} canceled`,
].filter(Boolean).join(", ");

// "Saturday, 11/21": a day as a packing email names it, with no year
// (#694; the comma since James's revision, 2026-11-20).
export const shortDay = (iso) => `${dayName(weekday(iso))}, ${
  Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// A town and the occasion's name, the town said once: "Pawtucket" and
// "Thanksgiving Prep" make "Pawtucket Thanksgiving Prep", while
// "Pawtucket Farmers Market" and "Scituate Rotary Farmers Market" (in
// North Scituate) already say where they are and stand alone. So does
// a name that holds its venue (2026-11-20, communications on PR #695):
// "Summer Market at Tilted Barn", never "Exeter Summer Market at ...".
export const townAndName = (town, name) => {
  const words = ` ${String(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const said = (w) => words.includes(` ${w} `);

  return !town || said(town) || said(town.split(/\s+/).at(-1))
    || / at /.test(String(name))
    ? name : `${town} ${name}`;
};

// The place an order's slips are listed under in a packing email
// (#694), with the farm's name for it: each pickup-day occurrence is
// its own, on-farm pickup and delivery one each. `f` is a fulfilment,
// or what a printed snapshot kept of one. The drop site is a common
// noun after its town, "North Scituate drop site"; a pop-up is its
// occasion's name, "Thanksgiving Prep pop-up" (James's revision,
// 2026-11-20); a market names its town once, "Pawtucket Farmers
// Market". -> { key, place }.
export const packingGroup = (f) => {
  if (!isScheduled(f)) return { key: f.method, place: methodName(f.method) };

  const o = orderOccurrence(terms, f);

  if (!o) {
    return {
      key: `pickup-${f.occurrence || f.site || f.date}`,
      place: f.occurrence ? `Pickup ${f.occurrence}` : methodName(f.method),
    };
  }
  if (o.kind === "pop-up") {
    return {
      key: o.id,
      place: /\bpop-up\b/i.test(o.name) ? o.name : `${o.name} pop-up`,
    };
  }

  const name = o.kind === "drop-site"
    ? o.name[0].toLowerCase() + o.name.slice(1) : o.name;

  return { key: o.id, place: townAndName(o.town, name) };
};

// The three kinds of fulfillment, one packing email each (#694,
// James's revision, 2026-11-20): what the subject calls the kind, what
// the body calls its orders, and the PDF's title.
export const PACKING_KINDS = {
  onfarm: {
    key: "onfarm", noun: "on-farm pickups", orders: "on-farm pickup",
    title: "On-farm pickups",
  },
  market: {
    key: "market", noun: "market/drop site pickups",
    orders: "market, pop-up, and drop site pickup",
    title: "Market/drop site pickups",
  },
  delivery: {
    key: "delivery", noun: "deliveries", orders: "delivery",
    title: "Deliveries",
  },
};

// The kind a fulfilment (or a printed snapshot's) belongs to: the drop
// site, every market and every pop-up are one.
export const packingKind = (f) => PACKING_KINDS[isScheduled(f) ? "market"
  : f.method === "delivery" ? "delivery" : "onfarm"];

// A market's place line opens with its name ("Foster Farmers’ Market,
// Shady Acres Diner, ..."); a note that already names the series wants
// the rest.
const withoutName = (place, name) => (place.startsWith(`${name}, `)
  ? place.slice(name.length + 2) : place);

// Where and when an order is handed over, for any way of getting it:
// { method, name, window, place }. `place` is the address the order
// goes to or is collected from. A fulfillment type added later (a
// second drop site, a market) gets its words here and nowhere else.
export const placeOf = (order) => {
  const f = order.fulfilment;
  const of = {
    delivery: () => ({
      window: terms.delivery.window,
      place: streetAddress(f.delivery || {}),
    }),
    // An occurrence gone from the data never reads as the farm or the
    // drop site: it is named by its id, with no place or hour.
    scheduled: () => {
      const o = orderOccurrence(terms, f);

      return o
        ? {
          occurrence: o.id, site: o.series, siteName: o.name, kind: o.kind,
          window: o.window, place: o.place,
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
