// Criteria tests for #782 (quality gates in the build for new and
// changed code), step 8 of the proposal (issuecomment-7075114694),
// written before the implementation: "Knip, jscpd, dependency-cruiser".
//
// The proposal's settings (section 1):
// - Unused code: Knip, "Whole repository, after one cleanup", over
//   unused files, exports and dependencies.
// - Duplication: jscpd, "A ceiling per area at today's figure, which
//   can only fall", the areas being source, tests, styles and
//   templates.
// - Imports: dependency-cruiser, "Cycles, and which folders may import
//   which".
// And section 2: "Every new gate goes inside npm run lint".
//
// Each test checks the gate, not the fix: it finds the npm scripts
// that npm run lint reaches that run each tool. The seeded jscpd test
// that stood here failed pull requests that added clean test lines
// (#991); test/quality-ceilings.test.mjs holds the ceilings now.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolScripts } from "./quality-gate.mjs";

const JSCPD = ["jscpd"];

describe("#782 step 8: jscpd", () => {
  it("jscpd runs in npm run lint", () => {
    assert.notDeepEqual(toolScripts(JSCPD), [],
      "no script that npm run lint reaches runs jscpd");
  });
});
