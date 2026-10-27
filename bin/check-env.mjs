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

import {
  buildEnvironment, isOptional, missingAtBuild, retiredIn, stagingOnlyIn,
} from "./env/netlify.mjs";
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
const staged = stagingOnlyIn(env, Object.keys(process.env));

// A layout slip in the sample is James's to tidy, not a reason to
// stop a deploy whose keys are all there.
for (const error of sample.errors) {
  console.error(`Env check: warning, ${file}: ${error}`);
}

const retired = retiredIn([...sample.keys, ...sample.local,
  ...Object.keys(process.env)]);

if (retired.length) {
  for (const name of retired) {
    console.error(`  ${name} is retired: unset it, and drop it from the ` +
      "sample. Use FARM_, DEV_ and ESCALATED_NOTIFICATIONS_EMAIL.");
  }
  console.error("Env check: a retired key is still set.");
  process.exit(1);
}
if (staged.length) {
  for (const name of staged) {
    console.error(`  ${name} is staging only: unset it on production.`);
  }
  console.error("Env check: production holds a staging key.");
  process.exit(1);
}
if (missing.length) {
  console.error(`Required for a ${env} build, and not set:`);
  for (const name of missing) console.error(`  ${name}`);
  console.error(`Fix: bin/nff env push --${env}. Not required here (a ${
    env} build passes without them): ${
    sample.keys.filter((n) => isOptional(sample, n)).join(", ") || "none"
  }.`);
  console.error(`Env check: ${file} doesn't hold.`);
  process.exit(1);
}

console.log(`Env check: all ${sample.keys.length} keys in ${file} are set.`);
