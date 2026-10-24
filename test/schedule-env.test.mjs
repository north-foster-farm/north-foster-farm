import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setSchedule } from "../bin/schedule-env.mjs";

// A Netlify CLI that keeps what it's set, or drops it (the silent set
// of 2026-09-28) when told to.
const cli = ({ drop = false } = {}) => {
  const vars = new Map();
  const calls = [];

  const run = async (args) => {
    calls.push(args.join(" "));
    const [command, , value, , context] = args;

    if (command === "env:set") {
      if (!drop) vars.set(context, value);
      return "";
    }
    const at = args[3];

    return vars.has(at) ? `${vars.get(at)}\n`
      : `No value set in the ${at} context for PICKUP_SCHEDULE\n`;
  };

  return { run, calls };
};

describe("bin/nff schedule set", () => {
  const value = "2026-09-29 09:00-12:00 13:00-17:00";

  it("sets each context and reads it back", async () => {
    const { run, calls } = cli();

    await setSchedule(run, value, ["branch:staging"], "SITE");
    assert.deepEqual(calls, [
      `env:set PICKUP_SCHEDULE ${value} --context branch:staging`,
      "env:get PICKUP_SCHEDULE --context branch:staging",
    ]);
  });

  it("fails when the value doesn't read back", async () => {
    const { run } = cli({ drop: true });

    await assert.rejects(setSchedule(run, value, ["branch:staging"], "SITE"),
      /didn't take on branch:staging of site SITE: it reads back as \d+ /);
  });

  it("names a missing site id", async () => {
    const run = async () => "";

    await assert.rejects(setSchedule(run, value, ["production"]),
      /of site \(no NETLIFY_SITE_ID\): it reads back empty/);
  });
});
