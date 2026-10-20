#!/usr/bin/env node
// The dependency audit: npm audit over each lockfile and the GitHub
// advisory database over the Actions a repository uses, set against
// security/exceptions.json. Fails while a known vulnerability is
// unresolved: it clears by an update or by a recorded exception, and an
// exception is raised again once a fix ships.
//
//   node bin/audit/check.mjs [--details] [--actions DIR] LOCKFILE...
//
// In GitHub Actions the log is public, so it holds counts only. Run
// anywhere else, or with --details, it names each package and advisory.

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  actionFindings, evaluate, incompleteExceptions, keyOf, npmFindings,
  usesFromWorkflow,
} from "./findings.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADVISORIES = "https://api.github.com/advisories";

// `npm audit` exits 1 when it finds something and still prints the
// report; only an unreadable report is a failure to audit.
export const npmAudit = async (dir) => {
  let out;

  try {
    ({ stdout: out } = await run(
      "npm", ["audit", "--package-lock-only", "--json"],
      { cwd: dir, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (error) {
    out = error.stdout;
  }

  const report = JSON.parse(out || "{}");

  if (report.error || !report.vulnerabilities) {
    throw new Error(`npm audit gave no report for ${dir}`);
  }

  return report;
};

const apiHeaders = () => {
  const headers = { accept: "application/vnd.github+json" };

  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
};

export const actionAdvisories = async (repo, version, fetchImpl = fetch) => {
  const query = new URLSearchParams({
    ecosystem: "actions", affects: `${repo}@${version}`, "per_page": "100",
  });
  const res = await fetchImpl(`${ADVISORIES}?${query}`,
    { headers: apiHeaders() });

  if (!res.ok) throw new Error(`advisories for ${repo}: HTTP ${res.status}`);

  return res.json();
};

// The first version of an npm package that an advisory calls patched,
// from the GitHub advisory database, or null while none exists. This,
// not npm's fixAvailable (which may name a downgrade of some other
// package), is what raises an exception again. Any doubt throws, so
// the check fails rather than passing on a lookup it could not make.
export const patchedVersion = async (pkg, advisory, fetchImpl = fetch) => {
  const res = await fetchImpl(`${ADVISORIES}/${advisory}`,
    { headers: apiHeaders() });

  if (!res.ok) throw new Error(`advisory ${advisory}: HTTP ${res.status}`);

  // An advisory may list a package once per release line, some lines
  // patched and some not. Any patched line re-raises: at worst that is
  // a line we don't use, which fails safe.
  const hits = ((await res.json()).vulnerabilities || []).filter((v) =>
    v.package?.ecosystem === "npm" && v.package?.name === pkg);

  if (!hits.length) {
    throw new Error(`advisory ${advisory} does not name ${pkg}`);
  }

  return hits.map((v) => v.first_patched_version).find(Boolean) || null;
};

export const readExceptions = (path = join(ROOT, "security/exceptions.json")) =>
  JSON.parse(readFileSync(path, "utf8"));

// Every finding for a set of lockfiles and workflow texts. An npm
// finding that an exception covers gets `patched` from the advisory
// database; one without a GHSA id falls back to npm's fix, so it still
// comes back once npm sees any fix.
export const collectFindings = async ({
  lockfiles = [], workflows = [], audit = npmAudit,
  advisories = actionAdvisories, exceptions = [], patched = patchedVersion,
}) => {
  const findings = [];
  const excepted = new Set(exceptions.map(keyOf));
  const lookups = new Map();

  for (const lock of lockfiles) {
    for (const f of npmFindings(await audit(dirname(resolve(lock))))) {
      const key = keyOf(f);

      if (excepted.has(key) && !lookups.has(key)) {
        lookups.set(key, f.advisory.startsWith("GHSA-")
          ? await patched(f.package, f.advisory)
          // Only an advisory without a GHSA id lands here, and it
          // keeps the old meaning: npm's fix hint stands in.
          : f.fix);
      }

      findings.push({ ...f, patched: lookups.get(key) ?? null });
    }
  }

  const actions = new Map();

  for (const text of workflows) {
    for (const { repo, version } of usesFromWorkflow(text)) {
      actions.set(`${repo}@${version}`, { repo, version });
    }
  }

  for (const { repo, version } of actions.values()) {
    findings.push(...actionFindings(repo, await advisories(repo, version)));
  }

  return findings;
};

export const summary = (result, bad) => [
  `unresolved: ${result.unresolved.length}`,
  `excepted: ${result.excepted.length}`,
  `exceptions to re-raise: ${result.reraised.length}`,
  `stale exceptions: ${result.stale.length}`,
  `incomplete exceptions: ${bad.length}`,
];

export const details = (result) => {
  const line = (label, f) => {
    const fix = f.fix ? ` (fix: ${f.fix})` : "";

    return `${label} ${f.package} ${f.advisory} ${f.severity || ""}${fix}`;
  };

  return [
    ...result.unresolved.map((f) => line("unresolved", f)),
    ...result.reraised.map((f) =>
      `re-raise ${f.package} ${f.advisory} (patched: ${f.patched})`),
    ...result.stale.map((e) => `stale ${e.package} ${e.advisory}`),
  ];
};

export const workflowTexts = (dir) => readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => readFileSync(join(dir, name), "utf8"));

// 0 when clean, 1 when a vulnerability or an exception needs James.
export const main = async (argv, {
  exceptions = readExceptions(), audit, patched,
} = {}) => {
  const args = [...argv];
  const showDetails = args.includes("--details")
    || !process.env.GITHUB_ACTIONS;
  const dirAt = args.indexOf("--actions");
  const workflows = dirAt >= 0 ? workflowTexts(args.splice(dirAt, 2)[1]) : [];
  const lockfiles = args.filter((a) => !a.startsWith("--"));
  const findings = await collectFindings({
    lockfiles, workflows, exceptions, audit, patched,
  });
  const result = evaluate(findings, exceptions);
  const bad = incompleteExceptions(exceptions);

  for (const line of summary(result, bad)) console.log(line);

  if (showDetails) for (const line of details(result)) console.log(line);

  const failed = result.unresolved.length || result.reraised.length
    || bad.length;

  console.log(failed ? "FAIL" : "PASS");

  return failed ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
