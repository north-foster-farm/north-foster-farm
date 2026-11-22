// Criteria tests for #794 (Address-key follow-ups from security on
// #787), one per box of its "Done when" that a test can check, written
// before the code. Held out of `npm test` (*.criteria.mjs) until the
// implementer renames it to address-key-followups.test.mjs.
//
// The seam these tests assume:
//
// - `by`, who acted, rides in the options of each function a
//   list-walking CLI command calls, down to `listLatest`'s own `by`:
//   `allCustomers(stores, { by })` (lib/records.mjs),
//   `sweepStrandedCredit(stores, { by, now })` (lib/credit.mjs),
//   `listPerks(stores, { by, now })` (lib/perks.mjs),
//   `quietCustomers(stores, now, { by })` (lib/admin.mjs) and
//   `sendOwedWelcomes(stores, { by, dryRun })` (lib/news.mjs). Left
//   out, it stays "site", as the functions run it. bin/nff passes its
//   `userInfo().username` in the case of each of `perks list`,
//   `customers quiet`, `audience welcome` and `jobs run` (the
//   stranded-credit sweep's one way in from the CLI).
// - A twin cleaned is logged as today: event "store.leftover-deleted",
//   `by`, the key masked.
// - Rekey's report (lib/rekey.mjs) names a record that vanished
//   between its plan and its move in one of its lists, with the move's
//   `store`, `from` and `to` and a `why`; it is not in `moved` or
//   `cleaned`, nothing is written at its hashed key, and no
//   "store.rekeyed" line is logged for it.
//
// The usage box is tested because the CLI's tests already read its
// usage text (test/completion.test.mjs, test/e2e-help.test.mjs). The
// runbook box is a step in a doc, for the release, and has no test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { quietCustomers } from "../netlify/functions/lib/admin.mjs";
import { sweepStrandedCredit } from "../netlify/functions/lib/credit.mjs";
import { sendOwedWelcomes } from "../netlify/functions/lib/news.mjs";
import { listPerks } from "../netlify/functions/lib/perks.mjs";
import { allCustomers } from "../netlify/functions/lib/records.mjs";
import { rekeyRecords } from "../netlify/functions/lib/rekey.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUS = "pat+dog@example.com";
const SPACED = "pat dog@example.com";
const SAM = "sam@example.com";
const BY = "tester";
const NOW = new Date("2026-11-22T15:00:00Z");

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

const logged = (lines, event) => lines.filter((l) => l.includes(event))
  .map((l) => JSON.parse(l));

// A customer under the space its "+" became before the switch, and the
// record its hashed key holds since: the old one is a twin to clean.
const customerTwin = () => {
  const stores = testStores();
  const c = stores.customers.data;

  c.set(`customer/${SPACED}`, { email: PLUS, name: "Pat" });
  c.set(`customer/${hashed(PLUS)}`, { email: PLUS, name: "Pat" });

  return stores;
};

// The same for a credit ledger.
const creditTwin = () => {
  const stores = testStores();
  const c = stores.customers.data;

  c.set(`credit/${SPACED}`, { email: PLUS, entries: [] });
  c.set(`credit/${hashed(PLUS)}`, { email: PLUS, entries: [] });

  return stores;
};

// The CLI's usage, as it prints it with no command.
const usage = () => {
  const run = spawnSync(process.execPath, [join(root, "bin/nff")], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH },
  });

  return `${run.stdout}${run.stderr}`;
};

// One command's entry in the usage: its `bin/nff` line and the
// description under it, up to the next command, on one line.
const entry = (text, command) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`  bin/nff ${command}`));

  assert.ok(at >= 0, `the usage has a line for ${command}`);

  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || !l.trim());

  return [lines[at], ...rest.slice(0, end < 0 ? rest.length : end)]
    .join(" ").replace(/\s+/g, " ");
};

