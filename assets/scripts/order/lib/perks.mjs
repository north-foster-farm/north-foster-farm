// Customer perks (#514; James, 2026-10-29): something the farm grants
// one customer, stored on their record (`customer.perks`), set with
// `bin/nff perks`, and applied by the order path whenever that
// customer orders, signed in on the page or entered by the farm.
// Shared by the page, which shows them, and the functions, which
// decide.
//
// Each perk on the record is
//   { type, start, end, setBy, setAt, removedAt?, removedBy? }
// `start` and `end` are days (YYYY-MM-DD) in the farm's zone; `end` is
// the last day it applies, or null for one that lasts until the farm
// removes it. A removed perk stays on the record, so the record keeps
// its history; it simply stops applying, as an expired one does.
//
// A customer may hold more than one. What each does:
//   free-delivery   no delivery fee (nor the outside-area fee)
//   minimum-waived  a delivery below the minimum is accepted
//   friends         the Friends and Fam amounts off each item, plus
//                   free delivery and the minimum waived
//   family          100% off, plus free delivery and the minimum
//                   waived: the order is recorded and nothing is
//                   charged. James alone sets it.
// Free delivery is not a discount, so it goes with any discount; the
// two discounts compete with every other one and the larger wins
// (lib/totals.mjs).

export const PERKS = {
  "free-delivery": { lifts: ["fee"] },
  "minimum-waived": { lifts: ["minimum"] },
  friends: { lifts: ["fee", "minimum"], discount: "friends" },
  family: { lifts: ["fee", "minimum"], discount: "family", owner: true },
};

export const PERK_TYPES = Object.keys(PERKS);

export const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Whether a perk applies on `day` (YYYY-MM-DD, the farm's zone).
export const perkActive = (perk, day) => !!perk && !!PERKS[perk.type]
  && !perk.removedAt
  && (!perk.start || perk.start <= day)
  && (!perk.end || day <= perk.end);

export const perksOf = (customer) =>
  (customer && Array.isArray(customer.perks) ? customer.perks : []);

// The perks that apply on `day`, one per type.
export const activePerks = (customer, day) => {
  const seen = new Set();

  return perksOf(customer).filter((p) => {
    if (!perkActive(p, day) || seen.has(p.type)) return false;
    seen.add(p.type);

    return true;
  });
};

// What a set of perk types does to an order. -> { types, fee, minimum,
// friends, family }: the known types held, whether the delivery fee
// and the minimum are lifted, and which discounts may compete.
export const perkEffects = (types) => {
  const held = [...new Set((Array.isArray(types) ? types : [])
    .filter((t) => PERKS[t]))];
  const lifts = new Set(held.flatMap((t) => PERKS[t].lifts));

  return {
    types: held,
    fee: lifts.has("fee"),
    minimum: lifts.has("minimum"),
    friends: held.includes("friends"),
    family: held.includes("family"),
  };
};

// The public shape of a perk, for /api/me and the account page.
export const publicPerk = (perk) => ({
  type: perk.type, start: perk.start || null, end: perk.end || null,
});

// What the customer reads (#717, James, 2026-11-21). A bundled perk
// is one pricing label with an info button, whose tooltip lists its
// parts; a later group that adds several discounts takes the same
// form, with its own name and parts. A standalone perk is a badge of
// its own.
const NAMES = {
  "free-delivery": "Free delivery",
  "minimum-waived": "No order minimum",
  friends: "Friends and family pricing",
  family: "Family pricing",
};

const PARTS = {
  friends: ["Friends and family discount", "Free delivery",
    "No order minimum"],
  family: ["Family discount", "Free delivery", "No order minimum"],
};

// A perk type's label, with no date: "Friends and family pricing".
export const perkName = (type) => NAMES[type] || type;

// A bundled perk's parts, or null for a standalone one.
export const perkParts = (type) => PARTS[type] || null;

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// "through the end of 2027" for a perk ending on December 31,
// "through March 3, 2027" otherwise.
const through = (end) => {
  const [y, m, d] = end.split("-").map(Number);

  return m === 12 && d === 31 ? `through the end of ${y}`
    : `through ${MONTHS[m - 1]} ${d}, ${y}`;
};

// One line for a perk, as the customer sees it: "Free delivery
// through the end of 2027" or "Free delivery". A fragment, so no end
// punctuation (#514, 2026-11-02).
export const perkSentence = (perk) => {
  const name = perkName(perk.type);

  return perk.end && DAY.test(perk.end) ? `${name} ${through(perk.end)}`
    : name;
};

// What a customer's perks show as (#717), in the cart note and the
// account page's "Your pricing" row: one line per bundled perk,
// `{ text, name, parts }`, then the standalone perks on one line,
// `{ labels }`, which the page separates with the discount badges'
// dot. `dates` keeps each end date beside its label, as the account
// row does; the cart shows none (James, on #717). Unknown types show
// nothing.
export const perkLines = (perks, { dates = false } = {}) => {
  const known = (Array.isArray(perks) ? perks : [])
    .filter((p) => p && PERKS[p.type]);
  const text = (p) => (dates ? perkSentence(p) : perkName(p.type));
  const bundles = known.filter((p) => perkParts(p.type)).map((p) => ({
    text: text(p), name: perkName(p.type), parts: perkParts(p.type),
  }));
  const labels = known.filter((p) => !perkParts(p.type)).map(text);

  return labels.length ? [...bundles, { labels }] : bundles;
};
