import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { summarize } from "../bin/staging-jobs-summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../.github/workflows");

// The repository is public, so every workflow log is too: a step may
// print counts and outcomes, never what the site holds about people.
describe("staging jobs summary: counts only, in a public log", () => {
  const report = {
    at: "2026-10-18T12:00:00.000Z",
    deliveryReminded: ["ord_ada", "ord_grace"],
    closed: ["ord_x"],
    pickupsToConfirm: ["ord_y"],
    checkoutsSwept: 3,
    tomorrow: { stops: [{ name: "Ada Lovelace", address: "1 Main St" }] },
    rotation: { due: "someone@example.test" },
    errors: [
      { id: "ord_ada", step: "reminder", error: "no mail to ada@example.test" },
      { id: null, step: "Bad step!", error: "sign-in link https://x.test/t" },
    ],
    invariants: [{ id: "ord_ada", note: "Ada Lovelace paid twice" }],
  };
  const sensitive = [
    "ord_", "ada", "Ada", "Lovelace", "example.test", "Main St", "https",
    "sign-in", "someone",
  ];

  it("prints counts and step names, nothing from the report", () => {
    const { ok, lines } = summarize(200, JSON.stringify(report));
    const text = lines.join("\n");

    assert.equal(ok, true);
    assert.match(text, /HTTP 200/);
    assert.match(text, /deliveryReminded 2, closed 1/);
    assert.match(text, /checkoutsSwept 3/);
    assert.match(text, /Errors 2 \(reminder\), invariants 1/);
    for (const word of sensitive) assert.ok(!text.includes(word), word);
  });

  it("prints only the status for an error body", () => {
    for (const status of [401, 404, 500, "oops", ""]) {
      const { ok, lines } = summarize(status, JSON.stringify(report));
      const text = lines.join("\n");

      assert.equal(ok, false);
      assert.match(text, /^Staging jobs: HTTP (\d{3})\.$/);
      for (const word of sensitive) assert.ok(!text.includes(word), word);
    }
  });

  it("fails, saying nothing about it, on a body that isn't a report", () => {
    for (const text of ["", "<html>ada@example.test</html>", "null"]) {
      const { ok, lines } = summarize(200, text);

      assert.equal(ok, false);
      assert.ok(!lines.join("\n").includes("ada"));
    }
  });
});

describe("workflows: nothing prints a response or a secret", () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const steps = (file) => readFileSync(join(dir, file), "utf8")
    .split(/\n(?=\s*- )/);

  it("finds the workflows", () => {
    assert.ok(files.includes("staging-jobs.yml"));
  });

  for (const file of files) {
    it(`${file}: every curl writes its response to a file`, () => {
      const text = readFileSync(join(dir, file), "utf8");

      for (const call of text.match(/curl[^\n]*(\\\n[^\n]*)*/g) || []) {
        assert.match(call, /(--output|-o) /, call);
        assert.doesNotMatch(call, /--show-error|--fail-with-body|--verbose/);
      }
    });

    it(`${file}: no step echoes a secret or traces its commands`, () => {
      const text = readFileSync(join(dir, file), "utf8");

      assert.doesNotMatch(text,
        /set -[a-z]*x|ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG/);
      for (const step of steps(file)) {
        assert.doesNotMatch(step,
          /(echo|printf|cat)[^\n]*\$\{?(STAGING_[A-Z_]*TOKEN|[A-Z_]*SECRET)/);
        assert.doesNotMatch(step, /\bcat\b[^\n]*jobs\.json/);
      }
    });
  }
});
