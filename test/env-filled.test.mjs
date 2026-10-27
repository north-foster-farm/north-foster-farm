import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendMissing, checkFilled, missingBlock, unfilled,
} from "../bin/env/filled.mjs";
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

describe("the report", () => {
  it("lists every missing key and every empty one, grouped, each with "
    + "the sample's own comment", () => {
    const found = run(lines(["SQUARE_ACCESS_TOKEN", ""]));

    assert.deepEqual(found.report, [
      "Missing from .env.staging (2):",
      "  SQUARE_LOCATION_ID",
      "      The location.",
      "      Public: not a secret.",
      "  NETLIFY_SITE_ID",
      "      The project.",
      "      Local only: bin/nff reads it.",
      "",
      "Empty in .env.staging (1):",
      "  SQUARE_ACCESS_TOKEN",
      "      The token.",
      "",
    ]);
  });

  it("puts the layout slips first, and carries no value", () => {
    const found = run(`${lines(["SQUARE_ACCESS_TOKEN", SECRET])}` +
      `SQUARE_ACCESS_TOKEN=${SECRET}\n`);

    assert.equal(found.report[0],
      ".env.staging: Line 2: SQUARE_ACCESS_TOKEN again.");
    assert.ok(!found.report.join("\n").includes(SECRET));
  });

  it("is empty when the file is filled", () => {
    const found = run(lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "LOC1"], ["NETLIFY_SITE_ID", SITE]));

    assert.deepEqual(found.report, []);
  });
});

describe("env filled --append", () => {
  const DATE = new Date("2026-10-26T15:00:00");
  const HEAD = "# Added by bin/nff env filled --append, 2026-10-26";
  const LOCATION = ["# SQUARE_LOCATION_ID", "# The location.",
    "# Public: not a secret.", "SQUARE_LOCATION_ID="];
  const SITE_BLOCK = ["# NETLIFY_SITE_ID", "# The project.",
    "# Local only: bin/nff reads it.", "NETLIFY_SITE_ID="];

  // A project with the sample and an env file; `body` runs on its root.
  const within = (envText, body, extra = {}) => {
    const { root, done } = project(envText, extra.sample, extra.env);

    try {
      return body(root, join(root, `.env.${extra.env || "staging"}`));
    } finally {
      done();
    }
  };

  it("adds only the missing keys, each under its comment and a dated "
    + "header, and never a value", () => {
    const before = lines(["SQUARE_ACCESS_TOKEN", ""]);

    within(before, (root, path) => {
      const done = appendMissing(root, "staging", { now: DATE });

      assert.deepEqual(done, { file: ".env.staging",
        appended: ["SQUARE_LOCATION_ID", "NETLIFY_SITE_ID"] });
      assert.equal(readFileSync(path, "utf8"), `${before}\n${[
        HEAD, "", ...LOCATION, "", ...SITE_BLOCK].join("\n")}\n`);
    });
  });

  it("leaves every existing byte as it was, however the file ends", () => {
    for (const before of [
      `# my note\n${lines(["SQUARE_ACCESS_TOKEN", SECRET])}`,
      `SQUARE_ACCESS_TOKEN=${SECRET}`,
      `SQUARE_ACCESS_TOKEN=${SECRET}\n\n\n`,
      "",
    ]) {
      within(before, (root, path) => {
        appendMissing(root, "staging", { now: DATE });

        const after = readFileSync(path, "utf8");

        assert.ok(after.startsWith(before), "an existing byte changed");
        assert.ok(after.slice(before.length).includes(HEAD));
        assert.equal(after.split(SECRET).length - 1,
          before.split(SECRET).length - 1, "a value was copied");
      });
    }
  });

  it("writes no line that ends in a space, and no value", () => {
    within(lines(["SQUARE_ACCESS_TOKEN", SECRET]), (root, path) => {
      appendMissing(root, "staging", { now: DATE });

      const added = readFileSync(path, "utf8").split("\n")
        .filter((l) => l.startsWith("#") || /^[A-Z_]+=/.test(l)
          && !l.startsWith("SQUARE_ACCESS_TOKEN"));

      for (const line of added) {
        assert.ok(!/\s$/.test(line), `trailing space: ${line}`);
        assert.ok(!/^[A-Z_]+=./.test(line), `a value: ${line}`);
      }
    });
  });

  it("leaves empty and optional keys alone, and a second run adds nothing",
    () => {
      within(lines(["SQUARE_ACCESS_TOKEN", ""]), (root, path) => {
        appendMissing(root, "staging", { now: DATE });

        const once = readFileSync(path, "utf8");
        const again = appendMissing(root, "staging", { now: DATE });

        assert.deepEqual(again.appended, []);
        assert.equal(readFileSync(path, "utf8"), once, "nothing changed");
        assert.ok(!once.includes("VENMO_HIDDEN"), "an optional key");
        assert.equal(once.split("SQUARE_ACCESS_TOKEN=").length - 1, 1,
          "an empty key was added again");
        // What it added is now empty, so the file is not yet filled.
        assert.deepEqual(checkFilled(root, "staging").empty,
          ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID", "NETLIFY_SITE_ID"]);
      });
    });

  it("does nothing when no key is missing", () => {
    const before = lines(["SQUARE_ACCESS_TOKEN", SECRET],
      ["SQUARE_LOCATION_ID", "LOC1"], ["NETLIFY_SITE_ID", SITE]);

    within(before, (root, path) => {
      assert.deepEqual(appendMissing(root, "staging"),
        { file: ".env.staging", appended: [] });
      assert.equal(readFileSync(path, "utf8"), before);
    });
  });

  it("refuses a file that is a link, and writes nothing", () => {
    const { root, done } = project(null);

    try {
      const target = join(root, "elsewhere");

      writeFileSync(target, "SQUARE_ACCESS_TOKEN=\n");
      symlinkSync(target, join(root, ".env.staging"));

      assert.throws(() => appendMissing(root, "staging", { now: DATE }),
        /\.env\.staging is a symbolic link: .*nothing was written/);
      assert.equal(readFileSync(target, "utf8"), "SQUARE_ACCESS_TOKEN=\n");
    } finally {
      done();
    }
  });

  it("names a missing file and an unknown environment, and writes "
    + "nothing", () => {
    assert.throws(() => within(null, (root) => appendMissing(root,
      "staging")), /^Error: No \.env\.staging in /);
    assert.throws(() => appendMissing("/nowhere", "qa"),
      /Say one of: development, staging, production\./);
  });

  it("builds the text from the sample's comments, a blank line for a "
    + "blank comment line", () => {
    const parsed = parseSample(SAMPLE);

    assert.equal(missingBlock(parsed, ["VENMO_HIDDEN"], "2026-10-26"),
      `${HEAD}\n\n# VENMO_HIDDEN\n# Hides Venmo.\n` +
      "# Optional: empty shows Venmo.\nVENMO_HIDDEN=\n");
  });

  it("is refused from bin/nff with no environment named", () => {
    const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(
      import.meta.url)), "../bin/nff"), "env", "filled", "--append"],
    { encoding: "utf8", env: { PATH: process.env.PATH } });

    assert.equal(run.status, 1);
    assert.match(run.stderr, /--append needs the environment named/);
    assert.match(run.stderr, /Nothing was written\./);
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
