#!/usr/bin/env node
// Fails the deploy when a key the env sample lists for this context
// is missing or empty (#264, S8). Netlify can't read a file into its
// environment, so this is the nearest thing: the build holds the
// context to its tracked sample. Netlify runs it in every build
// command; a failed build leaves the last good deploy live. Names
// only, never values.
//
//   node bin/check-env.mjs            the build's own context
//   node bin/check-env.mjs staging    a named sample, against this shell
//   node bin/check-env.mjs staging <file>    that sample from a file
//
// Production builds check .env.production.sample, the staging branch
// .env.staging.sample. Previews and other branches have no sample and
// pass. So does a context whose sample isn't committed yet.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEnvironment, missingAtBuild } from "./env/netlify.mjs";
import { ENVIRONMENTS, readSample, sampleFile } from "./env/sample.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const named = process.argv[2];

if (named && !ENVIRONMENTS.includes(named)) {
  console.error(`Env check: which sample? ${ENVIRONMENTS.join(", ")}.`);
  process.exit(1);
}

const env = named || buildEnvironment(process.env);
const file = env && (process.argv[3] || sampleFile(env));

if (!env) {
  const where = process.env.CONTEXT || "this shell";

  console.log(`Env check: no sample for ${where}; nothing to check.`);
  process.exit(0);
}
if (!existsSync(resolve(root, file))) {
  console.log(`Env check: no ${file} yet; nothing to check.`);
  process.exit(0);
}

const sample = readSample(readFileSync(resolve(root, file), "utf8"), env);
const missing = missingAtBuild(sample, process.env);

// A layout slip in the sample is James's to tidy, not a reason to
// stop a deploy whose keys are all there.
for (const error of sample.errors) {
  console.error(`Env check: warning, ${file}: ${error}`);
}

if (missing.length) {
  for (const name of missing) {
    console.error(`  ${name} is missing (bin/nff env push --${env}).`);
  }
  console.error(`Env check: ${file} doesn't hold.`);
  process.exit(1);
}

console.log(`Env check: all ${sample.keys.length} keys in ${file} are set.`);
