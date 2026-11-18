// The words the browser keeps together (#593): a time and its AM or
// PM, and the last two words of a line, by bin/orphans/wrap.mjs's rule.
// Kept apart by an ordinary space, on one line by a text-nowrap span,
// never by a no-break space, which drew with no width (#598). `show`
// below writes a kept run in [brackets], so the expected strings stay
// plain.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_WORD, NOWRAP, keepTogether, meridiem, setKept, spaceMeridiem,
  unsafeWord,
} from "../assets/scripts/utils/keep-together.mjs";
import { rounds } from "../assets/scripts/account/lib/membership.mjs";
import { orderBy } from "../assets/scripts/order/lib/picker.mjs";
import { wrapLastWords } from "../bin/orphans/wrap.mjs";

const NBSP = String.fromCharCode(0xa0);
const NARROW = String.fromCharCode(0x202f);
const NO_BREAK = new RegExp(`[${NBSP}${NARROW}]`);

// A group's rounds between a close and its pickup (#600): one of each.
const ALL_ROUNDS = {
  every: 2, opens: "08:30", closes: "09:00",
  closed: { date: "2026-11-22", closedAt: "2026-11-22T04:59:00.000Z" },
  current: { date: "2026-12-06", closesAt: "2026-12-06T04:59:00.000Z" },
  next: { date: "2026-12-20", opensAt: "2026-12-06T04:59:00.000Z" },
};

const show = (text) => keepTogether(text)
  .map((r) => (r.nowrap ? `[${r.text}]` : r.text)).join("");

// Enough of a DOM for setKept: text nodes and spans, in order.
const fakeNode = () => {
  const doc = {
    createElement: (tag) => ({ tag, className: "", textContent: "" }),
  };
  const node = {
    ownerDocument: doc,
    kids: [{ text: "stale" }],
    set textContent(value) {
      this.kids = value ? [{ text: value }] : [];
    },
    get textContent() {
      return this.kids.map((k) => (typeof k === "string" ? k
        : k.textContent ?? k.text)).join("");
    },
    append(kid) {
      this.kids.push(kid);
    },
  };

  return node;
};

describe("a time and its half of the day", () => {
  it("are written with an ordinary space", () => {
    assert.equal(meridiem("8:30", "AM"), "8:30 AM");
    assert.equal(meridiem(9, "PM"), "9 PM");
  });

  it("take an ordinary space in text already written", () => {
    // Newer ICU's narrow no-break space, and #593's no-break one.
    assert.equal(spaceMeridiem(`11:59${NARROW}PM`), "11:59 PM");
    assert.equal(spaceMeridiem(`8:30${NBSP}AM`), "8:30 AM");
    assert.equal(spaceMeridiem("9  AM to 1 PM"), "9 AM to 1 PM");
    assert.equal(spaceMeridiem("At 4 PMs"), "At 4 PMs");
  });

  it("are kept on one line, wherever they are", () => {
    assert.equal(show("9 AM to 1 PM, at the market"),
      "[9 AM] to [1 PM,] at [the market]");
    assert.equal(show("10 AM – 12 PM, at Canned Market"),
      "[10 AM] – [12 PM,] at [Canned Market]");
  });

  it("leave a word that only starts with AM or PM alone", () => {
    assert.equal(show("At 4 PMs today"), "At 4 [PMs today]");
    assert.equal(show("Room 4 AMPLE"), "Room [4 AMPLE]");
    assert.equal(show("No time here"), "No [time here]");
  });
});

describe("the last two words of a line", () => {
  it("are kept on one line", () => {
    assert.equal(show("Every 2 weeks, on Sundays"),
      "Every 2 weeks, [on Sundays]");
    assert.equal(show("Foster, RI 02825"), "Foster, [RI 02825]");
    assert.equal(show("The Village Family Fitness"),
      "The Village [Family Fitness]");
  });

  it("take a time and its AM or PM as one word", () => {
    assert.equal(show("Closes at 11:59 PM on Sat, Nov 21"),
      "Closes at [11:59 PM] on Sat, [Nov 21]");
    assert.equal(show("At 8:30 AM"), "[At 8:30 AM]");
  });

  it("keep spaces at the end, and every space before the pair", () => {
    assert.equal(show("Saved it  "), "[Saved it]  ");
    assert.equal(show("one  two   three"), "one  [two three]");
    assert.equal(show("a\nb"), "[a b]");
  });

  it("join an element of just two words, as wrap.mjs does", () => {
    assert.equal(show("Link copied"), "[Link copied]");
  });

  it("leave one word, none, or a missing value alone", () => {
    assert.equal(show("Members"), "Members");
    assert.equal(show("  Members "), "  Members ");
    assert.equal(show(""), "");
    assert.equal(show(undefined), "");
    assert.equal(show(null), "");
    assert.equal(show(3), "3");
  });

  it("leave a URL or an email address apart", () => {
    for (const text of [
      "We sent a link to pat@example.com",
      "Open https://northfosterfarm.com now",
      "See www.example.org today",
      "Write to SALES@example.com",
    ]) {
      assert.equal(show(text), text, text);
    }
  });

  it("leave a word over the limit apart", () => {
    const long = "x".repeat(MAX_WORD + 1);
    const most = "x".repeat(MAX_WORD);

    assert.equal(show(`Pay ${long}`), `Pay ${long}`);
    assert.equal(show(`${long} now`), `${long} now`);
    assert.equal(show(`Pay ${most}`), `[Pay ${most}]`);
    assert.equal(show(`At 9 AM ${long}`), `At [9 AM] ${long}`);
    // Characters, not UTF-16 units: an emoji counts once.
    assert.equal(show(`Saved ${"👍".repeat(MAX_WORD)}`),
      `[Saved ${"👍".repeat(MAX_WORD)}]`);
  });
});

