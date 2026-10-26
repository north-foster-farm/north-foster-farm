import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFilled } from "../bin/env/filled.mjs";
import { OPTIONAL } from "../bin/env/netlify.mjs";
import {
  ENVIRONMENTS, parseSample, readSample, sampleFile,
} from "../bin/env/sample.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const samples = Object.fromEntries(ENVIRONMENTS.map((env) => [env,
  readFileSync(join(root, sampleFile(env)), "utf8")]));
const parsed = Object.fromEntries(ENVIRONMENTS.map((env) =>
  [env, parseSample(samples[env])]));
const listed = new Set(ENVIRONMENTS.flatMap((env) =>
  parsed[env].entries.map((e) => e.name)));

// What the runtime code reads from the environment that no sample lists,
// and why. Anything else it reads belongs in a sample, with a comment.
const NOT_IN_A_SAMPLE = {
  // Netlify's own, per build and per function.
  CONTEXT: "Netlify's deploy context",
  COMMIT_REF: "Netlify's commit",
  DEPLOY_ID: "Netlify's deploy",
  DEPLOY_PRIME_URL: "Netlify's deploy URL",
  URL: "Netlify's site URL",
  AWS_LAMBDA_FUNCTION_NAME: "the functions runtime's",
  LAMBDA_TASK_ROOT: "the functions runtime's",
  NETLIFY_DEV: "set by netlify dev",
  NETLIFY_BLOBS_CONTEXT: "Netlify's Blobs credentials, in a function",
  // GitHub Actions' own, or a repository secret or variable there.
  GITHUB_ACTIONS: "GitHub Actions",
  GITHUB_BRANCH: "set by the audit's workflow",
  GITHUB_OUTPUT: "GitHub Actions",
  GITHUB_REPOSITORY: "GitHub Actions",
  GITHUB_STEP_SUMMARY: "GitHub Actions",
  GITHUB_TOKEN: "GitHub Actions",
  BASE_SHA: "the CodeQL gate's workflow",
  REF: "the CodeQL gate's workflow",
  SHA: "the CodeQL gate's workflow",
  RUN_OUTCOME: "the e2e summary's workflow",
  PROD_AUDIT_PING_URL: "a GitHub Actions secret, not Netlify's",
  PROD_URL: "a GitHub Actions variable, not Netlify's",
  // Kept elsewhere on purpose.
  NETLIFY_AUTH_TOKEN: "the macOS Keychain only (#363), never an env file",
  PICKUP_SCHEDULE: "set by `bin/nff schedule set`, which env check ignores",
  // A developer's own override of a local tool.
  HUGO_PORT: "set by npm run start:functions for its own Hugo",
  NEWS_BUILD_DIR: "where `bin/nff news mail` finds a local Hugo build",
};

const NAME = "[A-Z][A-Z0-9_]{2,}";
const READS = [
  new RegExp(`\\benv\\.(${NAME})\\b`, "g"),
  new RegExp(`\\benv\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
];
const DESTRUCTURED = /const\s*\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g;

const sources = (dir) => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sources(path);
    }

    return /\.(mjs|js)$/.test(entry.name) || (dir === "bin"
      && !entry.name.includes(".")) ? [path] : [];
  });

// Every name the runtime code reads, and one file that does.
const reads = () => {
  const found = new Map();
  const note = (name, file) => { if (!found.has(name)) found.set(name, file); };

  for (const file of ["netlify/functions", "bin", "plugins"].flatMap(sources)) {
    const text = readFileSync(join(root, file), "utf8");

    for (const pattern of READS) {
      for (const m of text.matchAll(pattern)) note(m[1], file);
    }
    for (const m of text.matchAll(DESTRUCTURED)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/[\s:=]/)[0];

        if (new RegExp(`^${NAME}$`).test(name)) note(name, file);
      }
    }
  }

  return found;
};

describe("the tracked env samples", () => {
  it("parse with no layout errors, each key under a comment", () => {
    for (const env of ENVIRONMENTS) {
      assert.deepEqual(parsed[env].errors, [], sampleFile(env));
      assert.deepEqual(readSample(samples[env], env).errors, [],
        `${sampleFile(env)} read as ${env}`);
    }
    for (const env of ENVIRONMENTS) {
      for (const e of parsed[env].entries) {
        assert.ok(e.purpose.join("").trim().length > 10,
          `${e.name} in ${sampleFile(env)} says what it is`);
      }
    }
  });

  it("list every key the runtime code reads, or say why not", () => {
    const missing = [...reads()]
      .filter(([name]) => !listed.has(name) && !NOT_IN_A_SAMPLE[name])
      .map(([name, file]) => `${name} (${file})`);

    assert.deepEqual(missing, [], "a key the code reads is in no sample: " +
      "add it, with a comment, to the sample for each environment that " +
      "uses it, or to NOT_IN_A_SAMPLE here with the reason");
  });

  it("keep no exemption the code no longer needs", () => {
    const read = reads();
    const stale = Object.keys(NOT_IN_A_SAMPLE)
      .filter((name) => !read.has(name) || listed.has(name));

    assert.deepEqual(stale, [],
      "NOT_IN_A_SAMPLE names a key that is gone, or is now in a sample");
  });

  it("mark as Optional: every key the tooling lets stay empty", () => {
    for (const env of ["staging", "production"]) {
      for (const name of OPTIONAL) {
        const entry = parsed[env].entries.find((e) => e.name === name);

        if (entry) {
          assert.equal(entry.optional, true,
            `${name} in ${sampleFile(env)} says Optional:`);
        }
      }
    }
  });

  it("are satisfied by a file that fills every key not marked Optional:",
    () => {
      for (const env of ENVIRONMENTS) {
        const file = `.env.${env}`;
        const text = `${parsed[env].entries.filter((e) => !e.optional)
          .map((e) => `${e.name}=filled-${e.name.toLowerCase()}`)
          .join("\n")}\n`;
        const read = (path) => (path.endsWith(".sample")
          ? samples[env] : text);
        const found = checkFilled(root, env, { read });

        assert.deepEqual(found.problems, [], file);
        assert.equal(found.filled + found.optional.length,
          parsed[env].entries.length, file);
      }
    });
});
