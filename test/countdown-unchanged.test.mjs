// A guard for the QA review on #957: sharing its timer with Group
// orders' close notice (#749) leaves Delivery's countdown as it was,
// in text and in timing, in the cases the countdown's own tests cover
// (countdown-forms, countdown-date and countdown-kept):
//
//   - 6 hours and 0 minutes out, no urgency, "soon" a minute later;
//   - 5 hours and 50 minutes out, "soon";
//   - 44 minutes out, "last", counting each 10 s;
//   - 1 minute out, the cutoff passing, the lists failing to come;
//   - 2 days, 2 hours and 0 minutes out;
//   - 13 days, 23 hours and 30 minutes out, Thanksgiving week skipped;
//   - no delivery day on offer.
//
// Each case runs from the instant those tests use, for three minutes
// of a mocked clock (90 s in the last hour), with the group's round
// open and without, and the notice's text and urgency are read every
// second. What it reads, and the second each text first shows, are
// what next's date-lists.js gives (checked against it on 2026-11-23,
// at origin/next 9b9799ab, before #957 lands): the count changes a
// whole tick after the last, each 60 s, or each 10 s in the last hour.
//
// The seam is the one test/countdown-date.test.mjs names: DateLists
// #apply(lists) with a form that holds the chip and its text, and
// #addRounds(entries, series) for the group's rounds.

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import deliveryTerms from "../data/delivery.json" with { type: "json" };
import { DateLists } from "../assets/scripts/order/date-lists.js";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";
import {
  addDays, today,
} from "../assets/scripts/order/lib/zoned.mjs";
import { groupDates } from "../netlify/functions/group.mjs";
import { groupOf } from "../netlify/functions/lib/groups.mjs";
import terms from "../netlify/functions/lib/terms.mjs";

const VFF = groupOf("vff");
const NOV19 = "Thursday, November 19";
const DEC3 = "Thursday, December 3";

const say = (count, label) =>
  `Order within ${count} for delivery on ${label}.`;

// [the instant, seconds watched, a day on offer?, what the notice
// reads: [second it first shows, text, urgency]...]
const CASES = [
  ["2026-11-18T10:59:30.000Z", 180, true, [
    [0, say("6 hours and 0 minutes", NOV19), undefined],
    [60, say("5 hours and 59 minutes", NOV19), "soon"],
    [120, say("5 hours and 58 minutes", NOV19), "soon"],
    [180, say("5 hours and 57 minutes", NOV19), "soon"],
  ]],
  ["2026-11-18T11:09:30.000Z", 180, true, [
    [0, say("5 hours and 50 minutes", NOV19), "soon"],
    [60, say("5 hours and 49 minutes", NOV19), "soon"],
    [120, say("5 hours and 48 minutes", NOV19), "soon"],
    [180, say("5 hours and 47 minutes", NOV19), "soon"],
  ]],
  ["2026-11-18T16:15:30.000Z", 90, true, [
    [0, say("44 minutes", NOV19), "last"],
    [40, say("43 minutes", NOV19), "last"],
  ]],
  ["2026-11-18T16:59:45.000Z", 60, true, [
    [0, say("1 minute", NOV19), "last"],
    [20, "We couldn't load the dates. Retrying…", undefined],
  ]],
  ["2026-11-16T14:59:30.000Z", 180, true, [
    [0, say("2 days, 2 hours, and 0 minutes", NOV19), undefined],
    [60, say("2 days, 1 hour, and 59 minutes", NOV19), undefined],
    [120, say("2 days, 1 hour, and 58 minutes", NOV19), undefined],
    [180, say("2 days, 1 hour, and 57 minutes", NOV19), undefined],
  ]],
  ["2026-11-18T17:29:30.000Z", 180, true, [
    [0, say("13 days, 23 hours, and 30 minutes", DEC3), undefined],
    [60, say("13 days, 23 hours, and 29 minutes", DEC3), undefined],
    [120, say("13 days, 23 hours, and 28 minutes", DEC3), undefined],
    [180, say("13 days, 23 hours, and 27 minutes", DEC3), undefined],
  ]],
  ["2026-11-18T11:09:30.000Z", 90, false, [
    [0, "Delivery ordering is closed right now.", undefined],
  ]],
];

// The group's open rounds at `now`, as /api/group lists them.
const rounds = (now) => groupDates(VFF, now, {
  PICKUP_SCHEDULE: `${addDays(today(now, terms.timeZone), 1)} 09:00-12:00`,
}).map((d) => ({ ...d, name: VFF.name }));

const made = [];

// The last run's page and clock stopped, so each run starts clean.
const stop = () => {
  for (const lists of made.splice(0)) {
    clearTimeout(lists.timer);
    clearTimeout(lists.closing);
    clearTimeout(lists.again);
  }
  mock.timers.reset();
};

// Delivery's notice and Group orders' close notice, in one form.
const page = () => {
  const chip = { dataset: {} };
  const text = { textContent: "" };
  const close = { dataset: {}, hidden: false, textContent: "" };

  close.querySelector = () => close;
  const form = {
    querySelector: (sel) => {
      if (sel === "[data-countdown]") return chip;
      if (sel === "[data-countdown-text]") return text;
      if (sel.includes("data-group-close")) return close;

      return null;
    },
    querySelectorAll: () => [],
  };

  return { form, chip, text };
};

const settle = () => new Promise((done) => setImmediate(done));

// The notice from `iso` for `seconds`: each change, with its second.
const watch = async (iso, seconds, offered, withRound) => {
  const start = Date.parse(iso);

  stop();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  globalThis.fetch = async () => {
    throw new Error("offline");
  };

  const { form, chip, text } = page();
  const lists = new DateLists(form, () => {});
  const delivery = offered
    ? deliveryDates(new Date(start), deliveryTerms) : [];

  made.push(lists);
  lists.apply({ now: iso, delivery, onfarm: [], scheduled: [] });
  if (withRound) lists.addRounds(rounds(new Date(start)), VFF.series);

  const seen = [];
  let last = null;
  const look = (s) => {
    const now = [text.textContent, chip.dataset.urgency];

    if (!last || now[0] !== last[0] || now[1] !== last[1]) {
      seen.push([s, ...now]);
    }
    last = now;
  };

  look(0);
  for (let s = 1; s <= seconds; s += 1) {
    mock.timers.tick(1000);
    await settle();
    look(s);
  }

  return seen;
};

const realFetch = globalThis.fetch;

afterEach(() => {
  stop();
  globalThis.fetch = realFetch;
});

describe("Delivery's countdown beside Group orders' (#957)", () => {
  it("reads and changes as on next in the countdown tests' cases, with "
    + "a group round open or not", async () => {
    for (const [iso, seconds, offered, expected] of CASES) {
      assert.ok(rounds(new Date(iso)).length > 0, `${iso}: a round open`);
      for (const withRound of [false, true]) {
        const label = `${iso}, ${withRound ? "a round open" : "no group"}`;

        assert.deepEqual(await watch(iso, seconds, offered, withRound),
          expected, label);
      }
    }
  });
});