describe("the text the page writes (#598)", () => {
  it("never holds a no-break space, whatever came in", () => {
    for (const text of [
      `Order by 11:59${NARROW}PM`,
      `Sunday, November 22, 8:30${NBSP}AM`,
      `53 Venturi${NBSP}Ave`,
      `Warwick, RI${NBSP}02888`,
    ]) {
      const runs = keepTogether(text);

      for (const r of runs) assert.doesNotMatch(r.text, NO_BREAK, text);
    }
    assert.equal(show(`Warwick, RI${NBSP}02888`), "Warwick, [RI 02888]");
    assert.equal(show(`Order by 11:59${NARROW}PM`), "Order [by 11:59 PM]");
  });

  it("keeps every character but the spaces it makes ordinary", () => {
    const text = "Closes at 11:59 PM on Sat, Nov 21";

    assert.equal(keepTogether(text).map((r) => r.text).join(""), text);
  });

  // #602: no no-break space anywhere on the Membership tab, in any of
  // its rounds (closed, open and next).
  it("holds none in the Membership rounds or the picker's Order by", () => {
    const lines = [
      ...rounds(ALL_ROUNDS, "America/New_York")
        .flatMap((round) => [round.pill, round.date, round.window,
          round.line]),
      orderBy("2026-11-14T04:59:00.000Z", "America/New_York"),
    ];

    for (const line of lines) {
      assert.doesNotMatch(line, NO_BREAK, line);
      for (const run of keepTogether(line)) {
        assert.doesNotMatch(run.text, NO_BREAK, line);
      }
    }
  });

  it("is set as text and spans, the pair in a text-nowrap span", () => {
    const node = fakeNode();

    setKept(node, "The Village Family Fitness");
    assert.equal(NOWRAP, "text-nowrap");
    assert.deepEqual(node.kids, [
      "The Village ",
      { tag: "span", className: "text-nowrap", textContent: "Family Fitness" },
    ]);
    assert.equal(node.textContent, "The Village Family Fitness");

    setKept(node, "Members");
    assert.deepEqual(node.kids, ["Members"], "the old text is gone");

    setKept(node, "<b>x</b> y");
    assert.deepEqual(node.kids, [
      { tag: "span", className: "text-nowrap", textContent: "<b>x</b> y" },
    ], "markup in the text stays text");

    setKept(node, undefined);
    assert.deepEqual(node.kids, []);
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
      assert.equal(show(`Hello ${word}`), `Hello ${word}`, word);
    }
    assert.equal(wrapLastWords("<p>Hello there</p>").html,
      "<p><span class=\"text-nowrap\">Hello there</span></p>");
    assert.equal(show("Hello there"), "[Hello there]");
  });
});

// #602: the round's second line is built with ordinary spaces and
// kept pairs from the keep-together helper (#593, #598): a time stays
// with its AM or PM, and the line's last two words stay together.
describe("the Membership tab's round lines (#593, #602)", () => {
  it("never leave a word, or an AM or PM, to break off alone", () => {
    const lines = rounds(ALL_ROUNDS, "America/New_York")
      .map((round) => round.line);

    assert.ok(lines.length >= 3, "a closed, an open and a next round");
    for (const line of lines) {
      const runs = keepTogether(line);
      const kept = runs.filter((r) => r.nowrap).map((r) => r.text);
      const words = line.split(" ");

      assert.ok(runs.at(-1).nowrap, line);
      assert.ok(runs.at(-1).text.endsWith(words.slice(-2).join(" ")), line);
      for (const time of line.match(/\d+:\d\d [AP]M/g) || []) {
        assert.ok(kept.some((k) => k.includes(time)), `${time} in ${line}`);
      }
    }
  });
});
