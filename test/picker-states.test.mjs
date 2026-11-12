// The pickup picker's hard states (#574): picker-states/states.mjs,
// which the staging and preview switcher and the screenshot spec build
// from the farm's real series and locations. That it never reaches a
// production build is test/staging-build.test.mjs's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  STATES, build, open, placesOf, stateOf,
} from "../assets/scripts/picker-states/states.mjs";
import { buildModel } from "../assets/scripts/order/lib/events.mjs";
import {
  nextAtSame, pickerWeeks, resolveChoice,
} from "../assets/scripts/order/lib/picker.mjs";
import {
  draftOccurrence, scheduledChoices,
} from "../assets/scripts/order/lib/scheduled.mjs";
import { weekday } from "../assets/scripts/order/lib/zoned.mjs";

const root = join(import.meta.dirname, "..");
const data = (name) =>
  JSON.parse(readFileSync(join(root, "data", `${name}.json`), "utf8"));
const series = data("series").series;
const locations = data("locations").locations;
const ZONE = "America/New_York";
// Thursday, November 12, 2026, midday in New York.
const NOW = new Date("2026-11-12T17:00:00Z");
const of = (key, extra = {}) => build(key, {
  series, locations, now: NOW, timeZone: ZONE, ...extra,
});
const model = buildModel(locations, series);
const drop = placesOf(model).drop;

describe("the picker's hard states", () => {
  it("are each built, every label once", () => {
    assert.equal(new Set(STATES.map((s) => s.key)).size, STATES.length);
    for (const state of STATES) assert.ok(of(state.key), state.key);
    assert.equal(stateOf("nope"), null);
  });

  it("list entries in the API's shape, in date order, after today", () => {
    const list = of("several").scheduled;

    assert.ok(list.length >= 2);
    for (const e of list) {
      for (const field of ["date", "label", "occurrence", "series", "name",
        "location", "window", "cutoff"]) {
        assert.ok(e[field], `${e.occurrence} has ${field}`);
      }
      assert.ok(e.date > "2026-11-12", e.date);
    }
    assert.deepEqual(list.map((e) => e.date),
      list.map((e) => e.date).sort());
  });

  it("one place only: the drop site's two Saturdays", () => {
    const list = of("one").scheduled;

    assert.deepEqual(list.map((e) => e.date), ["2026-11-14", "2026-11-21"]);
    assert.ok(list.every((e) => e.series === drop.code));
  });

  it("a day with two places", () => {
    const days = pickerWeeks(of("two").scheduled).flatMap((w) => w.days);

    assert.ok(days.some((d) => d.entries.length === 2));
  });

  it("a group round 40 to 60 days out, under a gap", () => {
    const list = of("round").scheduled;
    const last = list.at(-1);
    const out = (Date.parse(last.date) - Date.parse("2026-11-12")) / 864e5;

    assert.ok(out >= 40 && out <= 60, String(out));
    assert.equal(pickerWeeks(list).at(-1).gap, true);
  });

  it("a chosen pickup that closes: the draft's leaves the list at its " +
    "cutoff, and the same place's next date is offered", () => {
    const plan = of("closing");
    const chosen = plan.draft.payload.fulfilment.occurrence;
    const entry = plan.scheduled.find((e) => e.occurrence === chosen);
    const later = new Date(Date.parse(entry.cutoff) + 1000);
    const left = scheduledChoices(open(plan.scheduled, later));

    assert.ok(open(plan.scheduled, NOW).some((e) => e.occurrence === chosen));
    assert.ok(!left.some((e) => e.occurrence === chosen));
    assert.ok(nextAtSame(left, { ...entry, value: chosen }));
  });

  it("a draft whose date moved lands on the drop site's next, with " +
    "the note", () => {
    const plan = of("moved");
    const f = plan.draft.payload.fulfilment;
    const pick = resolveChoice({
      list: scheduledChoices(plan.scheduled),
      want: draftOccurrence(f, drop.code), series: drop.code,
    });

    assert.equal(pick.value, `${drop.code}-261114`);
    assert.match(pick.note, /^Your saved pickup on Saturday, November 7 /);
  });

  it("?edit= and the account hold a pickup the list lacks", () => {
    for (const key of ["edit", "account"]) {
      const plan = of(key);
      const held = plan.order.pickup.occurrence;

      assert.ok(plan.order.canChange);
      assert.ok(!plan.scheduled.some((e) => e.occurrence === held), key);
    }
    assert.equal(stateOf("edit").page, "edit");
    assert.equal(stateOf("account").page, "account");
  });

  it("the lapsed dialog: a drop site pickup on a day it doesn't run, " +
    "with a draft that can pay", () => {
    const plan = of("lapsed", { sku: "NFF-CHK-EGG-LG" });
    const f = plan.draft.payload.fulfilment;
    const bad = plan.scheduled.find((e) => e.occurrence === f.occurrence);

    assert.equal(bad.series, drop.code);
    assert.notEqual(weekday(bad.date), weekday(drop.start));
    assert.deepEqual(plan.draft.payload.lines,
      [{ sku: "NFF-CHK-EGG-LG", qty: 1 }]);
    assert.ok(plan.draft.payload.customer.email.endsWith("@example.com"));
  });

  it("nothing available, loading and a failed load", () => {
    assert.deepEqual(of("none").scheduled, []);
    assert.equal(of("loading").loading, true);
    assert.equal(of("failed").failed, true);
  });
});
