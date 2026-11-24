// Criteria tests for #922 (The logger's phone scrub misses slashes,
// underscores, other dashes, full-width digits and number values),
// the boxes of its "Done when" list marked (test), one test each (box
// 1 has one per form, as it asks), named for its box. Held out of npm
// test by its name until the fix lands: renamed to
// log-phone-forms.test.mjs, a pure rename.
//
// Box 3 (every id kind #896's tests keep whole is still kept whole) is
// held by the existing tests, unchanged: invite-log-id.test.mjs and
// log-phone-shapes.test.mjs. Box 4 (security reviews) is not a test.
//
// Beyond the boxes, two tests from the issue's own words and James's
// comment of 2026-11-23 (security's re-read of #921): the issue body
// names "other dash that is not the ASCII hyphen", so a figure dash,
// a minus sign, a non-breaking hyphen and a horizontal bar are tested
// too; and secretAccessKey and apiKey join the keys whose values are
// removed whole. Both are provisional: neither is a box.
//
// "Scrubbed" is read as the scrub already does it: the number becomes
// "[phone]" and the words around it stay. A number value (box 2) may
// be scrubbed or refused, so any value but the number passes, as long
// as none of its digits are left on the line. A guard beside it holds
// that a shorter number (a count, an amount in cents) is kept. Number
// values under an id key are left to the implementer: the box asks
// only about keys that are not ids.
//
// The seam: scrub() and the line log.info writes to the console. The
// line is checked for digits left with every field but the timestamp
// the logger wrote (logText), since it can hold 555 or 0100 (#999).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { log, scrub } from "../netlify/functions/lib/log.mjs";
import { logText } from "./log-text.mjs";

// The console lines written while `run` runs, raw and parsed.
const written = (t, run) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }
  run();
  for (const level of ["log", "info", "warn", "error"]) {
    console[level].mock.restore();
  }

  return lines;
};

// Folded to ASCII digits, so a full-width digit left behind is seen.
const folded = (text) => String(text).normalize("NFKC");

// None of 401 555 0100's digits are left, in any form.
const noneLeft = (text, label) => {
  assert.doesNotMatch(folded(text), /555/, `no 555 left: ${label}`);
  assert.doesNotMatch(folded(text), /0100/, `no 0100 left: ${label}`);
};

// `phone` is scrubbed from a logged string, alone and inside a
// sentence, by scrub() and on the line log writes.
const scrubsForm = (t, phone) => {
  const cases = [
    [phone, "[phone]"],
    [`Call ${phone} after noon.`, "Call [phone] after noon."],
  ];

  for (const [value, want] of cases) {
    assert.equal(scrub({ detail: value }).detail, want, `scrub: ${value}`);

    const [raw] = written(t, () => log.info({
      event: "test.phone", message: value,
    }));

    assert.equal(JSON.parse(raw).message, want, `the line: ${value}`);
    noneLeft(logText(raw), value);
  }
};

describe("#922 the logger's phone scrub catches every form", () => {
  it("A phone number written with slashes is scrubbed from a logged "
    + "string, alone and inside a sentence", (t) => {
    scrubsForm(t, "401/555/0100");
  });

  it("A phone number written with underscores is scrubbed from a logged "
    + "string, alone and inside a sentence", (t) => {
    scrubsForm(t, "401_555_0100");
  });

  it("A phone number written with an en dash is scrubbed from a logged "
    + "string, alone and inside a sentence", (t) => {
    scrubsForm(t, "401–555–0100");
  });

  it("A phone number written with an em dash is scrubbed from a logged "
    + "string, alone and inside a sentence", (t) => {
    scrubsForm(t, "401—555—0100");
  });

  it("A phone number written with full-width digits is scrubbed from a "
    + "logged string, alone and inside a sentence", (t) => {
    scrubsForm(t, "４０１５５５０１０"
      + "０");
    scrubsForm(t, "４０１-５５５-０１０"
      + "０");
  });

  it("(provisional, from the issue body) A phone number written with "
    + "another dash that is not the ASCII hyphen is scrubbed", (t) => {
    // Figure dash, minus sign, non-breaking hyphen, horizontal bar.
    for (const dash of ["‒", "−", "‑", "―"]) {
      scrubsForm(t, `401${dash}555${dash}0100`);
    }
  });

  it("A value logged as a number that is 10 or more digits long under a "
    + "key that is not an id is scrubbed or refused", (t) => {
    for (const number of [4015550100, 14015550100, 4015550100123]) {
      for (const key of ["detail", "value", "contact", "callback"]) {
        const out = scrub({ [key]: number })[key];

        assert.notEqual(out, number, `scrub keeps ${key}: ${number}`);
        assert.doesNotMatch(JSON.stringify(out), /\d{10}/,
          `no digits left by scrub: ${key}: ${number}`);

        const [raw] = written(t, () => log.info({
          event: "test.number", [key]: number,
        }));

        assert.notEqual(JSON.parse(raw)[key], number,
          `the line keeps ${key}: ${number}`);
        assert.doesNotMatch(logText(raw), new RegExp(String(number)),
          `no digits left on the line: ${key}: ${number}`);
      }

      // Inside a nested value and a list, too.
      const nested = scrub({ found: { values: [number] } });

      assert.doesNotMatch(JSON.stringify(nested), new RegExp(String(number)),
        `nested: ${number}`);
    }
  });

  it("(guard for box 2) A number value shorter than 10 digits is kept as "
    + "it is", () => {
    for (const kept of [0, 42, -1, 2.5, 12345678, 401555010]) {
      assert.equal(scrub({ value: kept }).value, kept, `keeps ${kept}`);
    }
  });

  it("(provisional, James's comment of 2026-11-23) The values under "
    + "secretaccesskey and apikey are removed whole", () => {
    const secret = "example-not-a-real-secret";

    for (const key of ["secretAccessKey", "secret_access_key",
      "SECRET_ACCESS_KEY", "apiKey", "api_key", "API_KEY", "apikey"]) {
      assert.equal(scrub({ [key]: secret })[key], "[removed]", key);
      assert.equal(scrub({ outer: { [key]: secret } }).outer[key],
        "[removed]", `nested: ${key}`);
    }
  });
});
