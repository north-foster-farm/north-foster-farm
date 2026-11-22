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
// Each test checks the gate, not the fix. None of the three is
// installed on next, so nothing here imports them: the tests find the
// npm scripts that npm run lint reaches that run each tool, run them,
// and read their exit and output. Seeds are written beside the code
// for one run and removed after. Held out of runs as
// quality-analysis.criteria.mjs until the implementer renames it to
// quality-analysis.test.mjs.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  tag, seed, unseed, toolScripts, runTool,
} from "./quality-gate.mjs";

const CRUISER = ["depcruise", "dependency-cruiser", "dependency-cruise"];

// For dependency-cruiser, two modules that import each other, in the page
// scripts and in the server's libraries.
const CYCLES = {
  "page": [`assets/scripts/${tag}-cycle-a.js`,
    `assets/scripts/${tag}-cycle-b.js`],
  "server": [`netlify/functions/lib/${tag}-cycle-a.mjs`,
    `netlify/functions/lib/${tag}-cycle-b.mjs`],
};
const seedCycles = () => {
  for (const [a, b] of Object.values(CYCLES)) {
    const name = (path) => path.split("/").pop();
    seed(a, `import { b } from "./${name(b)}";\nexport const a = () => b;\n`);
    seed(b, `import { a } from "./${name(a)}";\nexport const b = () => a;\n`);
  }
};

describe("#782 step 8: dependency-cruiser", () => {
  it("dependency-cruiser runs in npm run lint", () => {
    assert.notDeepEqual(toolScripts(CRUISER), [],
      "no script that npm run lint reaches runs dependency-cruiser");
  });

  it("a seeded import cycle fails dependency-cruiser, in page and " +
    "server code", () => {
    seedCycles();
    let run;
    try {
      run = runTool(CRUISER);
    } finally {
      unseed();
    }
    assert.ok(run.failed, `dependency-cruiser fails\n${run.log}`);
    const unnamed = Object.values(CYCLES).flat()
      .filter((path) => !run.said.includes(path));
    assert.deepEqual(unnamed, [],
      `seeded cycle files dependency-cruiser does not report\n${run.log}`);
  });
});

after(unseed);
