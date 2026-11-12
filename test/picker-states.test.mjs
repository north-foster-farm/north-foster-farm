// The pickup picker's hard states (#573) for staging and deploy
// previews: staging/picker-states.mjs, which the switcher and the
// screenshot spec share. That production never carries the switcher is
// test/staging-build.test.mjs; here, that no production script
// imports it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CLOSING_MS, LOADING_MS, SAMPLE_ORDER, STATES, answerAt, dropCodeOf,
  isState, openList, publicPlaces, sampleRound, stateParts, withSharedDay,
} from "../assets/scripts/staging/picker-states.mjs";
import {
  bookedEntry, resolveChoice,
} from "../assets/scripts/order/lib/picker.mjs";
import {
  draftOccurrence, scheduledChoices,
} from "../assets/scripts/order/lib/scheduled.mjs";

const root = join(import.meta.dirname, "..");
const data = (name) =>
  JSON.parse(readFileSync(join(root, "data", `${name}.json`), "utf8"));
const { locations } = data("locations");
const { series } = data("series");
const ZONE = "America/New_York";
// Thursday, November 12, 2026, noon in New York.
const NOW = new Date("2026-11-12T17:00:00Z");
const LIST = openList({ now: NOW, timeZone: ZONE, locations, series });
const DROP = dropCodeOf(series);
const parts = (key) => stateParts(key, {
  now: NOW, timeZone: ZONE, list: LIST, dropCode: DROP, sku: "NFF-SKU",
});

describe("the picker states' lists", () => {
  it("name every state once, and only those", () => {
    const keys = STATES.map((s) => s.key);

    assert.equal(new Set(keys).size, keys.length);
    assert.ok(isState("closing"));
    assert.ok(!isState("off"));
  });

  it("keep a buying group's place and series out (#471)", () => {
    const places = publicPlaces({ locations, series });

    assert.ok(places.series.every((s) => !s.group));
    assert.ok(places.locations.every((l) => !l.private));
    assert.ok(LIST.every((d) => !series.find((s) => s.code === d.series)
      .group));
  });

  it("offer what is open from tomorrow through the horizon", () => {
    assert.ok(LIST.length > 0);
    assert.ok(LIST.every((d) => d.date > "2026-11-12"
      && d.date <= "2026-11-21"));
    assert.ok(LIST.every((d) => Date.parse(d.cutoff) > NOW.getTime()));
  });

  it("show one place only", () => {
    const one = parts("one").scheduled;

    assert.ok(one.length > 0);
    assert.equal(new Set(one.map((d) => d.series)).size, 1);
    assert.equal(one[0].series, DROP);
  });

  it("show a day with two places, moving one there if need be", () => {
    const shared = parts("shared").scheduled;
    const twice = shared.find((d) => new Set(shared
      .filter((x) => x.date === d.date).map((x) => x.location)).size > 1);

    assert.ok(twice, "a day with two places");

    const apart = LIST.filter((d, i, all) => all
      .findIndex((x) => x.location === d.location) === i).slice(0, 2)
      .map((d, i) => ({ ...d, date: `2026-11-1${4 + i}` }));
    const moved = withSharedDay(apart, ZONE);

    assert.equal(moved[0].date, moved[1].date);
    assert.match(moved[1].occurrence, /-261114$/);
  });

  it("add a sample group's round 60 days out, marked a round", () => {
    const round = parts("group").scheduled.at(-1);

    assert.deepEqual(round, sampleRound(NOW, ZONE));
    assert.equal(round.date, "2027-01-11");
    assert.equal(round.round, true);
  });

  it("close the chosen pickup half a minute on", () => {
    const { scheduled, draft } = parts("closing");
    const [soon] = scheduled;

    assert.equal(draft.occurrence, soon.occurrence);
    assert.equal(Date.parse(soon.cutoff), NOW.getTime() + CLOSING_MS);
    assert.equal(answerAt(scheduled, NOW.getTime()).length, scheduled.length);
    assert.ok(!answerAt(scheduled, NOW.getTime() + CLOSING_MS)
      .some((d) => d.occurrence === soon.occurrence));
  });

  it("restore an old draft whose drop site date has moved", () => {
    const { draft, scheduled } = parts("moved");
    const pick = resolveChoice({
      list: scheduledChoices(scheduled),
      want: draftOccurrence(draft, DROP), series: DROP,
    });

    assert.equal(draft.method, "scituate");
    assert.ok(pick.value.startsWith(`${DROP}-`));
    assert.match(pick.note, /^Your saved pickup on /);
  });

  it("open ?edit= on a sample order whose pickup has gone: As booked", () => {
    const { order, scheduled } = parts("edit");
    const booked = bookedEntry(order);

    assert.equal(order.id, SAMPLE_ORDER);
    assert.deepEqual(order.lines, [{ sku: "NFF-SKU", qty: 1 }]);
    assert.ok(!scheduled.some((d) => d.occurrence === booked.value));
    assert.deepEqual(resolveChoice({
      list: scheduledChoices(scheduled), want: booked.value, booked,
    }), { value: booked.value, note: "", booked: true });
  });

  it("lapse the chosen pickup in the dialog", () => {
    const { lapse, draft } = parts("lapsed");

    assert.equal(draft.occurrence, lapse.occurrence);
  });

  it("show nothing, a slow load and a failed one", () => {
    assert.deepEqual(parts("nothing").scheduled, []);
    assert.equal(parts("loading").delay, LOADING_MS);
    assert.ok(LOADING_MS < 10_000, "inside skeleton.js's give-up");
    assert.equal(parts("failed").scheduled, null);
    assert.equal(answerAt(null, NOW.getTime()), null);
  });
});

describe("the picker states in production", () => {
  // Only the switcher's own files may import it, and only the partial
  // that renders on staging and previews builds the switcher.
  it("are imported by no script but the switcher", () => {
    const dir = join(root, "assets", "scripts");
    const users = readdirSync(dir, { recursive: true })
      .filter((f) => /\.m?js$/.test(f))
      .filter((f) => /picker-states/.test(readFileSync(join(dir, f), "utf8")))
      .sort();

    assert.deepEqual(users, [
      join("staging", "picker-states.js"),
      join("staging", "picker-states.mjs"),
    ]);
  });

  it("are built by one partial, gated on Netlify's context", () => {
    const layouts = join(root, "layouts");
    const users = readdirSync(layouts, { recursive: true })
      .filter((f) => f.endsWith(".html"))
      .filter((f) => /picker-states/.test(readFileSync(join(layouts, f),
        "utf8")))
      .sort();
    const partial = readFileSync(join(layouts, "partials", "staging",
      "picker-states.html"), "utf8");

    assert.deepEqual(users, [
      join("_default", "baseof.html"),
      join("partials", "staging", "picker-states.html"),
    ]);
    assert.match(partial,
      /in \(slice "branch-deploy" "deploy-preview"\) \$context/);
  });
});
