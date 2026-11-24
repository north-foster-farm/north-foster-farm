// `env` under a context flag is not refused by the memory-store guard
// (#713, #722): `env filled` reads two files and needs no token, and
// the other env commands name a missing site ID themselves. The
// implementer's own test, beside the criteria tests in
// context-guard.test.mjs. bin/nff runs from a temporary root of links
// to this checkout, with no real env file and nothing from the shell
// but a PATH. `env filled` never asks the Keychain, so no stub is
// needed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEFT_OUT = new Set([".git", ".ignored", ".netlify"]);

const sample = (env) => [
  `### .env.${env}.sample`, "",
  "## Netlify", "##", "## Where.", "",
  "# NETLIFY_SITE_ID", "# The project.", "# Local only: bin/nff reads it.",
  "NETLIFY_SITE_ID=", "",
].join("\n");

// A root with a sample and an env file for `env`, the rest linked in.
const withRoot = (env, envText, body) => {
  const dir = mkdtempSync(join(tmpdir(), "nff-722-"));
  const repo = join(dir, "repo");

  try {
    mkdirSync(repo);
    for (const name of readdirSync(root)) {
      if (LEFT_OUT.has(name) || name.startsWith(".env")) continue;
      symlinkSync(join(root, name), join(repo, name));
    }
    writeFileSync(join(repo, `.env.${env}.sample`), sample(env));
    writeFileSync(join(repo, `.env.${env}`), envText);

    return body(dir, repo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runNff = (dir, repo, args) => spawnSync(
  process.execPath, [
    "--preserve-symlinks", "--preserve-symlinks-main",
    join(repo, "bin", "nff"), ...args,
  ], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      TZ: "America/New_York",
    },
  },
);

describe("env under a context flag (#722)", () => {
  for (const env of ["production", "staging"]) {
    it(`env filled --${env} with a filled file and no token reaches `
      + "envFilled() and exits 0", () => {
      withRoot(env, "NETLIFY_SITE_ID=probe-site\n", (dir, repo) => {
        const r = runNff(dir, repo, ["env", "filled", `--${env}`]);

        assert.equal(r.status, 0, r.stderr);
        assert.doesNotMatch(r.stderr, /refusing memory stores/);
        assert.match(r.stdout,
          new RegExp(`\\.env\\.${env} fills 1 of the 1 keys`));
      });
    });
  }
});
