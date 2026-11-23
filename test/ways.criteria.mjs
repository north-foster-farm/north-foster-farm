// Criteria tests for #823, phase 9 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 9: the way cards and the
// redraw"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/ways.criteria.mjs test/ways.test.mjs
//
// All twelve criteria are of the new-module kind: they fail on `next`,
// where form/ways.mjs does not exist, and pass once the phase draws
// the cards' facts out of their renderers. Nothing retires: the tests
// that stay green test libraries that do not move.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape and key names may be
// adapted, the expected values may not). The words are today's, byte
// for byte.
//
//   scheduledCard(choices)
//     choices  the lists' scheduled pickups
//     ->       { disabled, where }: where in locationsLabel's words
//
//   groupCard({ series, location, rounds, now, timeZone })
//     series    the model's record of the group's series
//     location  the model's record of its place
//     rounds    the lists' rounds of the group, or null before the
//               lists come
//     ->        { heading, when, where, closing, disabled }
//
//   windowsPlan({ windows, current, lists })
//     windows  the chosen day's windows ([{ id, ... }])
//     current  the time chosen, or wanted, or null
//     lists    the lists have come
//     ->       { pick, none }: none the words for a day without
//              windows, or ""
//
//   zipNote({ zip, area, lines, money })
//     lines  the cart's lines with their groupKey
//     ->     { text, warning }
//
//   creditNote(totals)  -> { text, hidden, covered }

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import places from "../data/locations.json" with { type: "json" };
import rhythms from "../data/series.json" with { type: "json" };
import { buildModel } from "../assets/scripts/order/lib/events.mjs";
import {
  nextRoundOpens, ordersClose, roundsWhen,
} from "../assets/scripts/order/lib/group.mjs";
import { moneyOn } from "../assets/scripts/order/lib/money-on.mjs";
import {
  locationCount, locationsLabel,
} from "../assets/scripts/order/lib/scheduled.mjs";
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import { zipInfo } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { assertPure } from "./pure-module.mjs";
import {
  creditNote, groupCard, scheduledCard, windowsPlan, zipNote,
} from "../assets/scripts/order/form/ways.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/ways.mjs", import.meta.url
);
const ZONE = terms.timeZone;
const model = buildModel(places.locations, rhythms.series);
const groupSeries = rhythms.series.find((s) => s.kind === "group");
const SERIES = model.seriesOf(groupSeries.code);
const PLACE = model.location(groupSeries.location);
const NOW = instant("2026-12-01", 9, 0, ZONE);
const ROUNDS = [
  { id: `${SERIES.code}-2026-12-06`, date: "2026-12-06",
    cutoff: instant("2026-12-04", 12, 0, ZONE).toISOString() },
  { id: `${SERIES.code}-2026-12-20`, date: "2026-12-20",
    cutoff: instant("2026-12-18", 12, 0, ZONE).toISOString() },
];
const card = (rounds) => groupCard({
  series: SERIES, location: PLACE, rounds, now: NOW, timeZone: ZONE,
});

// Box 1 of #823.
describe("scheduledCard", () => {
  it("with an empty list cannot be chosen; with pickups it counts their "
    + "locations in locationsLabel's words", () => {
    assert.equal(scheduledCard([]).disabled, true);

    const two = [
      { id: "a-1", series: "a", location: "L1" },
      { id: "a-2", series: "a", location: "L1" },
      { id: "b-1", series: "b", location: "L2" },
    ];
    const listed = scheduledCard(two);

    assert.equal(listed.disabled, false);
    assert.equal(listed.where, locationsLabel(locationCount(two)));
    assert.equal(listed.where, "2 locations");
    assert.equal(scheduledCard(two.slice(0, 1)).where, "1 location");
  });
});

// Box 2 of #823.
describe("groupCard, a round open", () => {
  it("gives the series' rhythm for When and the first round's closing "
    + "line", () => {
    const open = card(ROUNDS);

    assert.equal(open.when, roundsWhen(SERIES));
    assert.equal(open.closing, ordersClose(ROUNDS[0].cutoff, ZONE));
    assert.equal(open.heading, "Group orders");
    assert.equal(open.disabled, false);
  });
});

// Box 3 of #823.
describe("groupCard, none open", () => {
  it("marks the heading \"no open group order\", gives the day the next "
    + "round opens for When, and cannot be chosen", () => {
    const closed = card([]);

    assert.equal(closed.heading, "Group orders · no open group order");
    assert.equal(closed.when, nextRoundOpens(SERIES, NOW, ZONE));
    assert.equal(closed.disabled, true);
    assert.ok(!closed.closing);
  });
});

// Box 4 of #823.
describe("groupCard, before the lists", () => {
  it("reads as open before the lists come", () => {
    const loading = card(null);

    assert.equal(loading.heading, "Group orders");
    assert.equal(loading.when, roundsWhen(SERIES));
    assert.equal(loading.disabled, false);
  });
});

// Box 5 of #823.
describe("groupCard, Where", () => {
  it("is the place's short name, or its name and city", () => {
    assert.equal(groupCard({
      series: SERIES, location: { ...PLACE, short: "The gym" },
      rounds: ROUNDS, now: NOW, timeZone: ZONE,
    }).where, "The gym");
    assert.equal(groupCard({
      series: SERIES,
      location: { ...PLACE, short: "", name: "Gym", city: "Foster" },
      rounds: ROUNDS, now: NOW, timeZone: ZONE,
    }).where, "Gym, Foster");
    assert.equal(groupCard({
      series: SERIES, location: { ...PLACE, short: "", name: "Gym",
        city: "" },
      rounds: ROUNDS, now: NOW, timeZone: ZONE,
    }).where, "Gym");
  });
});

