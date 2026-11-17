// The words the browser keeps together (#593): a time and its AM or
// PM, and the last two words of a line, by bin/orphans/wrap.mjs's rule.
// `_` below is the no-break space, so the expected strings stay plain.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_WORD, NBSP as _, joinMeridiem, keepLastTwo, keepTogether, meridiem,
  unsafeWord,
} from "../assets/scripts/utils/keep-together.mjs";
import {
  pickupMoment, roundRows,
} from "../assets/scripts/account/lib/membership.mjs";
import { wrapLastWords } from "../bin/orphans/wrap.mjs";

const NARROW = String.fromCharCode(0x202f);

describe("a time and its half of the day", () => {
  it("are joined by a no-break space", () => {
    assert.equal(_, String.fromCharCode(0xa0));
    assert.equal(meridiem("8:30", "AM"), `8:30${_}AM`);
    assert.equal(meridiem(9, "PM"), `9${_}PM`);
  });

  it("are joined in text already written, whatever the space", () => {
    assert.equal(joinMeridiem("Saturday, November 21, 11:59 PM"),
      `Saturday, November 21, 11:59${_}PM`);
    // Newer ICU's narrow no-break space.
    assert.equal(joinMeridiem(`11:59${NARROW}PM`), `11:59${_}PM`);
    assert.equal(joinMeridiem("9 AM to 1 PM"), `9${_}AM to 1${_}PM`);
    assert.equal(joinMeridiem(`8:30${_}AM`), `8:30${_}AM`);
  });

  it("leave a word that only starts with AM or PM alone", () => {
    assert.equal(joinMeridiem("At 4 PMs"), "At 4 PMs");
    assert.equal(joinMeridiem("Room 4 AMPLE"), "Room 4 AMPLE");
    assert.equal(joinMeridiem("No time here"), "No time here");
  });
});

describe("the last two words of a line", () => {
  it("are joined by a no-break space", () => {
    assert.equal(keepLastTwo("Every 2 weeks, on Sundays"),
      `Every 2 weeks, on${_}Sundays`);
    assert.equal(keepLastTwo("Foster, RI 02825"), `Foster, RI${_}02825`);
  });

  it("take a time joined to its AM or PM as one word", () => {
    assert.equal(keepLastTwo(pickupMoment("2026-11-22", "08:30")),
      `Sunday, November 22,${_}8:30${_}AM`);
  });

  it("keep spaces at the end, and every space before the pair", () => {
    assert.equal(keepLastTwo("Saved it  "), `Saved${_}it  `);
    assert.equal(keepLastTwo("one  two   three"), `one  two${_}three`);
    assert.equal(keepLastTwo("a\nb"), `a${_}b`);
  });

  it("join an element of just two words, as wrap.mjs does", () => {
    assert.equal(keepLastTwo("Link copied"), `Link${_}copied`);
  });

  it("leave one word, none, or a missing value alone", () => {
    assert.equal(keepLastTwo("Members"), "Members");
    assert.equal(keepLastTwo("  Members "), "  Members ");
    assert.equal(keepLastTwo(""), "");
    assert.equal(keepLastTwo(undefined), "");
    assert.equal(keepLastTwo(null), "");
    assert.equal(keepLastTwo(3), "3");
  });

  it("are joined only once", () => {
    const once = keepLastTwo("Joined Nov 2, 2026, by QR code");

    assert.equal(once, `Joined Nov 2, 2026, by QR${_}code`);
    assert.equal(keepLastTwo(once), `Joined Nov 2, 2026, by${_}QR${_}code`,
      "the joined pair reads as one word, as it does to wrap.mjs");
  });

  it("leave a URL or an email address apart", () => {
    for (const text of [
      "We sent a link to pat@example.com",
      "Open https://northfosterfarm.com now",
      "See www.example.org today",
      "Write to SALES@example.com",
    ]) {
      assert.equal(keepLastTwo(text), text, text);
    }
  });

  it("leave a word over the limit apart", () => {
    const long = "x".repeat(MAX_WORD + 1);
    const most = "x".repeat(MAX_WORD);

    assert.equal(keepLastTwo(`Pay ${long}`), `Pay ${long}`);
    assert.equal(keepLastTwo(`${long} now`), `${long} now`);
    assert.equal(keepLastTwo(`Pay ${most}`), `Pay${_}${most}`);
    // Characters, not UTF-16 units: an emoji counts once.
    assert.equal(keepLastTwo(`Saved ${"👍".repeat(MAX_WORD)}`),
      `Saved${_}${"👍".repeat(MAX_WORD)}`);
  });
});

