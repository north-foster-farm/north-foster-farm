// #294: the toolbar, its clock and the order page's sandbox card
// overlay are built into staging's pages and never into production's.
// The pickup picker's state switcher (#573) is on staging and deploy
// previews and never in production. Builds the site each way with
// Hugo, as Netlify's contexts do, and holds each to
// bin/check-staging.mjs. Where Hugo is not installed
// (CI's test job), CI's build job runs the same check on its builds.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { check } from "../bin/check-staging.mjs";
import { checkHtml } from "../bin/grid/check.mjs";

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
  timeout: 180_000, skip: !hasHugo && "Hugo is not installed here",
}, () => {
  let production;
  let staging;
  let preview;

  before(() => {
    production = build("production");
    staging = build("branch-deploy");
    preview = build("deploy-preview");
  });
  after(() => {
    for (const dir of [production, staging, preview]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  // The pickup picker's state switcher (#573): on staging and deploy
  // previews, and in production nowhere (the TRACES of the next test).
  it("puts the picker's state switcher on a deploy preview, alone", () => {
    assert.deepEqual(check(preview, "preview"), []);
  });

  // The picker's three homes hold to Bootstrap's grid rules, as
  // check:grid holds every page in CI's build job (#573).
  it("keeps the picker's pages to the grid rules", () => {
    for (const page of ["order", "account"]) {
      const html = readFileSync(join(production, page, "index.html"),
        "utf8");
      const errors = checkHtml(html).filter((f) => f.level === "error");

      assert.deepEqual(errors, [], page);
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
