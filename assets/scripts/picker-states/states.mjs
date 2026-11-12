// The pickup picker's hard states (#574), for James to judge the
// running mockup at every width: the staging and preview switcher
// (picker-states/main.js) and the screenshot spec
// (e2e/picker-states.spec.mjs) both build them here, so the two show
// the same thing. Never in a production build: only the switcher's
// bundle and the spec import this, and partials/staging/
// picker-states.html builds the switcher only on a branch deploy or
// a deploy preview (bin/check-staging.mjs holds production to that).
//
// Each state is a `scheduled` list for /api/dates, made from the
// farm's real series and locations (data/series.json,
// data/locations.json) by the same model the functions use
// (lib/events.mjs), on dates counted from today, so the entries have
// the API's shape and the real places' names and addresses. Some
// states add a draft, or a signed-in customer with a paid order, for
// the page to open with. The labels are for James, not customers.

import { buildModel, cutoffOf, occurrenceOf } from "../order/lib/events.mjs";
import { addDays, label, today, weekday } from "../order/lib/zoned.mjs";

export const KEY = "nff.picker-state";

// The order a state that needs one opens: as /api/account/orders
// sends it (e2e/support/canned.mjs ORDER_SCHEDULED), on the drop site.
export const ORDER_ID = "NFF-PICK-STATE";

export const STATES = [
  { key: "one", label: "One place only" },
  { key: "several", label: "Several places" },
  { key: "two", label: "A day with two places" },
  { key: "round", label: "A group round 40 days out" },
  { key: "closing", label: "A chosen pickup that closes in 45 s" },
  { key: "moved", label: "A draft whose date moved" },
  { key: "edit", label: "?edit= with As booked", page: "edit" },
  { key: "account", label: "Account Change pickup, As booked",
    page: "account" },
  { key: "lapsed", label: "Lapsed dialog (presses Pay)" },
  { key: "none", label: "Nothing available" },
  { key: "loading", label: "Loading" },
  { key: "failed", label: "A failed load" },
];

export const stateOf = (key) => STATES.find((s) => s.key === key) || null;

// The next date after `from` on a weekday (0 Sunday to 6 Saturday),
// `n` of them on (1 the first).
const next = (from, day, n = 1) => {
  const ahead = (day - weekday(from) + 7) % 7 || 7;

  return addDays(from, ahead + 7 * (n - 1));
};

// The farm's places to show: its drop site, a market and a pop-up,
// and a buying group's series for the round when it has one. A state
// that wants a place the data lacks goes without it.
export const placesOf = (model) => {
  const of = (test) => model.series.find((s) => test(s)
    && model.location(s.location)) || null;

  return {
    drop: of((s) => s.kind === "drop-site"),
    market: of((s) => s.kind === "market" && !s.group),
    popup: of((s) => s.kind === "pop-up" && !s.group),
    round: of((s) => s.group) || of((s) => s.kind === "pop-up"),
  };
};

// An /api/dates `scheduled` entry for a series on a date, as the
// functions read an occurrence (lib/dates.mjs read).
export const entryOf = (model, s, date, timeZone, cutoff = null) => {
  const o = occurrenceOf(model, s, date);

  return {
    date, label: label(date), occurrence: o.id, series: o.series,
    name: o.name, location: o.location, town: o.town, place: o.place,
    short: o.short, window: o.window,
    cutoff: cutoff || cutoffOf(date, timeZone).toISOString(),
  };
};

