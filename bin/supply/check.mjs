#!/usr/bin/env node
// Two supply chain checks over a lockfile, in one pass over the npm
// registry (a package's full record holds both the publish dates and
// the attestations):
//
//   cooldown     fails when the lockfile resolves a version published
//                less than 7 days ago, unless security/cooldown-
//                waivers.json names that exact package and version
//   attestation  fails when a package with no provenance attestation is
//                not in security/attestation-baseline.json, so James
//                approves each one before it joins
//
// `npm audit signatures` (a separate CI step) verifies the signatures
// and the attestations that do exist.
//
//   node bin/supply/check.mjs [package-lock.json ...]
//
// The log carries counts and package names only: a name and version
// are public, and no advisory detail is read here.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { newlyUnattested, resolvedPackages, tooNew } from "./lockfile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY = "https://registry.npmjs.org";
const COOLDOWN_DAYS = 7;
const PARALLEL = 8;

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
};

const fetchRecord = async (name, fetchImpl) => {
  const url = `${REGISTRY}/${name.replace("/", "%2F")}`;

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
      });

      if (!res.ok) throw new Error(`${name}: registry answered ${res.status}`);

      return await res.json();
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
};

// Publish dates and attestation flags for each package version.
export const registryFacts = async (packages, fetchImpl = fetch) => {
  const published = {};
  const attested = {};
  const names = [...new Set(packages.map((p) => p.name))];
  let next = 0;

  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      const record = await fetchRecord(name, fetchImpl);

      for (const { version } of packages.filter((p) => p.name === name)) {
        const key = `${name}@${version}`;

        published[key] = record.time?.[version];
        attested[key] = Boolean(record.versions?.[version]?.dist?.attestations);
      }
    }
  };

  await Promise.all(Array.from({ length: PARALLEL }, worker));

  return { published, attested };
};

export const run = async (lockPaths, { now = Date.now(), fetchImpl } = {}) => {
  const waivers = readJson(join(ROOT, "security/cooldown-waivers.json"), []);
  const baseline = readJson(
    join(ROOT, "security/attestation-baseline.json"), [],
  );
  let failed = false;

  for (const path of lockPaths) {
    const packages = resolvedPackages(readJson(path));
    const { published, attested } = await registryFacts(packages, fetchImpl);
    const { young, unknown } = tooNew(
      packages, published, now, COOLDOWN_DAYS, waivers,
    );
    const bare = newlyUnattested(packages, attested, baseline);

    console.log(`${path}: ${packages.length} packages`);
    console.log(`  cooldown: ${young.length} under ${COOLDOWN_DAYS} days old,`
      + ` ${unknown.length} with no publish date`);
    console.log(`  attestation: ${bare.length} new without provenance`);

    for (const key of [...young, ...unknown]) console.log(`  cooldown: ${key}`);
    for (const name of bare) console.log(`  unattested: ${name}`);

    if (young.length || unknown.length || bare.length) failed = true;
  }

  if (failed) {
    console.log("FAIL. A young version waits out its cooldown, or takes a");
    console.log("recorded waiver (bin/nff supply waive). An unattested");
    console.log("package needs James's approval in");
    console.log("security/attestation-baseline.json.");
  } else {
    console.log("PASS");
  }

  return failed ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const paths = process.argv.slice(2);

  process.exitCode = await run(
    paths.length ? paths : [join(ROOT, "package-lock.json")],
  );
}
