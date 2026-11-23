// Criteria tests for #969, phase 6 of untangling the server
// libraries' import cycles (#925, docs/refactors/server-cycles.md):
// "Deletes .dependency-cruiser-known-violations.json, drops
// --ignore-known from lint:cycles, retires
// test/quality-cycles-known.test.mjs, and marks #925's entry on #791
// resolved. If step 8 is still unlanded, this phase is folded into
// step 8 instead: it lands with no baseline at all."
//
// One test per box marked (test), named for the box, written before
// the implementation. The other three boxes are guards: the seeded
// server cycle in test/quality-cycles.criteria.mjs (once step 8 renames
// it .test.mjs), and the coordinator's landing check for #791 and #925.
//
// The box says "by the step 8 criteria that read the script": like
// those (test/quality-gate.mjs), this test reads package.json's
// scripts and runs the one it names, the way the hook and CI do. "Runs"
// is read as: lint:cycles exists, runs dependency-cruiser, is reached
// from npm run lint, takes no --ignore-known, and exits 0. With no
// baseline, exit 0 means the graph has no cycle left. "The file" is
// the baseline, .dependency-cruiser-known-violations.json, gone from
// the working tree and from git's index. Retiring
// test/quality-cycles-known.test.mjs is in the spec but not the box,
// so it is not tested here.
//
// Neither lint:cycles nor dependency-cruiser is on next when this is
// written, so the test fails there. Held out of runs as
// server-imports-baseline.criteria.mjs until the implementer renames it
// to server-imports-baseline.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, toolScripts } from "./quality-gate.mjs";

const SCRIPT = "lint:cycles";
const BASELINE = ".dependency-cruiser-known-violations.json";
const CRUISER = ["depcruise", "dependency-cruiser", "dependency-cruise"];

const scripts = () =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};

const run = (command, args) => spawnSync(command, args, {
  "cwd": root,
  "encoding": "utf8",
  "env": { ...process.env, "npm_config_script_shell": "/bin/sh" },
  "maxBuffer": 64 * 1024 * 1024,
});

describe("#969: retire the cycle baseline", () => {
  it("npm run lint:cycles runs with no --ignore-known, and the file is " +
    "gone", () => {
    const all = scripts();
    assert.ok(SCRIPT in all, `package.json has no ${SCRIPT} script`);
    const command = all[SCRIPT];
    assert.doesNotMatch(command, /--ignore-known\b/u,
      `${SCRIPT} still passes --ignore-known: ${command}`);
    assert.ok(toolScripts(CRUISER).includes(SCRIPT),
      `${SCRIPT} is not a script npm run lint reaches that runs ` +
      `dependency-cruiser: ${command}`);
    const others = toolScripts(CRUISER)
      .filter((name) => /--ignore-known\b/u.test(all[name]));
    assert.deepEqual(others, [],
      "scripts npm run lint reaches that pass --ignore-known");

    assert.ok(!existsSync(join(root, BASELINE)),
      `${BASELINE} is still in the working tree`);
    const tracked = run("git", ["ls-files", "--", BASELINE]);
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.equal(tracked.stdout.trim(), "", `${BASELINE} is still tracked`);

    const result = run("npm", ["run", "--silent", SCRIPT]);
    const said = `${result.stdout}\n${result.stderr}`.slice(-4000);
    assert.equal(result.status, 0,
      `npm run ${SCRIPT} fails with no baseline\n${said}`);
  });
});
