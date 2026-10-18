#!/usr/bin/env node
// The daily audit of what production runs. Advisories are published
// when no build is running, so CI alone would never see a new one.
//
// The deployed commit is the one the reporter script's data-build
// attribute names on the live home page; a build that predates the
// attribute falls back to the tip of main, which production deploys.
// That commit's package.json and lockfile are audited against
// security/exceptions.json, and the verdict goes to a Healthchecks
// check: a ping when clean, /fail with the findings when not. The
// Healthchecks account is private and pushes to James; this log is
// public, so it holds counts only.
//
//   node bin/audit/prod.mjs
//
// PROD_AUDIT_PING_URL  the check's ping URL (an Actions secret)
// PROD_URL             the live site (default https://www.northfosterfarm.com/)
// GITHUB_REPOSITORY    owner/name of the repository holding the commit
// GITHUB_BRANCH        the fallback ref (default main)

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  collectFindings, details, npmAudit, readExceptions, summary,
} from "./check.mjs";
import { evaluate, incompleteExceptions } from "./findings.mjs";

export const deployedSha = (html) =>
  /data-build="([0-9a-f]{40})"/.exec(String(html))?.[1] || null;

// The text sent to Healthchecks when the audit fails.
export const alertBody = (result, ref) => [
  `Production audit failed for ${ref}.`,
  ...details(result),
].join("\n");

const get = async (url, fetchImpl) => {
  const res = await fetchImpl(url);

  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);

  return res.text();
};

export const ping = async (url, failed, body, fetchImpl = fetch) => {
  const res = await fetchImpl(failed ? `${url}/fail` : url, {
    method: "POST", body,
  });

  if (!res.ok) throw new Error(`ping answered HTTP ${res.status}`);
};

// Where production's commit lives: the deployed SHA when the live page
// names it, else the tip of the fallback branch.
const locate = async (env, fetchImpl) => {
  const repo = env.GITHUB_REPOSITORY || "north-foster-farm/north-foster-farm";
  const site = env.PROD_URL || "https://www.northfosterfarm.com/";
  const sha = deployedSha(await get(site, fetchImpl));
  const ref = sha || env.GITHUB_BRANCH || "main";

  return {
    sha,
    ref,
    raw: `https://raw.githubusercontent.com/${repo}/${ref}`,
  };
};

// The commit's package.json and lockfile, in a directory of their own.
const download = async (raw, fetchImpl) => {
  const dir = mkdtempSync(join(tmpdir(), "prod-audit-"));

  for (const file of ["package.json", "package-lock.json"]) {
    writeFileSync(join(dir, file), await get(`${raw}/${file}`, fetchImpl));
  }

  return dir;
};

export const prodAudit = async ({
  env = process.env, fetchImpl = fetch, audit = npmAudit,
  exceptions = readExceptions(),
} = {}) => {
  const url = env.PROD_AUDIT_PING_URL;

  if (!url) {
    console.log("PROD_AUDIT_PING_URL is not set; nothing could be alerted.");

    return 1;
  }

  const { sha, ref, raw } = await locate(env, fetchImpl);
  const dir = await download(raw, fetchImpl);
  const findings = await collectFindings({
    lockfiles: [join(dir, "package-lock.json")], audit,
  });
  const result = evaluate(findings, exceptions);
  const failed = Boolean(result.unresolved.length || result.reraised.length);
  const counts = summary(result, incompleteExceptions(exceptions)).join("\n");

  console.log(`commit: ${sha ? "deployed" : "tip of main (no build marker)"}`);
  console.log(counts);
  await ping(url, failed, failed ? alertBody(result, ref) : counts, fetchImpl);
  console.log(failed ? "ALERTED" : "PASS");

  return failed ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await prodAudit();
}