const WINDOWS = [{ id: "10:00-12:00" }, { id: "13:00-15:00" }];

// Box 6 of #823.
describe("windowsPlan, the chosen time", () => {
  it("keeps the chosen time when the new day has it, and chooses none "
    + "otherwise", () => {
    assert.equal(windowsPlan({ windows: WINDOWS, current: "13:00-15:00",
      lists: true }).pick, "13:00-15:00");
    assert.equal(windowsPlan({ windows: WINDOWS, current: "16:00-18:00",
      lists: true }).pick, null);
    assert.equal(windowsPlan({ windows: WINDOWS, current: null,
      lists: true }).pick, null);
  });
});

// Box 7 of #823.
describe("windowsPlan, a day with no windows", () => {
  it("says \"No pick-up times on this day.\" once the lists are here, and "
    + "\"Loading times…\" before", () => {
    assert.equal(windowsPlan({ windows: [], current: null, lists: true })
      .none, "No pick-up times on this day.");
    assert.equal(windowsPlan({ windows: [], current: null, lists: false })
      .none, "Loading times…");
    assert.ok(!windowsPlan({ windows: WINDOWS, current: null, lists: true })
      .none);
  });
});

const money = moneyOn(terms.money, "2026-12-01");
const eggs = [{ sku: "NFF-CHK-EGG-LG", qty: 2, groupKey: "eggs" }];
const note = (zip, lines = eggs) => zipNote({
  zip, area: terms.area, lines, money,
});

// Box 8 of #823.
describe("zipNote, outside the area", () => {
  it("says so and is marked as a warning", () => {
    assert.equal(zipInfo("10001", terms.area).status, "outside");

    const outside = note("10001");

    assert.equal(outside.text, "That's outside our delivery area. "
      + "On-farm pickup and our pick-up days are open to everyone.");
    assert.equal(outside.warning, true);
  });
});

// Box 9 of #823.
describe("zipNote, an unlisted ZIP", () => {
  it("names the extra fee from the day's prices", () => {
    const zip = "02899";

    assert.equal(zipInfo(zip, terms.area).status, "unlisted");
    for (const outsideAreaFee of [money.outsideAreaFee, 7]) {
      const unlisted = zipNote({
        zip, area: terms.area, lines: eggs,
        money: { ...money, outsideAreaFee },
      });

      assert.equal(unlisted.text, "A little outside our usual area: "
        + `delivery is $${outsideAreaFee} more. If we can't get to your `
        + "address, we'll call, text, or email you.");
      assert.equal(unlisted.warning, false);
    }
  });
});

// Box 10 of #823.
describe("zipNote, a state that takes only some products", () => {
  it("names them and the state, and is marked as a warning", () => {
    const state = terms.area.states.find((s) => s.onlyGroups);
    const zip = state.towns[0].zips[0];
    const lines = [...eggs,
      { sku: "NFF-CHK-WNG", qty: 1, groupKey: "chicken" }];
    const limited = note(zip, lines);

    assert.equal(limited.text, `We can only deliver ${
      state.onlyGroups.join(" and ")} to ${state.name} for now. Remove the `
      + "chicken, or choose pickup.");
    assert.equal(limited.warning, true);

    // Only what it takes: its own note, not a warning.
    const fine = note(zip, eggs);

    assert.equal(fine.text, state.note);
    assert.equal(fine.warning, false);
  });
});

// Box 11 of #823.
describe("creditNote, a family order", () => {
  it("says there is nothing to pay on a family order with nothing to pay, "
    + "and is covered", () => {
    const family = creditNote({ credit: 0, total: 0,
      discountPerk: "family" });

    assert.equal(family.text, "There's nothing to pay on this order.");
    assert.equal(family.hidden, false);
    assert.equal(family.covered, true);
  });
});

// Box 12 of #823.
describe("creditNote, credit", () => {
  it("says what credit that covers the order covers, what comes off and "
    + "what is left for part, and hides the note with no credit", () => {
    const whole = creditNote({ credit: 2800, total: 0 });

    assert.equal(whole.text,
      `Your credit covers this order: ${dollars(2800)}, nothing to pay.`);
    assert.equal(whole.covered, true);
    assert.equal(whole.hidden, false);

    const part = creditNote({ credit: 1000, total: 1800 });

    assert.equal(part.text, `${dollars(1000)} of your credit comes off; ${
      dollars(1800)} to pay.`);
    assert.equal(part.covered, false);
    assert.equal(part.hidden, false);

    const none = creditNote({ credit: 0, total: 1800 });

    assert.equal(none.hidden, true);
    assert.equal(none.covered, false);
    assert.equal(creditNote(null).hidden, true);
  });
});

describe("design, phase 9", () => {
  it("keeps form/ways.mjs pure", () => {
    assertPure(MODULE, {
      banned: ["(?<![.\\w])document(?=\\.)", "(?<![.\\w])window(?=\\.)",
        "querySelector", "Element"],
      imports: null,
    });
  });
});
