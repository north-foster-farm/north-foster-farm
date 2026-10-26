import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkFilled, unfilled } from "../bin/env/filled.mjs";
import { parseSample, readValues } from "../bin/env/sample.mjs";

// A small sample in the layout the real ones use: a secret, a public
// key, an optional one, and a key only bin/nff reads.
const SAMPLE = [
  "### .env.staging.sample", "",
  "## Square", "##", "## Where.", "",
  "# SQUARE_ACCESS_TOKEN", "# The token.", "SQUARE_ACCESS_TOKEN=", "",
  "# SQUARE_LOCATION_ID", "# The location.", "# Public: not a secret.",
  "SQUARE_LOCATION_ID=", "",
  "# VENMO_HIDDEN", "# Hides Venmo.", "# Optional: empty shows Venmo.",
  "VENMO_HIDDEN=", "",
  "# NETLIFY_SITE_ID", "# The project.", "# Local only: bin/nff reads it.",
  "NETLIFY_SITE_ID=", "",
].join("\n");
const SECRET = "fake-token-s3cr3t-0001";
const SITE = "fake-site-id-9999";

// A temp project with a sample and an env file, then the check on it.
const project = (envText, sampleText = SAMPLE, env = "staging") => {
  const root = mkdtempSync(join(tmpdir(), "env-filled-"));

  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `.env.${env}.sample`), sampleText);
  if (envText !== null) writeFileSync(join(root, `.env.${env}`), envText);

  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
};
const run = (envText, extra = {}) => {
  const { root, done } = project(envText, extra.sample, extra.env);

  try {
    return checkFilled(root, extra.env || "staging");
  } finally {
    done();
  }
};
const lines = (...pairs) => `${pairs.map(([k, v]) => `${k}=${v}`)
  .join("\n")}\n`;

describe("bin/nff env filled", () => {
  it("passes a file that fills every key, and names what was optional",
    () => {
      const found = run(lines(["SQUARE_ACCESS_TOKEN", SECRET],
        ["SQUARE_LOCATION_ID", "LOC1"], ["NETLIFY_SITE_ID", SITE]));

      assert.deepEqual(found.problems, []);
      assert.equal(found.filled, 3);
      assert.deepEqual(found.optional, ["VENMO_HIDDEN"]);
      assert.equal(found.summary, ".env.staging fills 3 of the 4 keys in " +
        ".env.staging.sample. Optional and left empty: VENMO_HIDDEN.");
    });

  it("fails on a key the file lacks, and on one it leaves empty, by name",
    () => {
      const found = run(lines(["SQUARE_ACCESS_TOKEN", ""],
        ["NETLIFY_SITE_ID", SITE]));

      assert.deepEqual(found.problems, [
        "SQUARE_LOCATION_ID: not in .env.staging.",
        "SQUARE_ACCESS_TOKEN: empty in .env.staging.",
      ]);
    });

  it("counts a quoted empty value as empty", () => {
    const found = run('SQUARE_ACCESS_TOKEN=""\nSQUARE_LOCATION_ID=\'\'\n' +
      `NETLIFY_SITE_ID=${SITE}\n`);

    assert.deepEqual(found.empty, ["SQUARE_ACCESS_TOKEN",
      "SQUARE_LOCATION_ID"]);
  });

  it("lets an optional key be empty or missing altogether", () => {
    const base = [["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "LOC1"], ["NETLIFY_SITE_ID", SITE]];

    for (const extra of [[], [["VENMO_HIDDEN", ""]], [["VENMO_HIDDEN", "1"]]]) {
      assert.deepEqual(run(lines(...base, ...extra)).problems, []);
    }
  });

  it("holds a key only bin/nff reads to the same rule", () => {
    const found = run(lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "LOC1"]));

    assert.deepEqual(found.problems, ["NETLIFY_SITE_ID: not in .env.staging."]);
  });

  it("prints key names and line numbers, never a value", () => {
    const text = `${lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", ""], ["NETLIFY_SITE_ID", SITE])}` +
      `not a key line ${SECRET}\n`;
    const bad = run(text);
    const good = run(lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "LOC1"], ["NETLIFY_SITE_ID", SITE]));

    assert.ok(bad.problems.length >= 2);
    for (const found of [bad, good]) {
      const everything = JSON.stringify(found);

      assert.ok(!everything.includes(SECRET), "a secret was printed");
      assert.ok(!everything.includes(SITE), "a project id was printed");
      assert.ok(!everything.includes("LOC1"), "a value was printed");
    }
  });

  it("reports the env file's own layout slips by line, not content", () => {
    const found = run(`${lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "L"], ["NETLIFY_SITE_ID", SITE])}` +
      `SQUARE_ACCESS_TOKEN=${SECRET}\n`);

    assert.deepEqual(found.problems,
      [".env.staging: Line 4: SQUARE_ACCESS_TOKEN again."]);
  });

  it("reports a sample that does not parse", () => {
    const found = run(lines(["SQUARE_ACCESS_TOKEN", SECRET]),
      { sample: "### x\nLOOSE=1\n" });

    assert.ok(found.problems.some((p) => p.startsWith(
      "Sample .env.staging.sample: Line 2: LOOSE has no comment block.")));
  });

  it("names the file it cannot find, and an environment it does not know",
    () => {
      assert.throws(() => run(null), /^Error: No \.env\.staging in /);
      assert.throws(() => checkFilled("/nowhere", "qa"),
        /Say one of: development, staging, production\./);
    });

  it("reads development when it is asked to", () => {
    const sample = SAMPLE.replace(".env.staging.sample",
      ".env.development.sample");
    const found = run(lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "LOC1"], ["NETLIFY_SITE_ID", SITE]),
    { env: "development", sample });

    assert.equal(found.file, ".env.development");
    assert.deepEqual(found.problems, []);
  });
});

describe("unfilled(), the check without the files", () => {
  it("sorts every key into filled, missing, empty or optional", () => {
    const parsed = parseSample(SAMPLE);
    const { values } = readValues(lines(["SQUARE_ACCESS_TOKEN", ""],
      ["NETLIFY_SITE_ID", SITE]));

    assert.deepEqual(unfilled(parsed, values), {
      total: 4, filled: 1, missing: ["SQUARE_LOCATION_ID"],
      empty: ["SQUARE_ACCESS_TOKEN"], optional: ["VENMO_HIDDEN"],
    });
  });
});
