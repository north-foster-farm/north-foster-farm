// Criteria test for the QA review on #957 (CHANGES, finding 1), held
// out of `npm test` by its name until date-lists.js changes; turn it
// on in that commit with
//   git mv test/cutoff-passed-once.criteria.mjs \
//     test/cutoff-passed-once.test.mjs
//
// The statement it holds, word for word: "After Delivery's cutoff
// passes, the passed branch runs once for that cutoff: one 'That
// cutoff just passed. Updating dates…' note and one /api/dates
// request, however many group ticks follow and whether or not a
// group's code is accepted afterwards; if the request fails, the
// retry message stays and the retry backoff (2 s, 5 s, 15 s, 30 s) is
// not restarted by a group tick."
//
// So, with /api/dates failing from the cutoff on, the requests go out
// at the cutoff and then on the backoff alone: 2 s after it, 5 s after
// that, 15 s, then every 30 s. No other request goes out, the "passed"
// note is written once, and the retry message, once up, is what the
// notice reads at every second that follows.
//
// Contract (the seam):
//   name    DateLists: #apply(lists), /api/dates's answer, and
//           #addRounds(entries, series), the group's rounds from
//           /api/group once its code is accepted
//   module  assets/scripts/order/date-lists.js
//   inputs  a form whose querySelector finds [data-countdown] and
//           [data-countdown-text] (Delivery's notice) and
//           [data-group-close] (Group orders' close notice);
//           globalThis.fetch, which fails; the clock, setTimeout and
//           Date mocked (node:test mock.timers)
//   output  every text written to [data-countdown-text], what it reads
//           each second, and the instant of each fetch of /api/dates
//
// The day is Thursday 19 November 2026, whose delivery orders close at
// noon New York on the 18th (17:00 UTC). The round open is the group's
// real one (data/series.json), Sunday 22 November, its orders closing
// at 11:59 PM the Saturday before: days away, so the shared timer, if
// the group's notice drives it, ticks each minute throughout.

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
const SECOND = 1000;
const PASSED = "That cutoff just passed. Updating dates…";
const RETRYING = "We couldn't load the dates. Retrying…";

// 15 s before Delivery's cutoff, which the delivery count, ticking
// each 10 s in its last hour, sees passed 20 s in.
const START = Date.parse("2026-11-18T16:59:45.000Z");
const CUTOFF = Date.parse("2026-11-18T17:00:00.000Z");

// How long each run watches: six minutes, so the shared timer would
// tick six times and the backoff reach its 30 s steps.
const WATCH = 6 * 60;

// The seconds, from START, at which /api/dates is asked for: once when
// the count sees the cutoff passed, then the backoff alone.
const backoff = (first, until) => {
  const steps = [2, 5, 15];
  const out = [first];
  let at = first;

  for (let i = 0; ; i += 1) {
    at += i < steps.length ? steps[i] : 30;
    if (at > until) return out;
    out.push(at);
  }
};

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

// Delivery's notice, which keeps every text written to it, and Group
// orders' close notice, in one form.
const page = () => {
  const chip = { dataset: {} };
  const written = [];
  let shown = "";
  const text = {
    get textContent() {
      return shown;
    },
    set textContent(value) {
      shown = value;
      written.push(value);
    },
  };
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

  return { form, text, written };
};

// Settles the page's promises: a failed fetch, then its retry.
const settle = () => new Promise((done) => setImmediate(done));

// One run from START with /api/dates failing. `roundAt` is the second
// a group's code is accepted (0, with the lists; null, never). -> the
// texts written, what the notice read each second, and the second of
// each request.
const run = async ({ roundAt }) => {
  stop();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });

  const asked = [];

  globalThis.fetch = async (url) => {
    asked.push({ url: String(url), at: (Date.now() - START) / SECOND });
    throw new Error("offline");
  };

  const { form, text, written } = page();
  const lists = new DateLists(form, () => {});
  const offered = rounds(new Date(START));
  const delivery = deliveryDates(new Date(START), deliveryTerms);

  assert.equal(delivery[0].date, "2026-11-19", "the day counted down to");
  assert.equal(Date.parse(delivery[0].cutoff), CUTOFF, "its cutoff");
  assert.ok(offered.length > 0, "a group round is open");
  assert.ok(Date.parse(offered[0].cutoff) - START > 2 * 24 * 3_600_000,
    "the round's own close is days away");

  made.push(lists);
  lists.apply({
    now: new Date(START).toISOString(), delivery, onfarm: [], scheduled: [],
  });
  if (roundAt === 0) lists.addRounds(offered, VFF.series);

  const read = [];

  for (let s = 1; s <= WATCH; s += 1) {
    mock.timers.tick(SECOND);
    await settle();
    if (s === roundAt) {
      lists.addRounds(offered, VFF.series);
      await settle();
    }
    read.push([s, text.textContent]);
  }

  return { written, read, asked };
};

// What every run must show: the statement, case by case.
const holds = ({ written, read, asked }, label) => {
  const expected = backoff(20, WATCH);

  assert.ok(asked.every((a) => a.url === "/api/dates"),
    `${label}: only /api/dates is asked for`);
  assert.equal(written.filter((t) => t === PASSED).length, 1,
    `${label}: one "${PASSED}" note, written ${
      written.filter((t) => t === PASSED).length} times`);
  assert.equal(asked.filter((a) => a.at === 20).length, 1,
    `${label}: one request when the cutoff passed`);
  assert.deepEqual(asked.map((a) => a.at), expected,
    `${label}: the requests on the backoff alone (2 s, 5 s, 15 s, 30 s)`);

  // From the first failure on, the retry message stays.
  const after = read.filter(([s]) => s >= 20);
  const other = after.find(([, t]) => t !== RETRYING);

  assert.equal(other, undefined, `${label}: the retry message stays, but ${
    other && `${other[0]} s in it read "${other[1]}"`}`);
};

const realFetch = globalThis.fetch;

afterEach(() => {
  stop();
  globalThis.fetch = realFetch;
});

describe("Delivery's passed cutoff, with a group round open (#957)", () => {
  it("After Delivery's cutoff passes, the passed branch runs once for "
    + "that cutoff: one 'That cutoff just passed. Updating dates…' note "
    + "and one /api/dates request, however many group ticks follow and "
    + "whether or not a group's code is accepted afterwards; if the "
    + "request fails, the retry message stays and the retry backoff "
    + "(2 s, 5 s, 15 s, 30 s) is not restarted by a group tick",
  async () => {
    // Delivery alone, no group: the ground the other two stand on.
    holds(await run({ roundAt: null }), "no group");

    // The round open from the start, so a group tick follows each
    // minute after the cutoff.
    holds(await run({ roundAt: 0 }), "a round open throughout");

    // The group's code accepted after the cutoff passed, between the
    // backoff's second and third requests (27 s and 42 s).
    holds(await run({ roundAt: 30 }), "a code accepted afterwards");
  });
});
