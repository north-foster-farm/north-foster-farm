// Criteria tests for #749's two "Close notice" boxes (James,
// 2026-11-23, wording approved final): the Group orders close notice
// matches the delivery countdown exactly, with "for delivery" becoming
// "to join the current group order", a live countdown, and the round's
// date at the end. His example: "Order within 12 days, 20 hours, and
// 26 minutes to join the current group order on Sunday, December 6."
// Held out of `npm test` by its name until the notice changes; turn it
// on in that commit with
//   git mv test/group-close-notice.criteria.mjs \
//     test/group-close-notice.test.mjs
// The browser half, the notice on the page as its clock runs, is
// e2e/group-close-notice.spec.mjs.
//
// The form the delivery countdown has (date-lists.js `countdown` and
// DateLists#tick), which the notice is held to:
//   - days, hours and minutes: "2 days, 5 hours, and 12 minutes", the
//     hours kept at "0 hours" while there are days, and the minutes at
//     "0 minutes" while there are days or hours;
//   - under a day: "5 hours and 50 minutes";
//   - under an hour: the minutes alone, "26 minutes", and never "0
//     minutes": under a minute is "1 minute";
//   - "1 day", "1 hour", "1 minute" in the singular;
//   - the date at the end as the select writes it, weekday, month and
//     day, no year: "Thursday, November 19";
//   - a new count each minute, each 10 s in the last hour.
//
// Contract (the seam):
//   name    DateLists, the class that owns the delivery countdown:
//           #apply(lists), /api/dates's answer, and #addRounds(entries,
//           series), the group's rounds from /api/group
//   module  assets/scripts/order/date-lists.js
//   inputs  a form whose querySelector finds [data-countdown] and
//           [data-countdown-text] (Delivery's notice) and
//           [data-group-close] (Group orders' close notice, today's
//           "Orders close at ..." line in
//           layouts/partials/order/fulfilment.html); a selector for a
//           part inside [data-group-close] finds the same node
//   output  the textContent of [data-group-close], the notice as the
//           customer reads it
//
// The rounds are the group's real ones (data/series.json, Sunday
// rounds every other week from 22 November 2026, orders closing at
// 11:59 PM the Saturday before), as /api/group lists them
// (group.mjs `groupDates`). Each `now` sits 30 s past a whole minute
// of the count, so the test's own milliseconds never take a minute
// off.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The round James's example names, and the instant its orders close.
const ROUND = { date: "2026-12-06", label: "Sunday, December 6" };
const CUTOFF = Date.parse("2026-12-06T04:59:00.000Z");

const GROUP = (count, label = ROUND.label) =>
  `Order within ${count} to join the current group order on ${label}.`;

// The count and date out of a notice, delivery's or the group's.
const SENTENCE = new RegExp("^Order within (.+) (for delivery|to join "
  + "the current group order) on (.+)\\.$", "u");
const parts = (text) => {
  const m = String(text).match(SENTENCE);

  return m ? { count: m[1], phrase: m[2], date: m[3] } : null;
};

// The group's open rounds at `now`, as /api/group lists them, with a
// schedule line so none is missing for want of one.
const rounds = (now) => groupDates(VFF, now, {
  PICKUP_SCHEDULE: `${addDays(today(now, terms.timeZone), 1)} 09:00-12:00`,
}).map((d) => ({ ...d, name: VFF.name }));

// A form holding Delivery's notice and Group orders' close notice.
const notices = () => {
  const node = () => ({
    dataset: {}, hidden: false, textContent: "", querySelector: null,
  });
  const chip = node();
  const text = node();
  const close = node();

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

  return { form, text, close };
};

const made = [];

// Both notices at `now` (epoch ms), the lists and the rounds in as the
// page has them. `sameCutoff` gives the first delivery day the round's
// cutoff, so the two count down to one instant.
const at = (now, { sameCutoff = false } = {}) => {
  const { form, text, close } = notices();
  const lists = new DateLists(form, () => {});
  const iso = new Date(now).toISOString();
  const offered = rounds(new Date(now));
  const delivery = deliveryDates(new Date(now), deliveryTerms);

  if (sameCutoff) delivery[0] = { ...delivery[0], cutoff: offered[0].cutoff };
  made.push(lists);
  lists.apply({ now: iso, delivery, onfarm: [], scheduled: [] });
  lists.addRounds(offered, VFF.series);

  return {
    lists, offered, delivery,
    group: () => close.textContent,
    delivered: () => text.textContent,
  };
};

// `now` with `d` days, `h` hours and `m` minutes (and 30 s) left
// before the round's orders close.
const before = (d, h, m) => CUTOFF - d * DAY - h * HOUR - m * MINUTE
  - 30_000;

afterEach(() => {
  mock.timers.reset();
  for (const lists of made.splice(0)) {
    clearTimeout(lists.timer);
    clearTimeout(lists.closing);
    clearTimeout(lists.again);
  }
});

