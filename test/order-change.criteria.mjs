// Criteria tests for #836, phase 4 of the split of account/main.js
// (docs/refactors/account.md, "Phase 4: changing, canceling,
// reporting"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/order-change.criteria.mjs test/order-change.test.mjs
//
// All eight criteria are of the new-module kind: they fail on `next`,
// where account/lib/change.mjs does not exist, and pass once the phase
// draws the change panel's decisions out. Nothing retires: the tests
// that stay green test libraries that do not move.
//
// Contract (the design names the functions and their module, not
// their arguments or what they return; these are the test agent's
// choice; the call shape and keys may be adapted, the expected values
// may not). `order` is /api/account/orders' record; `dates` the list
// /api/dates (or /api/group, for a round) gives for its way.
//
//   changeKind(order)  -> "delivery" | "onfarm" | "scheduled" | "round"
//   dateOptions({ order, dates, dropSeries })
//     -> { options: [{ value, label }], pick }
//   pickupChoices({ order, dates, roundSeries })
//     -> { choices: scheduledChoice's records, pick }
//   windowChoices({ order, dates, date, current })
//     date     the day chosen; current  the time chosen, or null
//     -> { windows: [{ id, label }], pick }
//   changeBody({ order, values })
//     values  the panel's fields: notes, occurrence, date, cooler,
//             gate, dnotes, window
//     -> the body posted to /change
//   cancelWords({ keptFee, status })
//     status  the status the cancel's answer gives the order
//     -> { explain, thanks }

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cancelWords, changeBody, changeKind, dateOptions, pickupChoices,
  windowChoices,
} from "../assets/scripts/account/lib/change.mjs";
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import { label } from "../assets/scripts/order/lib/zoned.mjs";
import { assertPure } from "./pure-module.mjs";

const DROP = "VFVQ";
const ROUND = "36TS";
const delivery = { fulfilment: { method: "delivery", date: "2026-12-10",
  delivery: { cooler: "Porch", gate: "1234", notes: "Ring" } } };
const onfarm = { fulfilment: { method: "onfarm", date: "2026-12-12",
  onfarm: { window: "10:00-12:00", from: "10:00", to: "12:00" } } };
const pickupAt = (occurrence, more = {}) => ({
  fulfilment: { method: "scheduled", occurrence, date: "2026-12-12" },
  pickup: { occurrence, series: occurrence.split("-")[0],
    name: "Foster Farmers’ Market", window: "9:00 AM – 1:00 PM",
    location: "D8RW", ...more },
});
const entry = (occurrence, more = {}) => ({
  occurrence, date: "2026-12-12", label: label("2026-12-12"),
  series: occurrence.split("-")[0], name: "Somewhere",
  window: "9:00 AM – 1:00 PM", location: "D8RW", ...more,
});

// Box 1 of #836.
describe("changeKind", () => {
  it("tells a delivery, an on-farm pickup, a pickup day and a group's "
    + "round apart", () => {
    assert.equal(changeKind(delivery), "delivery");
    assert.equal(changeKind(onfarm), "onfarm");
    assert.equal(changeKind(pickupAt("WAC5-261212")), "scheduled");
    assert.equal(changeKind(pickupAt(`${ROUND}-261212`, { group: "vff" })),
      "round");
  });
});

// Box 2 of #836.
describe("dateOptions", () => {
  it("lists the open dates; a booked date no longer open is put first, "
    + "marked (as booked), and chosen", () => {
    const open = [{ date: "2026-12-10", label: "Thursday, December 10" },
      { date: "2026-12-17", label: "Thursday, December 17" }];
    const listed = dateOptions({ order: delivery, dates: open,
      dropSeries: DROP });

    assert.deepEqual(listed.options, open.map((d) => ({ value: d.date,
      label: d.label })));
    assert.equal(listed.pick, "2026-12-10");

    const moved = dateOptions({ order: delivery, dates: open.slice(1),
      dropSeries: DROP });

    assert.deepEqual(moved.options[0], { value: "2026-12-10",
      label: `Delivery, ${label("2026-12-10")} (as booked)` });
    assert.deepEqual(moved.options.slice(1), [{ value: "2026-12-17",
      label: "Thursday, December 17" }]);
    assert.equal(moved.pick, "2026-12-10");
  });
});