describe("a line as the browser sets it", () => {
  it("holds a time written elsewhere to its AM or PM mid-line", () => {
    // A pickup window as the server's windowLabel writes it, with
    // plain spaces, then a place: keepLastTwo alone would leave
    // "10 AM" free to part.
    assert.equal(keepTogether("10 AM – 12 PM, at Canned Market"),
      `10${_}AM – 12${_}PM, at Canned${_}Market`);
    assert.equal(keepTogether(`Order by 11:59${NARROW}PM`),
      `Order by${_}11:59${_}PM`);
    assert.equal(keepTogether("Sunday, 9 AM – noon (as booked)"),
      `Sunday, 9${_}AM – noon (as${_}booked)`);
  });

  it("keeps the exceptions apart, as keepLastTwo does", () => {
    const long = "x".repeat(MAX_WORD + 1);

    assert.equal(keepTogether("Sent to pat@example.com"),
      "Sent to pat@example.com");
    assert.equal(keepTogether("Open https://northfosterfarm.com"),
      "Open https://northfosterfarm.com");
    assert.equal(keepTogether(`At 9 AM ${long}`), `At 9${_}AM ${long}`);
  });

  it("leaves a missing value empty and a joined time as it was", () => {
    assert.equal(keepTogether(undefined), "");
    assert.equal(keepTogether(null), "");
    assert.equal(keepTogether(""), "");
    assert.equal(keepTogether(`8:30${_}AM`), `8:30${_}AM`);
    assert.equal(keepTogether(`At 8:30${_}AM`), `At${_}8:30${_}AM`);
  });
});

describe("the word rule", () => {
  it("is the one wrap.mjs keeps the built pages by", () => {
    assert.equal(MAX_WORD, 14);
    assert.ok(unsafeWord("a@b"));
    assert.ok(unsafeWord("http://x"));
    assert.ok(unsafeWord("www.x"));
    assert.ok(unsafeWord("x".repeat(15)));
    assert.ok(!unsafeWord("x".repeat(14)));
    for (const word of ["x".repeat(15), "a@b.co"]) {
      assert.equal(wrapLastWords(`<p>Hello ${word}</p>`).count, 0, word);
      assert.equal(keepLastTwo(`Hello ${word}`), `Hello ${word}`, word);
    }
    assert.equal(wrapLastWords("<p>Hello there</p>").count, 1);
    assert.equal(keepLastTwo("Hello there"), `Hello${_}there`);
  });
});

describe("the Membership tab's rows (#593)", () => {
  it("never leave a word, or an AM or PM, to break off alone", () => {
    const r = {
      opens: "08:30",
      current: { date: "2026-11-22", closesAt: "2026-11-22T04:59:00.000Z" },
      next: { date: "2026-12-06", opensAt: "2026-11-22T04:59:00.000Z" },
    };
    const rows = Object.values(roundRows(r, "America/New_York"));

    assert.equal(rows.length, 4);
    for (const text of rows) {
      const kept = keepLastTwo(text);
      const tail = kept.slice(kept.lastIndexOf(" ") + 1);

      // The last line holds the day's number, the time and its half.
      assert.match(tail, /^\d+,.+[AP]M$/, text);
      assert.equal(tail.split(_).length, 3, text);
    }
  });
});
