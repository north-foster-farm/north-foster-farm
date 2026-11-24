// The CLI's other list-walking commands log who ran them when they
// clean an old twin (#794, security on PR #849): groups members, its
// --backfill, members sync, customers list and audience sync. An
// addition beside test/address-key-followups.test.mjs, by the
// implementer. The host's page (hostMembers) stays "site".

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { listCustomers } from "../netlify/functions/lib/admin.mjs";
import {
  backfillJoins, groupMembers,
} from "../netlify/functions/lib/group-log.mjs";
import { hostMembers } from "../netlify/functions/lib/membership.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUS = "pat+dog@example.com";
const SPACED = "pat dog@example.com";
const BY = "tester";
const GROUP = "vff";

const hashed = (email) => createHash("sha256").update(email)
  .digest("base64url");

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

const cleanedBy = (lines) => lines
  .filter((l) => l.includes("store.leftover-deleted"))
  .map((l) => JSON.parse(l).by);

// A member under the space its "+" became before #758, and the record
// its hashed key holds since: the old one is a twin to clean.
const memberTwin = () => {
  const stores = testStores();
  const c = stores.customers.data;
  const record = {
    email: PLUS, name: "Pat",
    memberGroup: { id: GROUP, joinedAt: "2026-11-01T12:00:00Z" },
  };

  c.set(`customer/${SPACED}`, record);
  c.set(`customer/${hashed(PLUS)}`, record);

  return stores;
};

// One `case "<command>":` of bin/nff's switch, up to the next case.
const caseOf = (source, command) => {
  const start = source.indexOf(`case "${command}":`);

  assert.ok(start >= 0, `bin/nff has a case for ${command}`);

  const next = source.indexOf("\n  case \"", start + 1);

  return source.slice(start, next < 0 ? undefined : next);
};

describe("CLI list-walkers log who ran them (#794)", () => {
  for (const [what, run] of [
    ["groupMembers", (s) => groupMembers(s, GROUP, { by: BY })],
    ["backfillJoins", (s) => backfillJoins(s, GROUP, { by: BY })],
    ["listCustomers", (s) => listCustomers(s, { by: BY })],
  ]) {
    it(`${what} logs the twin it cleans as by`, async (t) => {
      const lines = capture(t);

      await run(memberTwin());

      assert.deepEqual(cleanedBy(lines), [BY]);
    });
  }

  it("the host's page still logs as the site", async (t) => {
    const lines = capture(t);

    await hostMembers(memberTwin(), GROUP);

    assert.deepEqual(cleanedBy(lines), ["site"]);
  });

  it("bin/nff and bin/members.mjs pass who ran them", () => {
    const nff = readFileSync(join(root, "bin/nff"), "utf8");

    for (const command of [
      "groups members", "customers list", "audience sync",
    ]) {
      const block = caseOf(nff, command);
      const calls = block.match(/userInfo\(\)\.username/g) || [];

      assert.ok(calls.length >= (command === "groups members" ? 2 : 1),
        `bin/nff ${command} passes who ran it`);
    }

    const members = readFileSync(join(root, "bin/members.mjs"), "utf8");

    assert.match(members,
      /groupMembers\(stores, g\.key, \{\s*by: userInfo\(\)\.username/,
      "members sync passes who ran it");
  });

  it("their usage says they may clean up old copies", () => {
    const run = spawnSync(process.execPath, [join(root, "bin/nff")], {
      cwd: root, encoding: "utf8", env: { PATH: process.env.PATH },
    });
    const lines = `${run.stdout}${run.stderr}`.split("\n");

    for (const command of [
      "customers list", "groups members", "members sync", "audience sync",
    ]) {
      const at = lines.findIndex((l) => l.startsWith(`  bin/nff ${command}`));

      assert.ok(at >= 0, `the usage has a line for ${command}`);

      const rest = lines.slice(at + 1);
      const end = rest.findIndex((l) => /^ {2}\S/.test(l) || !l.trim());
      const entry = [lines[at], ...rest.slice(0, end < 0 ? rest.length : end)]
        .join(" ").replace(/\s+/g, " ");

      assert.match(entry, /old copies of records/,
        `bin/nff ${command}'s usage says it may clean old copies`);
    }
  });
});
