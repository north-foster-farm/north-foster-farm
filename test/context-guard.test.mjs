// Criteria tests for #713 (bin/nff --production falls back to memory
// stores and reports success), one per box of its "Done when", each
// named for its box. Written before the fix, by a test agent; the
// implementer turns the file on by renaming it to
// context-guard.test.mjs.
//
// Each test runs the whole of bin/nff as a child process, from a
// temporary root: every top-level entry of this checkout is linked in
// except .env*, .netlify, .git and .ignored, and node keeps the links
// (--preserve-symlinks-main), so bin/nff's root is that folder. No real
// env file or Netlify link is seen, wherever the suite runs. The test
// writes the env file a case needs, or leaves it out. `security` is a
// stub on PATH that prints a fake token, as in netlify-cli.test.mjs,
// so the Keychain is never asked. With no site ID nothing can reach
// Blobs, so no store but memory is ever opened.
//
// The command is the one from the issue: `perks add <email>
// free-delivery --yes`, which opens stores, writes a perk and a
// customer record and logs `perk.added`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_TOKEN = "nfp_fake-guard-token-7130";
const EMAIL = "guard-test@example.com";
const PERKS_ADD = ["perks", "add", EMAIL, "free-delivery", "--yes"];
const LEFT_OUT = new Set([".git", ".ignored", ".netlify"]);
const notMac = process.platform !== "darwin";

// A root of links to this checkout, with no env file and no Netlify
// link, and a bin folder holding the `security` stub. -> its paths.
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "nff-713-"));
  const repo = join(dir, "repo");
  const stubs = join(dir, "stubs");
  const keychainLog = join(dir, "keychain.log");

  mkdirSync(repo);
  mkdirSync(stubs);
  for (const name of readdirSync(root)) {
    if (LEFT_OUT.has(name) || name.startsWith(".env")) continue;
    symlinkSync(join(root, name), join(repo, name));
  }
  writeFileSync(join(stubs, "security"),
    `#!/bin/sh\necho called >> "${keychainLog}"\necho ${FAKE_TOKEN}\n`);
  chmodSync(join(stubs, "security"), 0o755);

  return { dir, repo, stubs, keychainLog };
};

// Run bin/nff in that root, with an environment of our own: no NETLIFY_*,
// no MAIL_DRIVER, nothing from the shell but a PATH.
const runNff = (where, args) => spawnSync(process.execPath, [
  "--preserve-symlinks", "--preserve-symlinks-main",
  join(where.repo, "bin", "nff"), ...args,
], {
  cwd: where.repo,
  encoding: "utf8",
  timeout: 60_000,
  env: {
    PATH: `${where.stubs}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: where.dir,
    TZ: "America/New_York",
  },
});

const both = (r) => `${r.stdout}\n${r.stderr}`;

// The stderr without the two lines bin/nff prints today whatever goes
// wrong: the unset-MAIL_DRIVER warning, which names .env.production and
// .env.staging, and the memory-store warning, which names
// NETLIFY_SITE_ID. Neither may stand in for the refusal's message.
const refusal = (r) => r.stderr.split("\n")
  .filter((line) => !/^Mail: MAIL_DRIVER is not set/.test(line))
  .filter((line) => !/using memory stores/.test(line))
  .join("\n");

// What a run that touched stores leaves in its output: the fallback's
// warning, the success line and the perk's log line.
const assertTouchedNothing = (r) => {
  const text = both(r);

  assert.doesNotMatch(text, /using memory stores/, "no fallback to memory");
  assert.doesNotMatch(text, /Added free-delivery/, "no success line");
  assert.doesNotMatch(text, /perk\.added/, "no log line");
};

describe("bin/nff with a context flag (#713)", () => {
  it("with a context flag and no NETLIFY_SITE_ID, any command that would "
    + "open stores exits non-zero before touching them, naming the site ID "
    + "and where it comes from, and writes nothing, not even a log line",
  { skip: notMac && "the Keychain stub needs macOS" }, () => {
    const where = makeRoot();

    try {
      // The env file is there, so only the site ID is missing.
      writeFileSync(join(where.repo, ".env.production"),
        "# Test file for #713: every key but NETLIFY_SITE_ID.\n"
        + "SITE_URL=https://example.test\nSQUARE_ENV=sandbox\n");

      const r = runNff(where, ["--production", ...PERKS_ADD]);

      assert.notEqual(r.status, 0, `exits non-zero:\n${both(r)}`);
      assert.match(refusal(r), /NETLIFY_SITE_ID/, "names the site ID");
      assert.match(refusal(r),
        /\.env\.production|\.netlify|netlify link|main checkout/i,
        "says where the site ID comes from");
      assertTouchedNothing(r);
    } finally {
      rmSync(where.dir, { recursive: true, force: true });
    }
  });

  it("with a context flag and no env file for that context, the command "
    + "exits non-zero naming the missing file",
  { skip: notMac && "the Keychain stub needs macOS" }, () => {
    const where = makeRoot();

    try {
      for (const [flag, file] of [
        ["--production", ".env.production"],
        ["--staging", ".env.staging"],
        ["--preview", ".env.staging"],
      ]) {
        assert.ok(!existsSync(join(where.repo, file)), `no ${file}`);

        const r = runNff(where, [flag, ...PERKS_ADD]);

        assert.notEqual(r.status, 0, `${flag} exits non-zero:\n${both(r)}`);
        assert.ok(refusal(r).includes(file),
          `${flag} names ${file}:\n${r.stderr}`);
        assertTouchedNothing(r);
      }
    } finally {
      rmSync(where.dir, { recursive: true, force: true });
    }
  });

  it("with no context flag, development still runs on memory stores as "
    + "today", () => {
    const where = makeRoot();

    try {
      const r = runNff(where, PERKS_ADD);

      assert.equal(r.status, 0, `exits 0:\n${both(r)}`);
      assert.match(r.stderr, /using memory stores/,
        "says it runs on memory stores");
      assert.match(r.stdout, new RegExp(`Added free-delivery for ${EMAIL}`),
        "the command runs and reports what it did");
      // Development never asks the Keychain (#267).
      assert.ok(!existsSync(where.keychainLog), "no Keychain lookup");
      assert.ok(!both(r).includes(FAKE_TOKEN), "no token printed");
    } finally {
      rmSync(where.dir, { recursive: true, force: true });
    }
  });
});

// The temporary root really is bin/nff's root: an env file written
// there is the one it reads. Without this, a run from a checkout with
// real env files could pass or fail for the wrong reason.
describe("the temporary root these tests run from", () => {
  it("is the root bin/nff reads its env file from", () => {
    const where = makeRoot();

    try {
      const real = readFileSync(join(where.repo, "bin", "nff"), "utf8");

      assert.match(real, /loadEnv\(join\(root/, "bin/nff reads from root");
      // The development file, and a MAIL_DRIVER only it sets: the
      // warning about an unset driver goes away.
      writeFileSync(join(where.repo, ".env"), "MAIL_DRIVER=outbox\n");

      const r = runNff(where, ["perks", "list"]);

      assert.equal(r.status, 0, both(r));
      assert.doesNotMatch(r.stderr, /MAIL_DRIVER is not set/);
    } finally {
      rmSync(where.dir, { recursive: true, force: true });
    }
  });
});