// Box 3 of #836.
describe("pickupChoices, what is offered", () => {
  it("offers a round the group's open rounds, and a pickup day every open "
    + "pickup except the group's", () => {
    const rounds = [entry(`${ROUND}-261212`), entry(`${ROUND}-261226`)];
    const round = pickupAt(`${ROUND}-261212`, { group: "vff" });

    assert.deepEqual(pickupChoices({ order: round, dates: rounds,
      roundSeries: ROUND }).choices.map((c) => c.value),
    rounds.map((r) => r.occurrence));

    const open = [entry("WAC5-261212"), entry(`${ROUND}-261212`),
      entry("H3TQ-261215")];

    assert.deepEqual(pickupChoices({ order: pickupAt("WAC5-261212"),
      dates: open, roundSeries: ROUND }).choices.map((c) => c.value),
    ["WAC5-261212", "H3TQ-261215"]);
  });
});

// Box 4 of #836.
describe("pickupChoices, a booked pickup gone", () => {
  it("adds a booked pickup no longer open, marked (as booked), and chooses "
    + "it", () => {
    const { choices, pick } = pickupChoices({
      order: pickupAt("WAC5-261205"), dates: [entry("WAC5-261212")],
      roundSeries: ROUND,
    });
    const booked = choices.find((c) => c.value === "WAC5-261205");

    assert.ok(booked, "the booked pickup is offered");
    assert.equal(booked.window, "9:00 AM – 1:00 PM (as booked)");
    assert.equal(pick, "WAC5-261205");
    assert.ok(choices.some((c) => c.value === "WAC5-261212"));
  });
});

const DAY = { date: "2026-12-12", windows: [
  { id: "10:00-12:00", from: "10:00", to: "12:00" },
  { id: "13:00-15:00", from: "13:00", to: "15:00" },
] };

// Box 5 of #836.
describe("windowChoices, the day's windows", () => {
  it("gives the day's windows and keeps the chosen time where the day has "
    + "it, else takes the first", () => {
    const at = (current) => windowChoices({ order: onfarm, dates: [DAY],
      date: DAY.date, current });

    assert.deepEqual(at("13:00-15:00").windows.map((w) => w.id),
      ["10:00-12:00", "13:00-15:00"]);
    assert.equal(at("13:00-15:00").pick, "13:00-15:00");
    assert.equal(at("16:00-18:00").pick, "10:00-12:00");
    assert.equal(at(null).pick, "10:00-12:00", "the booked one, here first");
  });
});

// Box 6 of #836.
describe("windowChoices, a booked day gone", () => {
  it("offers only the booked time, marked (as booked), for a booked day the "
    + "schedule no longer has", () => {
    const gone = windowChoices({ order: onfarm, dates: [], date: "2026-12-12",
      current: null });

    assert.equal(gone.windows.length, 1);
    assert.equal(gone.windows[0].id, "10:00-12:00");
    assert.match(gone.windows[0].label, / \(as booked\)$/);
    assert.equal(gone.pick, "10:00-12:00");
    assert.deepEqual(windowChoices({ order: onfarm, dates: [],
      date: "2026-12-19", current: null }).windows, [], "another day");
  });
});

// Box 7 of #836.
describe("changeBody", () => {
  it("posts an occurrence for a scheduled pickup and a date for the rest, "
    + "the cooler, gate and notes for a delivery, and the window for "
    + "on-farm pickup", () => {
    const values = { notes: "Thanks", occurrence: "WAC5-261219",
      date: "2026-12-17", cooler: "Garage", gate: "4321", dnotes: "Knock",
      window: "13:00-15:00" };

    assert.deepEqual(changeBody({ order: pickupAt("WAC5-261212"), values }),
      { notes: "Thanks", method: "scheduled", occurrence: "WAC5-261219" });
    assert.deepEqual(changeBody({ order: delivery, values }), {
      notes: "Thanks", date: "2026-12-17",
      delivery: { cooler: "Garage", gate: "4321", notes: "Knock" },
    });
    assert.deepEqual(changeBody({ order: onfarm, values }), {
      notes: "Thanks", date: "2026-12-17", onfarm: { window: "13:00-15:00" },
    });
  });
});

// Box 8 of #836.
describe("cancelWords", () => {
  it("explains the kept fee when there is one, and thanks by whether the "
    + "order was canceled or only flagged", () => {
    assert.equal(cancelWords({ keptFee: 500, status: "cancelled" }).explain,
      `The delivery fee of ${dollars(500)} isn't refunded because we made `
      + "the trip. We'll refund the rest the way you paid, usually within a "
      + "few business days.");
    assert.equal(cancelWords({ keptFee: 0, status: "cancelled" }).explain,
      "We'll refund you the way you paid, usually within a few business "
      + "days.");
    assert.equal(cancelWords({ keptFee: 0, status: "cancelled" }).thanks,
      "Your order's canceled, and your refund is on its way.");
    assert.equal(cancelWords({ keptFee: 0, status: "paid" }).thanks,
      "We've received your cancellation request. We'll refund you the way "
      + "you paid and email you when it's done.");
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/change.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/change.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element"] });
  });
});
