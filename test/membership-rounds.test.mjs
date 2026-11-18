// The Membership tab's rounds, from the criteria of #602 and #600
// (the test agent's table, .ignored/criteria.md in its lane). 36TS
// picks up from 8:30 to 9:00 AM on Sundays, every two weeks, and its
// ordering closes at 11:59 PM the Saturday before: the Sunday, Nov 22
// pickup closes at 11:59 PM on Saturday, Nov 21.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { roundsNow } from "../netlify/functions/lib/membership.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import {
  addressLine, rounds,
} from "../assets/scripts/account/lib/membership.mjs";

const ZONE = "America/New_York";
const at = (iso) => roundsNow({ series: "36TS" }, terms, new Date(iso));
const listed = (iso) => rounds(at(iso), ZONE);
// Saturday, Nov 21 at noon: the Nov 22 round is open.
const SATURDAY = "2026-11-21T17:00:00Z";
// U+00A0 and U+202F (#598).
const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

describe("a round as the tab writes it (#602)", () => {
  it("writes the pickup as James's sketch", () => {
    const [open, next] = listed(SATURDAY);

    // The weekday in full, the month short, then the window.
    assert.equal(open.date, "Sunday, Nov 22");
    assert.equal(open.window, "8:30 – 9:00 AM");
    assert.equal(next.date, "Sunday, Dec 6");
    assert.equal(next.window, "8:30 – 9:00 AM");
  });

  it("gives the open and the next round James's pills", () => {
    assert.deepEqual(listed(SATURDAY).map((r) => r.pill), ["Open", "Next"]);
  });

  it("writes the open and the next round's lines", () => {
    const [open, next] = listed(SATURDAY);

    assert.equal(open.line, "Closes at 11:59 PM on Sat, Nov 21");
    assert.equal(next.line, "Opens on Sun, Nov 22");
  });

  it("takes orders on the open round alone", () => {
    assert.deepEqual(listed(SATURDAY).map((r) => r.order), [true, false]);
    assert.deepEqual(listed("2026-11-22T13:00:00Z").map((r) => r.order),
      [false, true, false]);
  });

  it("uses no no-break space in any line", () => {
    for (const iso of [SATURDAY, "2026-11-22T13:00:00Z"]) {
      for (const r of listed(iso)) {
        for (const text of [r.pill, r.date, r.window, r.line]) {
          assert.doesNotMatch(text, NO_BREAK, text);
        }
      }
    }
  });

  it("the address line leaves out the group's name", () => {
    const place = { name: "The Gym", street: "1 Main St", city: "Foster",
      state: "RI", zip: "02825" };
    const line = addressLine(place, "The Gym");

    assert.doesNotMatch(line, /The Gym/);
    assert.doesNotMatch(line, /\n/);
    for (const part of ["1 Main St", "Foster", "RI 02825"]) {
      assert.ok(line.includes(part), part);
    }
  });
});

describe("a round's three moments (#600)", () => {
  it("before the close, the coming pickup is the open round", () => {
    // Saturday noon, and one second before the close.
    for (const iso of [SATURDAY, "2026-11-22T04:58:59Z"]) {
      const r = listed(iso);

      assert.deepEqual(r.map((x) => x.state), ["open", "next"], iso);
      assert.equal(r[0].date, "Sunday, Nov 22", iso);
      assert.ok(!at(iso).closed, iso);
    }
  });

  it("between the close and the pickup, keeps that pickup, closed, first",
    () => {
      // The close itself, and Sunday at 8:00 AM, before the window.
      for (const iso of ["2026-11-22T04:59:00Z", "2026-11-22T13:00:00Z"]) {
        const r = listed(iso);

        assert.deepEqual(r.map((x) => x.state), ["closed", "open", "next"],
          iso);
        assert.equal(r[0].date, "Sunday, Nov 22", iso);
        assert.equal(r[0].window, "8:30 – 9:00 AM", iso);
        assert.equal(r[0].order, false, iso);
        // The round now open is the next pickup.
        assert.equal(r[1].date, "Sunday, Dec 6", iso);
        assert.equal(r[1].pill, "Open", iso);
        // What the server sends says so too.
        assert.equal(at(iso).closed.date, "2026-11-22", iso);
        assert.equal(at(iso).current.date, "2026-12-06", iso);
      }
    });

  // James, in his review: "Pickup has happened at the end of its
  // round", so the window (8:30 to 9:00 AM) still shows it.
  it("during the pickup window, keeps that pickup until the window ends",
    () => {
      // 8:30, 8:45 and 8:59:59 AM on Sunday, Nov 22.
      for (const iso of ["2026-11-22T13:30:00Z", "2026-11-22T13:45:00Z",
        "2026-11-22T13:59:59Z"]) {
        const r = listed(iso);

        assert.deepEqual(r.map((x) => x.state), ["closed", "open", "next"],
          iso);
        assert.equal(r[0].date, "Sunday, Nov 22", iso);
        assert.equal(at(iso).closed.date, "2026-11-22", iso);
      }
    });

  it("a series with no hours keeps the pickup to the end of its day", () => {
    const s = terms.model.seriesOf("36TS");
    const bare = { ...s, opens: null, closes: null, opensHour: null,
      opensMinute: null, closesHour: null, closesMinute: null,
      window: null };
    const noHours = { ...terms,
      model: { ...terms.model, seriesOf: () => bare } };
    const when = (iso) => roundsNow({ series: "36TS" }, noHours,
      new Date(iso));

    // Sunday at 10:00 AM and at 11:59 PM: still the day of the pickup.
    for (const iso of ["2026-11-22T15:00:00Z", "2026-11-23T04:59:00Z"]) {
      assert.equal(when(iso).closed?.date, "2026-11-22", iso);
    }
    // Midnight, Monday: the day is over.
    assert.ok(!when("2026-11-23T05:00:00Z").closed);
  });

  it("after the pickup, lets it go", () => {
    // 9:00 AM, when the window ends, 10:00 AM and the Monday after.
    for (const iso of ["2026-11-22T14:00:00Z", "2026-11-22T15:00:00Z",
      "2026-11-23T15:00:00Z"]) {
      const r = listed(iso);

      assert.deepEqual(r.map((x) => x.state), ["open", "next"], iso);
      assert.equal(r[0].date, "Sunday, Dec 6", iso);
      assert.ok(!at(iso).closed, iso);
    }
  });
});
