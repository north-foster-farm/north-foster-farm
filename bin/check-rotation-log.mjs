#!/usr/bin/env node
// Fails a lint-and-test run when a secret has no line in
// docs/rotation-log.md. The yearly reminder (lib/rotation.mjs) lists
// only the secrets the log names, so a secret missing from it would
// silently never rotate.
//
// The secrets are the rows of docs/secrets.md's table whose Kind is a
// secret, a ping URL or a hook URL, and every name in the development,
// staging or production sample that ends in SECRET, TOKEN, PASSWORD
// or _KEY. A row marked old (retired
// at launch) or optional (the previous key during a swap, logged under
// the key it replaces) is left out.
//
//   node bin/check-rotation-log.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseRotationLog } from "../netlify/functions/lib/rotation.mjs";
import { ENVIRONMENTS, sampleFile } from "./env/sample.mjs";

const SECRETISH = /(?:SECRET|TOKEN|PASSWORD|_KEY)$/;
const SECRET_KIND = /^secret|URL/;
const LEFT_OUT = /\b(?:old|optional)\b/;

// The names an env sample declares, with or without a value.
export const sampleNames = (text) => String(text).split("\n")
  .map((line) => /^([A-Z][A-Z0-9_]*)=?\s*$|^([A-Z][A-Z0-9_]*)=/.exec(line))
  .filter(Boolean)
  .map((m) => m[1] || m[2]);

// The three tracked samples as one text, so a name any environment
// declares is counted once. `read` takes a repo-relative path.
export const readSamples = (read) => ENVIRONMENTS
  .map((env) => read(sampleFile(env))).join("\n");

// The rows of secrets.md's table: { names, kind }. A name in backticks
// is an env name; "_SUFFIX" stands for every sample name ending in it;
// a row with no backticks names a secret in words ("The age private
// key" -> "age private key").
export const secretRows = (text, sample) => {
  const rows = [];
  let inTable = false;

  for (const line of String(text).split("\n")) {
    if (/^\|\s*Name\s*\|\s*Kind\s*\|/.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (/^\|\s*-/.test(line)) continue;

    const [first, kind = ""] = line.split("|").slice(1).map((c) => c.trim());
    const ticks = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const names = ticks.length
      ? ticks.flatMap((t) => t.startsWith("_")
        ? sample.filter((n) => n.endsWith(t))
        : [t])
      : [first.replace(/^The\s+/i, "")];

    rows.push({ names, kind });
  }

  return rows;
};

// Every name the log must carry, from both sources.
export const requiredNames = (secretsText, sampleText) => {
  const sample = sampleNames(sampleText);
  const names = new Set(sample.filter((n) => SECRETISH.test(n)));

  for (const { names: rowNames, kind } of secretRows(secretsText, sample)) {
    if (!SECRET_KIND.test(kind) || LEFT_OUT.test(kind)) continue;
    for (const name of rowNames) names.add(name);
  }

  return [...names].sort();
};

// -> the required names the log has no line for.
export const missingFromLog = (required, logText) => {
  const logged = new Set(parseRotationLog(logText)
    .map((e) => e.name.toLowerCase()));

  return required.filter((name) => !logged.has(name.toLowerCase()));
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (path) => readFileSync(join(root, path), "utf8");
  const required = requiredNames(read("docs/secrets.md"),
    readSamples(read));
  const missing = missingFromLog(required, read("docs/rotation-log.md"));

  if (missing.length) {
    console.error(`Rotation log: ${missing.length} secret(s) have no line ` +
      "in docs/rotation-log.md, so the yearly reminder would never " +
      "name them:");
    for (const name of missing) console.error(`  ${name}`);
    console.error("Add a seed line for each (docs/secrets.md, " +
      '"Schedule").');
    process.exit(1);
  }

  console.log(`Rotation log: all ${required.length} secrets have a line.`);
}
