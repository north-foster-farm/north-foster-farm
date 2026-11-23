// Criteria test for #999 (A log scrubbing test fails when the
// timestamp holds 555), the one box of its "Done when" list marked
// (test agent), named for its box. Held out of npm test by its name
// until the fix lands: renamed to log-clock.test.mjs, a pure rename.
//
// Box 1 says how it is shown: "running the affected tests with the
// clock set to a time holding the digits each test looks for". So
// each log scrubbing test file is run again, in a node of its own,
// with fixed-clock.mjs loaded first, which sets `new Date()` and
// Date.now() to such a time. The file must pass under every clock.
// Whether the fix asserts on the fields that carry customer text or
// gives the tests a clock of its own, a fixed test passes here.
//
// The digits the tests look for, by file, and which a timestamp
// (YYYY-MM-DDTHH:MM:SS.mmmZ) can hold:
// - log-phone-forms: 555 and 0100 on the whole console line. 555 fits
//   in the milliseconds and the time (05:55:55.555); 0100 only in the
//   year, since the colons and the dot break the time into runs of 2
//   and 3, hence the second clock, in the year 100. Its number test
//   looks for 10-digit runs, which no timestamp holds.
// - invite-log-id, the #896 tests: 555 and digit runs, on the message
//   and the detail field only, not the whole line.
// - log-phone-shapes: scrub() alone, no line and no timestamp.
// - log-fields: "555 0142" and example.com on a shipped body, and
//   log-privacy: an address, a name and 401-555-0142 on the console
//   lines. No timestamp holds a space, a letter or a dash after 555.
// Only log-phone-forms fails on next. The other four are guards that
// pass, kept here so a later test of the same shape is caught too.
//
// Box 2 (every test with the same shape is found) is a search, listed
// in the pull request; this test runs the files it names. Box 3 (no
// expectation about the scrub is weakened) is the review of the diff.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

// 555 in the hour, minute, second and milliseconds, then 0100 in the
// year as well.
const CLOCKS = ["2026-11-23T05:55:55.555Z", "0100-01-01T05:55:55.555Z"];

const FILES = [
  "log-phone-forms", "invite-log-id", "log-phone-shapes", "log-fields",
  "log-privacy",
];

// The environment without this runner's own test context, so the run
// below is a test run of its own and reports in full.
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name !== "NODE_TEST_CONTEXT"));

// Runs test/<file>.test.mjs with the clock at `at`, as npm test would
// but in one process, so the clock holds for every test in it.
const runAt = (file, at) => spawnSync(process.execPath, [
  `--import=./test/fixed-clock.mjs?at=${at}`, "--import=./test/setup.mjs",
  "--test", "--test-isolation=none", "--test-reporter=tap",
  `test/${file}.test.mjs`,
], { encoding: "utf8", env });

// The lines of a TAP report that name a failure and why.
const failures = (out) => out.split("\n")
  .filter((l) => /^\s*not ok |error: |expected: |actual: /.test(l))
  .slice(0, 40).join("\n");

describe("#999 no log scrubbing test fails by the clock", () => {
  it("No test of log scrubbing can fail because of the value of the "
    + "line's timestamp: each asserts on the fields that carry customer "
    + "text, or runs with a fixed clock", () => {
    const failed = [];

    for (const at of CLOCKS) {
      for (const file of FILES) {
        const run = runAt(file, at);

        if (run.status !== 0) {
          failed.push(`${file} at ${at} (exit ${run.status}):\n`
            + `${failures(run.stdout + run.stderr)}`);
        }
      }
    }

    assert.deepEqual(failed, [], failed.join("\n\n"));
  });

  it("(guard) the clock the runs use holds the digits the tests look "
    + "for, on the line the logger writes", () => {
    for (const at of CLOCKS) {
      const run = spawnSync(process.execPath, [
        `--import=./test/fixed-clock.mjs?at=${at}`, "--input-type=module",
        "-e", "const { log } = await import("
          + "'./netlify/functions/lib/log.mjs');"
          + "log.info({ event: 'test.clock' });",
      ], { encoding: "utf8" });
      const line = JSON.parse(run.stdout.trim().split("\n").pop());

      assert.match(line._time, /555/, `${at}: ${line._time}`);
      assert.match(line._time, /\.555Z$/, `${at}: ${line._time}`);
      if (at.startsWith("0100")) {
        assert.match(line._time, /^0100-/, `${at}: ${line._time}`);
      }
    }
  });
});
