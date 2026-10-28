// The e2e log tool (bin/e2e/logs.mjs): the slicing that beats the
// CLI's 100-line cap, the failed tests read from a run's log, and the
// summary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  failuresIn, slices, summarize,
} from "../bin/e2e/logs.mjs";

describe("bin/e2e/logs", () => {
  it("slices a window, the last slice ending on time", () => {
    assert.deepEqual(slices("2026-10-28T05:40:00Z",
      "2026-10-28T05:45:00Z", 120_000), [
      ["2026-10-28T05:40:00.000Z", "2026-10-28T05:42:00.000Z"],
      ["2026-10-28T05:42:00.000Z", "2026-10-28T05:44:00.000Z"],
      ["2026-10-28T05:44:00.000Z", "2026-10-28T05:45:00.000Z"],
    ]);
  });

  it("reads each failed test once, with its time", () => {
    const log = [
      "e2e-staging\tRun\t2026-10-28T05:44:44.25Z   ✘  179 [desktop] › " +
        "e2e/email-change.spec.mjs:69:3 › a link (26.9s)",
      "e2e-staging\tRun\t2026-10-28T05:44:45.00Z   ✓  180 [desktop] › ok",
      "e2e-staging\tRun\t2026-10-28T06:10:00.00Z   ✘  179 [desktop] › " +
        "e2e/email-change.spec.mjs:69:3 › a link (26.9s)",
    ].join("\n");

    assert.deepEqual(failuresIn(log), [{
      at: "2026-10-28T05:44:44.25Z",
      title: "[desktop] › e2e/email-change.spec.mjs:69:3 › a link",
    }]);
  });

  it("lists warnings, marked lines and silent gaps, not plain info",
    () => {
      const row = (timestamp, level, message, name = "staging") => ({
        source: "function", name, timestamp, level, message,
      });
      const lines = summarize([
        row("2026-10-28T05:47:17.000Z", "info", "Duration: 30 ms"),
        row("2026-10-28T05:49:22.000Z", "info",
          '{"event":"function.slow","ms":6000}'),
        row("2026-10-28T05:49:23.000Z", "error", "Error: boom", "gate"),
        row("2026-10-28T05:49:23.000Z", "error", "    at somewhere", "gate"),
      ], [], { capped: ["stock 2026-10-28T05:48:00Z"] });
      const text = lines.join("\n");

      assert.match(text, /4 log lines/);
      assert.match(text, /Still capped at 100.*stock/);
      assert.match(text, /function\.slow/);
      assert.match(text, /Error: boom/);
      assert.ok(!text.includes("at somewhere"));
      assert.ok(!text.includes("Duration: 30 ms"));
      assert.match(text, /05:47:17.000Z -> .*05:49:22.000Z \(125 s\)/);
    });
});
