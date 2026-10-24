// #294: the toolbar, its clock and the order page's sandbox card
// overlay are built into staging's pages and never into production's.
// Builds the site both ways with Hugo, as Netlify's contexts do, and
// holds each to bin/check-staging.mjs. Where Hugo is not installed
// (CI's test job), CI's build job runs the same check on its builds.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { check } from "../bin/check-staging.mjs";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const build = (context) => {
  const out = mkdtempSync(join(tmpdir(), `nff-${context}-`));
  const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
    "production", "-d", out], {
    cwd: root, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CONTEXT: context },
  });

  assert.equal(run.status, 0, run.stderr);

  return out;
};

describe("the staging build and production's", {
  timeout: 120_000, skip: !hasHugo && "Hugo is not installed here",
}, () => {
  let production;
  let staging;

  before(() => {
    production = build("production");
    staging = build("branch-deploy");
  });
  after(() => {
    for (const dir of [production, staging]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts the overlay, the card and the clock on staging's order page",
    () => {
      assert.deepEqual(check(staging, "staging"), []);
    });

  it("carries no trace of any of it in production, in any file", () => {
    assert.deepEqual(check(production, "production"), []);
  });
});
