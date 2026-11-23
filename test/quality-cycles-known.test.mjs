// The known import cycles may only shrink (#782 step 8; the exception
// on #791, Rule exceptions log; the untangling is #925).
// npm run lint:cycles ignores the cycles in
// .dependency-cruiser-known-violations.json and fails on any other.
// These tests hold that file and the cycles it names: it gains no
// entry and keeps none that no longer occurs, and no change adds an
// import between two modules that already sit on a cycle.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, tag } from "./quality-gate.mjs";

const KNOWN = ".dependency-cruiser-known-violations.json";
const CEILING = 34;

// Every import that lay on a cycle when the file was written, as
// "from -> to" under netlify/functions/. One may go; none may join.
const CYCLE_EDGES = new Set([
  "lib/account.mjs -> lib/admin.mjs",
  "lib/account.mjs -> lib/amend.mjs",
  "lib/account.mjs -> lib/jobs.mjs",
  "lib/address-key.mjs -> lib/store.mjs",
  "lib/admin.mjs -> lib/amend.mjs",
  "lib/admin.mjs -> lib/farm-orders.mjs",
  "lib/amend.mjs -> lib/edit.mjs",
  "lib/auth-records.mjs -> lib/log.mjs",
  "lib/auth.mjs -> lib/auth-records.mjs",
  "lib/auth.mjs -> lib/clock.mjs",
  "lib/auth.mjs -> lib/mail.mjs",
  "lib/auth.mjs -> lib/records.mjs",
  "lib/auth.mjs -> lib/templates.mjs",
  "lib/breaker.mjs -> lib/health.mjs",
  "lib/breaker.mjs -> lib/resend-guard.mjs",
  "lib/clock.mjs -> lib/store.mjs",
  "lib/edit.mjs -> lib/account.mjs",
  "lib/edit.mjs -> lib/admin.mjs",
  "lib/fake-paypal.mjs -> lib/paypal.mjs",
  "lib/fake-square.mjs -> lib/square.mjs",
  "lib/farm-orders.mjs -> lib/account.mjs",
  "lib/farm-orders.mjs -> lib/edit.mjs",
  "lib/farm-orders.mjs -> orders.mjs",
  "lib/health.mjs -> lib/log.mjs",
  "lib/health.mjs -> lib/mail.mjs",
  "lib/health.mjs -> lib/maintenance.mjs",
  "lib/health.mjs -> lib/templates.mjs",
  "lib/jobs.mjs -> lib/admin.mjs",
  "lib/jobs.mjs -> lib/edit.mjs",
  "lib/jobs.mjs -> lib/rounds.mjs",
  "lib/log.mjs -> lib/clock.mjs",
  "lib/log.mjs -> lib/health.mjs",
  "lib/log.mjs -> lib/store.mjs",
  "lib/mail.mjs -> lib/breaker.mjs",
  "lib/mail.mjs -> lib/clock.mjs",
  "lib/mail.mjs -> lib/resend-guard.mjs",
  "lib/mail.mjs -> lib/store.mjs",
  "lib/maintenance.mjs -> lib/auth.mjs",
  "lib/maintenance.mjs -> lib/log.mjs",
  "lib/maintenance.mjs -> lib/mail.mjs",
  "lib/maintenance.mjs -> lib/templates.mjs",
  "lib/paypal.mjs -> lib/fake-paypal.mjs",
  "lib/records.mjs -> lib/address-key.mjs",
  "lib/records.mjs -> lib/auth-records.mjs",
  "lib/records.mjs -> lib/clock.mjs",
  "lib/resend-guard.mjs -> lib/store.mjs",
  "lib/rounds.mjs -> lib/account.mjs",
  "lib/square.mjs -> lib/fake-square.mjs",
  "lib/store.mjs -> lib/log.mjs",
  "lib/templates.mjs -> lib/clock.mjs",
  "lib/templates.mjs -> lib/pickups.mjs",
  "lib/templates.mjs -> lib/records.mjs",
  "orders.mjs -> lib/account.mjs",
]);

// The criteria tests seed cycles of their own beside the code while
// these run; their files, named for the seeding process, are left out.
const SEEDS = `${tag.replace(/\d+$/, "")}[0-9]+-`;

const cruise = () => JSON.parse(execFileSync(
  join(root, "node_modules/.bin/depcruise"),
  ["--config", ".dependency-cruiser.json", "--no-ignore-known",
    "--exclude", SEEDS,
    "--output-type", "json", "assets/scripts", "netlify", "bin",
    "plugins", "test", "e2e"],
  { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
));
const short = (path) => path.replace(/^netlify\/functions\//, "");
const key = (cycle) => cycle.map((step) => step.name ?? step).join(" -> ");

describe("#782 step 8: the known import cycles only shrink", () => {
  let known;
  let found;
  before(() => {
    known = JSON.parse(readFileSync(join(root, KNOWN), "utf8"));
    found = cruise();
  });

  it(`the known-violations file holds at most ${CEILING} cycles, ` +
    "and nothing else", () => {
    const other = known.filter((v) => v.rule?.name !== "no-circular");
    assert.deepEqual(other, [], "an entry that is not a cycle");
    assert.ok(known.length <= CEILING,
      `${known.length} known cycles; the ceiling is ${CEILING}`);
  });

  it("every known cycle still occurs", () => {
    const now = new Set(found.summary.violations
      .filter((v) => v.rule.name === "no-circular")
      .map((v) => key(v.cycle)));
    const gone = known.map((v) => key(v.cycle))
      .filter((cycle) => !now.has(cycle));
    assert.deepEqual(gone, [],
      `cycles that no longer occur: drop them from ${KNOWN}`);
  });

  it("no new import lies on a cycle", () => {
    const added = found.modules.flatMap((m) => m.dependencies
      .filter((d) => d.circular)
      .map((d) => `${short(m.source)} -> ${short(d.resolved)}`))
      .filter((edge) => !CYCLE_EDGES.has(edge));
    assert.deepEqual(added, [], "imports that close or widen a cycle");
  });
});
