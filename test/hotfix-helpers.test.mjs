// The implementer's own tests of bin/hotfix.mjs's helpers, beside the
// criteria tests in test/hotfix.test.mjs, which they never replace.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  REQUIRED, RULESET_PATH, differences, listed, narrowed, notWhole,
  restoreCommand, unproven,
} from "../bin/hotfix.mjs";

const RULESET = {
  name: "no force-push or deletion: next, staging, main",
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: {
      exclude: [],
      include: ["refs/heads/next", "refs/heads/staging", "refs/heads/main"],
    },
  },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  bypass_actors: [],
  id: 25361439,
};

describe("bin/hotfix.mjs helpers", () => {
  it("calls a ruleset whole only on exactly next, staging and main with "
    + "both rules", () => {
    const withInclude = (include) => ({
      ...RULESET, conditions: { ref_name: { exclude: [], include } },
    });

    assert.equal(notWhole(RULESET), undefined);
    assert.equal(notWhole(withInclude(["refs/heads/main",
      "refs/heads/next", "refs/heads/staging"])), undefined, "any order");
    assert.match(notWhole(withInclude(["refs/heads/main"])),
      /covers main, not exactly/);
    assert.match(notWhole(withInclude([...RULESET.conditions.ref_name
      .include, "refs/heads/release"])), /release/);
    assert.match(notWhole({ ...RULESET, rules: [{ type: "deletion" }] }),
      /rule/);
  });

  it("prints a restore command the shell runs as printed", () => {
    assert.equal(restoreCommand("/r/.git/x.json"),
      `gh api -X PUT ${RULESET_PATH} --input /r/.git/x.json`);
    assert.equal(restoreCommand("/my repo/it's.json"),
      `gh api -X PUT ${RULESET_PATH} --input '/my repo/it'\\''s.json'`);
  });

  it("narrows to main alone and keeps every rule and no bypass", () => {
    const body = narrowed(RULESET);

    assert.deepEqual(body.conditions.ref_name.include, ["refs/heads/main"]);
    assert.deepEqual(body.rules, RULESET.rules);
    assert.deepEqual(body.bypass_actors, []);
    assert.equal(body.id, undefined, "sends only what a PUT takes");
    assert.deepEqual(RULESET.conditions.ref_name.include.length, 3,
      "leaves the saved copy as it was");
    assert.match(RULESET_PATH, /rulesets\/25361439$/);
  });

  it("names each field that reads back differently", () => {
    const back = structuredClone(RULESET);

    assert.deepEqual(differences(RULESET, back), []);
    back.conditions.ref_name.include.pop();
    back.updated_at = "later";

    const diff = differences(RULESET, back);

    assert.equal(diff.length, 1);
    assert.match(diff[0], /^conditions saved/);
  });

  it("passes a check only on a completed run that succeeded", () => {
    // The recorded runs of a green commit of next, skipped runs first.
    const { check_runs: runs } = JSON.parse(readFileSync(new URL(
      "fixtures/github/check-runs-green.json", import.meta.url), "utf8"))
      .response;
    const without = (name) => runs.filter((run) => run.name !== name
      || run.conclusion !== "success");

    assert.deepEqual(unproven(runs), []);
    assert.deepEqual(unproven([]), REQUIRED);
    assert.deepEqual(unproven(without("codeql")), ["codeql"],
      "a skipped codeql run does not pass it");
    assert.deepEqual(unproven(runs.map((run) => (run.name === "supply-chain"
      ? { ...run, status: "in_progress", conclusion: null } : run))),
    ["supply-chain"], "a run still going does not pass it");
  });

  it("lists names the way a sentence does", () => {
    assert.equal(listed([]), "");
    assert.equal(listed(["a"]), "a");
    assert.equal(listed(["a", "b"]), "a and b");
    assert.equal(listed(["a", "b", "c"]), "a, b and c");
  });
});
