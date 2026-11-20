// The email rule on hostile input (#678, round two): normalizing runs
// in linear time and gives the same answer twice, and an address over
// 254 characters is refused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  looksLikeEmail, mayBeEmail, normalizeEmail,
} from "../assets/scripts/utils/email.js";

const MILLION = 1_000_000;

// The CPU time this thread has used, in milliseconds. Unlike the
// clock, it stops while the thread waits for a core, so a busy
// machine barely moves it: on 2026-11-20, at load averages near 100,
// the clock made a million characters take 30 to 90 times as long as
// 125,000 (#689).
const cpuMs = () => {
  const { user, system } = process.threadCpuUsage();

  return (user + system) / 1e3;
};

// The CPU time one call of `fn` takes, in milliseconds: the average
// over as many calls as fill 20 ms, so a call of a few microseconds
// is still measured well.
const timed = (fn) => {
  const start = cpuMs();
  let calls = 0;
  let spent = 0;

  while (spent < 20 && calls < 100_000) {
    fn();
    calls += 1;
    spent = cpuMs() - start;
  }

  return spent / calls;
};

// The CPU time a million characters may take. The linear rule took
// up to 20.5 ms on the Mac beside two other suites running at once,
// and about 1 ms on CI; the old quadratic one is over it by 7,813
// characters and would take many minutes on a million (qa, 2026-11-20).
// A ratio of two sizes failed instead on CI, where a call costs so
// little that cache effects swamped it (#689).
const BUDGET_MS = 100;

// The CPU time normalizing and validating `make(n)` takes, doubling n
// from about 1,000 up to a million, or up to the first n over
// BUDGET_MS, so a quadratic rule stops long before it takes hours.
// -> the last n timed and its time.
const climb = (make) => {
  let run;

  for (let k = 10; k >= 0; k -= 1) {
    const n = Math.round(MILLION / 2 ** k);
    const value = make(n);
    const ms = timed(() => {
      normalizeEmail(value);
      looksLikeEmail(value);
    });

    run = { n, ms };
    if (ms > BUDGET_MS) break;
  }

  return run;
};

describe("normalizing in linear time", () => {
  for (const [name, make] of [
    ["periods, then x", (n) => `${".".repeat(n)}x`],
    ["periods at the end", (n) => `a@b.com${".".repeat(n)}`],
    ["spaces and periods, then x", (n) => `${". ".repeat(n)}x`],
    ["spaces at the end", (n) => `a@b.com${" ".repeat(n)}`],
  ]) {
    it(`normalizes and validates a million ${name} within budget`,
      (t) => {
        // Warms the rule up, so the climb times compiled code.
        climb((n) => make(Math.min(n, 1_000)));

        const { n, ms } = climb(make);
        const note = `${n} characters: ${ms.toFixed(2)} ms of CPU time`;

        t.diagnostic(note);
        assert.ok(n === MILLION && ms <= BUDGET_MS,
          `${note}, against ${BUDGET_MS} ms for a million`);
      });
  }
});

describe("normalizing twice", () => {
  it("gives what normalizing once did", () => {
    for (const value of [
      "a@b.com .", "a@b.com. ", " A@B.COM.. ", "a@b.com", "a@b.com.",
      "a@b.com \t.\n", ". .a@b.com", "", " ", ".", ". . .",
      "Pat@Example.COM.", "a@b.com .", "İ@b.com.",
    ]) {
      const once = normalizeEmail(value);

      assert.equal(normalizeEmail(once), once, JSON.stringify(value));
      assert.equal(looksLikeEmail(once), looksLikeEmail(value),
        JSON.stringify(value));
    }
  });

  it("drops spaces and periods mixed at the end", () => {
    assert.equal(normalizeEmail("a@b.com ."), "a@b.com");
    assert.equal(normalizeEmail("a@b.com. "), "a@b.com");
    assert.equal(normalizeEmail(" A@B.COM.. "), "a@b.com");
  });
});

describe("the length limit", () => {
  // An address `length` characters long: a's, then @example.com.
  const address = (length) => {
    const domain = "example.com";
    const local = "a".repeat(length - domain.length - 1);

    return `${local}@${domain}`;
  };

  it("refuses a 255-character address", () => {
    assert.equal(address(255).length, 255);
    assert.equal(looksLikeEmail(address(255)), false);
  });

  it("takes a 254-character address", () => {
    assert.equal(looksLikeEmail(address(254)), true);
  });

  it("counts the length after normalizing, never truncating first", () => {
    const padded = `${address(254)}${" ".repeat(300)}.`;

    assert.equal(looksLikeEmail(padded), true);
    assert.equal(looksLikeEmail(`a@b.com${" ".repeat(300)}junk`), false);
  });
});

describe("whether a value may be an address", () => {
  it("takes one @ and no space, valid or not", () => {
    for (const value of [
      "pat@bücher.de", "pat@ex_ample.com", "pat@[10.0.0.1]",
      " pat@example.com ", "pat@example.com.",
    ]) {
      assert.equal(mayBeEmail(value), true, value);
    }
  });

  it("refuses no @, two of them, or a space", () => {
    for (const value of [
      "", "vff", "a@b@c.com", "asked by pat@example.com", "pat @x.com",
    ]) {
      assert.equal(mayBeEmail(value), false, value);
    }
  });
});