// One `case "<command>":` of bin/nff's switch, up to the next case.
const caseOf = (source, command) => {
  const start = source.indexOf(`case "${command}":`);

  assert.ok(start >= 0, `bin/nff has a case for ${command}`);

  const next = source.indexOf("\n  case \"", start + 1);

  return source.slice(start, next < 0 ? undefined : next);
};

describe("address-key follow-ups (#794)", () => {
  it("1. a CLI run that cleans a twin logs who ran it, not site",
    async (t) => {
      const lines = capture(t);
      const runs = [
        ["allCustomers", customerTwin, (s) => allCustomers(s, { by: BY })],
        ["sweepStrandedCredit", creditTwin,
          (s) => sweepStrandedCredit(s, { by: BY, now: NOW })],
        ["listPerks (perks list)", customerTwin,
          (s) => listPerks(s, { by: BY, now: NOW })],
        ["quietCustomers (customers quiet)", customerTwin,
          (s) => quietCustomers(s, NOW, { by: BY })],
        ["sendOwedWelcomes (audience welcome)", customerTwin,
          (s) => sendOwedWelcomes(s, {
            by: BY, dryRun: true, now: NOW, env: {},
            mail: async () => {
              throw new Error("no mail in this test");
            },
          })],
      ];

      for (const [what, seed, run] of runs) {
        lines.length = 0;

        const stores = seed();

        await run(stores);

        const cleaned = logged(lines, "store.leftover-deleted");

        assert.equal(cleaned.length, 1, `${what} cleans the twin, logged`);
        assert.equal(cleaned[0].by, BY, `${what} logs who ran it`);
      }

      const source = readFileSync(join(root, "bin/nff"), "utf8");

      for (const command of [
        "perks list", "customers quiet", "audience welcome", "jobs run",
      ]) {
        const block = caseOf(source, command);

        assert.match(block, /userInfo\(\)\.username/,
          `bin/nff ${command} passes who ran it`);
      }
    });

  it("2. the dry-run usage lines say they may clean old twins", () => {
    const text = usage();

    for (const command of [
      "perks list", "customers quiet", "audience welcome",
    ]) {
      assert.match(entry(text, command), /\bold (twins?|cop(y|ies))\b/i,
        `bin/nff ${command}'s usage says it may clean old twins`);
    }
  });

  it("3. rekey skips a record that vanished mid-run and says so",
    async (t) => {
      const lines = capture(t);
      const stores = testStores();
      const c = stores.customers.data;
      const gone = `customer/${SAM}`;
      const to = `customer/${hashed(SAM)}`;

      c.set(`customer/${SPACED}`, { email: PLUS, name: "Pat" });
      c.set(gone, { email: SAM, name: "Sam" });

      // Rekey has planned the move once it looks at the hashed key;
      // the record is deleted then, as by a run elsewhere.
      const get = stores.customers.get.bind(stores.customers);

      stores.customers.get = async (key) => {
        if (key === to) c.delete(gone);

        return get(key);
      };

      const report = await rekeyRecords(stores, { apply: true, by: BY });
      const named = Object.values(report).filter(Array.isArray).flat()
        .filter((m) => m && m.from === gone);

      assert.ok(!report.moved.some((m) => m.from === gone),
        "the vanished record is not reported moved");
      assert.ok(!report.cleaned.some((m) => m.from === gone),
        "nor cleaned");
      assert.equal(named.length, 1, "the report names it once");
      assert.equal(named[0].store, "customers");
      assert.equal(named[0].to, to);
      assert.equal(typeof named[0].why, "string", "and says why");
      assert.ok(named[0].why.length > 0, "and says why");
      assert.equal(c.has(to), false, "nothing is written at its hashed key");
      assert.deepEqual(c.get(`customer/${hashed(PLUS)}`),
        { email: PLUS, name: "Pat" }, "the other record still moves");
      assert.equal(logged(lines, "store.rekeyed").length, 1,
        "one move logged, none for the vanished record");
    });
});