// What a state needs, from the series and locations the page embeds,
// at `now`: -> { scheduled, draft, order, failed, loading }. `scheduled`
// is null for a state that answers no list; `draft` is the order
// draft to restore; `order` the paid order to change; `sku` an item a
// draft that pays may hold.
export const build = (key, {
  series, locations, now = new Date(), timeZone = "America/New_York",
  sku = "",
}) => {
  const model = buildModel(locations, series);
  const p = placesOf(model);
  const start = today(now, timeZone);
  const at = (s, date, cutoff) => (s
    ? [entryOf(model, s, date, timeZone, cutoff)] : []);
  const sat = (n) => next(start, 6, n);
  const tue = (n) => next(start, 2, n);
  const base = [
    ...at(p.drop, sat(1)), ...at(p.drop, sat(2)),
    ...at(p.market, tue(1)), ...at(p.market, tue(2)),
  ];
  const sorted = (list) => list.slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const gone = () => p.drop && entryOf(model, p.drop, addDays(sat(1), -7),
    timeZone);
  const withOrder = () => ({
    scheduled: sorted(base), order: gone() && orderOf(gone()),
  });
  const plans = {
    one: () => ({
      scheduled: [...at(p.drop, sat(1)), ...at(p.drop, sat(2))],
    }),
    several: () => ({ scheduled: sorted(base) }),
    two: () => ({ scheduled: sorted([...base, ...at(p.popup, sat(2))]) }),
    round: () => ({
      scheduled: sorted([...base,
        ...at(p.round, next(addDays(start, 39), 0))]),
    }),
    // The market's first date closes 45 s from now; the page's timer
    // asks for the list again then, and it is gone (see `open`).
    closing: () => {
      const soon = new Date(now.getTime() + 45_000).toISOString();
      const closing = at(p.market, tue(1), soon);

      return {
        scheduled: sorted([...base.filter((e) =>
          !closing.some((c) => c.occurrence === e.occurrence)), ...closing]),
        draft: draft({
          method: "scheduled",
          occurrence: closing[0] && closing[0].occurrence,
        }),
      };
    },
    // A draft saved before scheduled pickup, on a drop site Saturday
    // gone by: it moves to the next, with the note.
    moved: () => ({
      scheduled: sorted(base),
      draft: draft({ method: "scituate", date: addDays(sat(1), -7) }),
    }),
    edit: withOrder,
    account: withOrder,
    // A drop site pickup on a day the drop site doesn't run: the page
    // lists it, so it is chosen, but the order's own check (as the
    // server's) finds it lapsed and raises the dialog, which presets
    // the drop site's next Saturday.
    lapsed: () => {
      const bad = at(p.drop, addDays(sat(1), weekday(start) === 5 ? 2 : -1));

      return {
        scheduled: sorted([...base, ...bad]),
        draft: draft({
          method: "scheduled", occurrence: bad[0] && bad[0].occurrence,
        }, sku),
      };
    },
    none: () => ({ scheduled: [] }),
    loading: () => ({ loading: true }),
    failed: () => ({ failed: true }),
  };

  return {
    scheduled: null, draft: null, order: null, failed: false,
    loading: false, ...(plans[key] ? plans[key]() : {}),
  };
};

// The entries of a list still open at `now`, as /api/dates would list
// them: the closing state's pickup leaves once its cutoff passes.
export const open = (list, now = new Date()) => (list || [])
  .filter((e) => Date.parse(e.cutoff) > now.getTime());

// An order draft (order/draft.js), with a customer to pay as when the
// draft is to reach the lapsed dialog.
const draft = (fulfilment, sku = "") => ({
  payload: {
    lines: sku ? [{ sku, qty: 1 }] : [],
    customer: sku ? {
      firstName: "Picker", lastName: "States",
      email: "picker-states@example.com",
    } : {},
    fulfilment,
  },
});

// A paid order holding a pickup the list no longer has, so the picker
// offers it "As booked": the account's shape (e2e/support/canned.mjs
// ORDER_SCHEDULED).
const orderOf = (entry) => ({
  id: ORDER_ID, status: "paid", submittedAt: `${entry.date}T00:00:00.000Z`,
  paidAt: `${entry.date}T00:00:05.000Z`, cancelRequested: false,
  lines: [], totals: { subtotal: 0, discountAmount: 0, deliveryFee: 0,
    total: 0 },
  code: null,
  customer: { firstName: "Picker", lastName: "States", phone: "",
    contact: "" },
  fulfilment: {
    method: "scheduled", occurrence: entry.occurrence, date: entry.date,
    state: "requested", onfarm: null,
  },
  pickup: {
    occurrence: entry.occurrence, series: entry.series, name: entry.name,
    place: entry.place, window: entry.window, gone: false,
  },
  notes: "", payments: [], refunds: [], returns: [], question: null,
  canCancel: true, canChange: true,
});

// The customer /api/me answers with for a state with an order.
export const CUSTOMER = {
  email: "picker-states@example.com", name: "Picker States",
  firstName: "Picker", lastName: "States", phone: "", avatar: null,
  discountGroup: null, address: null, reminders: {}, marketing: false,
};
