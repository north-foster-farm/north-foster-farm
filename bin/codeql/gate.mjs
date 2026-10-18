#!/usr/bin/env node
// The two judgments around CodeQL's analysis (.github/workflows/
// codeql.yml), so a commit is scanned once and a high or critical
// finding blocks it (#267, code analysis).
//
//   node bin/codeql/gate.mjs seen    does an analysis already exist for
//                                    this commit? Prints seen= and ref=
//                                    to $GITHUB_OUTPUT.
//   node bin/codeql/gate.mjs check   fail when `REF` has an open alert
//                                    of high or critical severity.
//
// A required check attaches to a commit, and a fast-forward carries the
// same commit from next to staging to main, so the analysis made on one
// branch covers the others: `seen` finds it by SHA and the workflow
// skips the scan. A pull request is covered the same way when its base
// is an ancestor of its head, since the merge result is then the head.
//
// Dismissing an alert in GitHub (with a reason) is the recorded
// exception, James's call; a dismissed alert no longer blocks. The log
// holds counts only: on a public repository it can be read by anyone.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, SHA, and for `seen` an optional
// BASE_SHA (a pull request's base); for `check`, REF.

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const API = "https://api.github.com";
const BLOCKING = ["critical", "high"];

const get = async (path, { env, fetchImpl, none }) => {
  const res = await fetchImpl(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
    },
  });

  if (res.status === 404 && none !== undefined) return none;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);

  return res.json();
};

// The newest clean CodeQL analysis of `sha` in a list, or null. The
// API's own sha filter is ignored (checked 2026-10-18: it returns every
// analysis, newest first), so the match is made here, over the latest
// hundred. GitHub answers 404 to the query while a repository has no
// analysis at all, which is the first run: `seen` reads that as an
// empty list, and nothing else.
export const findAnalysis = (analyses, sha) => {
  const clean = analyses.filter((a) => a.tool?.name === "CodeQL"
    && a.commit_sha === sha && !a.error);

  clean.sort((a, b) => String(b.created_at)
    .localeCompare(String(a.created_at)));

  return clean[0] || null;
};

// The alerts that block: open, security severity high or critical.
export const blocking = (alerts) => alerts.filter((a) => a.state === "open"
  && BLOCKING.includes(a.rule?.security_severity_level));

const isAncestor = async (base, head) => {
  try {
    await run("git", ["merge-base", "--is-ancestor", base, head]);

    return true;
  } catch {
    return false;
  }
};

export const seen = async ({ env = process.env, fetchImpl = fetch,
  ancestor = isAncestor } = {}) => {
  const { SHA, BASE_SHA, GITHUB_REPOSITORY: repo } = env;

  // A pull request whose base is not behind its head merges into
  // something new, which has not been analyzed.
  if (BASE_SHA && !(await ancestor(BASE_SHA, SHA))) return null;

  const analyses = await get(
    `/repos/${repo}/code-scanning/analyses?sha=${SHA}&tool_name=CodeQL`
      + "&per_page=100", { env, fetchImpl, none: [] });

  return findAnalysis(analyses, SHA);
};

export const check = async ({ env = process.env, fetchImpl = fetch } = {}) => {
  const alerts = await get(
    `/repos/${env.GITHUB_REPOSITORY}/code-scanning/alerts?state=open`
      + `&ref=${encodeURIComponent(env.REF)}&per_page=100`,
    { env, fetchImpl });

  return blocking(alerts).length;
};

const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
};

export const main = async (mode, options = {}) => {
  if (mode === "seen") {
    const found = await seen(options);

    output("seen", found ? "true" : "false");
    output("ref", found ? found.ref : "");
    console.log(found
      ? "analysis found for this commit; not scanning again"
      : "no analysis for this commit; scanning");

    return 0;
  }

  if (mode === "check") {
    const count = await check(options);

    console.log(`open high or critical alerts: ${count}`);
    console.log(count ? "FAIL" : "PASS");

    return count ? 1 : 0;
  }

  throw new Error("Usage: gate.mjs seen|check");
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main(process.argv[2]);
}