describe("#749 close notice", () => {
  it("Close notice (James, 2026-11-23, wording approved final): the "
    + "Group orders close notice matches the delivery countdown "
    + "exactly, with \"for delivery\" becoming \"to join the current "
    + "group order\", a live countdown, and the round's date at the "
    + "end. Example: \"Order within 12 days, 20 hours, and 26 minutes "
    + "to join the current group order on Sunday, December 6.\"", () => {
    // The ground the cases stand on: the round counted down to is the
    // group's next, Sunday 6 December, closing 11:59 PM the Saturday.
    const [round] = rounds(new Date(before(12, 20, 26)));

    assert.equal(round.date, ROUND.date, "the current round");
    assert.equal(Date.parse(round.cutoff), CUTOFF, "its orders close");

    const CASES = [
      // James's example.
      [[12, 20, 26], "12 days, 20 hours, and 26 minutes"],
      // Days, hours and minutes, each in the singular.
      [[1, 1, 1], "1 day, 1 hour, and 1 minute"],
      [[2, 3, 4], "2 days, 3 hours, and 4 minutes"],
      // With days, a zero part is kept.
      [[2, 0, 5], "2 days, 0 hours, and 5 minutes"],
      [[1, 3, 0], "1 day, 3 hours, and 0 minutes"],
      [[1, 0, 0], "1 day, 0 hours, and 0 minutes"],
      // Hours and minutes: the days drop off.
      [[0, 5, 50], "5 hours and 50 minutes"],
      [[0, 1, 1], "1 hour and 1 minute"],
      [[0, 23, 59], "23 hours and 59 minutes"],
      [[0, 2, 0], "2 hours and 0 minutes"],
      // Minutes only: the hours drop off too.
      [[0, 0, 26], "26 minutes"],
      [[0, 0, 2], "2 minutes"],
      [[0, 0, 1], "1 minute"],
      // Under a minute it is still "1 minute", never "0 minutes".
      [[0, 0, 0], "1 minute"],
    ];

    for (const [[d, h, m], count] of CASES) {
      const now = before(d, h, m);
      const page = at(now);

      assert.equal(page.offered[0].date, ROUND.date, `${count}: the round`);
      assert.equal(page.group(), GROUP(count), count);
      assert.doesNotMatch(page.group(), /\b20\d\d\b/u, `${count}: no year`);

      // Delivery's notice counting down to the same instant says the
      // same, word for word, but for its phrase and its own day.
      const same = at(now, { sameCutoff: true });
      const delivery = parts(same.delivered());

      assert.ok(delivery, `${count}: Delivery's notice, as it reads`);
      assert.equal(delivery.count, count, `${count}: Delivery's count`);
      assert.equal(same.group(), same.delivered().replace(
        `for delivery on ${same.delivery[0].label}.`,
        `to join the current group order on ${ROUND.label}.`,
      ), `${count}: Delivery's sentence with the one phrase changed`);
    }

    // The round's date in the delivery notice's date form, the way the
    // select writes a day: weekday, month, day.
    const form = /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/u;
    const page = at(before(12, 20, 26));

    assert.match(parts(page.delivered()).date, form, "Delivery's date");
    assert.match(parts(page.group()).date, form, "the round's date");
    assert.equal(parts(page.group()).date, page.offered[0].label,
      "the round's own label");
  });

  it("Close notice: it counts down live, as the delivery countdown "
    + "does, and takes its days, hours and minutes from the same code, "
    + "so the two never differ in form", () => {
    // Steps of the page's clock, and what the notice reads after each.
    const run = (start, steps) => {
      mock.timers.reset();
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });

      const page = at(start, { sameCutoff: true });
      const seen = [];
      const look = (label) => {
        const group = parts(page.group());
        const delivery = parts(page.delivered());

        assert.ok(group, `${label}: the group's notice reads "${
          page.group()}"`);
        assert.ok(delivery, `${label}: Delivery's notice`);
        // The same code: to the one instant, the two counts agree.
        assert.equal(group.count, delivery.count,
          `${label}: the same count as Delivery's`);
        assert.equal(group.date, ROUND.label, `${label}: the round's date`);
        seen.push(group.count);
      };

      look("on load");
      for (const [ms, label] of steps) {
        mock.timers.tick(ms);
        look(label);
      }

      return seen;
    };

    // Over a day out, a new count each minute, the days dropping off
    // when they run out.
    assert.deepEqual(run(before(1, 0, 2), [
      [MINUTE, "a minute on"],
      [MINUTE, "two minutes on"],
      [MINUTE, "three minutes on"],
      [MINUTE, "four minutes on"],
    ]), [
      "1 day, 0 hours, and 2 minutes",
      "1 day, 0 hours, and 1 minute",
      "1 day, 0 hours, and 0 minutes",
      "23 hours and 59 minutes",
      "23 hours and 58 minutes",
    ]);

    // James's example, live: a minute later it says so.
    assert.deepEqual(run(before(12, 20, 26), [
      [MINUTE, "a minute on"],
      [MINUTE, "two minutes on"],
    ]), [
      "12 days, 20 hours, and 26 minutes",
      "12 days, 20 hours, and 25 minutes",
      "12 days, 20 hours, and 24 minutes",
    ]);

    // Into the last hour: the hours drop off, and the count goes on
    // to its last minute without a reload.
    assert.deepEqual(run(before(0, 1, 1), [
      [MINUTE, "a minute on"],
      [MINUTE, "two minutes on"],
      [57 * MINUTE, "2 minutes 30 s from the close"],
      [MINUTE, "1 minute 30 s from the close"],
      [20_000, "1 minute 10 s from the close"],
      [MINUTE, "10 s from the close"],
    ]), [
      "1 hour and 1 minute",
      "1 hour and 0 minutes",
      "59 minutes",
      "2 minutes",
      "1 minute",
      "1 minute",
      "1 minute",
    ]);

    // One source for the words: a count's units, "hour" and "minute",
    // are spelled out in one file of the page's scripts (today
    // date-lists.js `countdown`), so the group's notice can't carry a
    // copy that drifts from Delivery's.
    const root = new URL("../assets/scripts/", import.meta.url);
    const spelled = readdirSync(root, { recursive: true })
      .filter((f) => /\.m?js$/u.test(f))
      .filter((f) => /(["'`])(hour|minute)\1/u
        .test(readFileSync(new URL(f, root), "utf8")));

    assert.equal(spelled.length, 1,
      `the count's words in one file, not ${spelled.join(", ")}`);
  });
});
