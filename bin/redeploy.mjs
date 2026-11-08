// `bin/nff redeploy --production|--staging [--yes] [--dry-run]`: build
// a context again without a push (#510). After a build fails on a
// Netlify setting, fixing the setting changes nothing until a build
// runs, and the only way to start one was a raw `bin/nff netlify api
// createSiteBuild` call.
//
// Production rebuilds main, staging rebuilds staging. It prints the
// branch, the commit the build will take (the branch's head on origin)
// and the commit the context serves now (its /version.json), asks
// before a production rebuild unless --yes, starts the build through
// the Netlify API as `bin/nff netlify api createSiteBuild` does, then
// waits until the deploy is ready and /version.json shows the commit,
// or reports the failure with the deploy's URL. Each rebuild is logged
// (docs/security.md): who, the context, the commit served before and
// the one built.

/* eslint-disable camelcase -- Netlify names its fields its way */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { log } from "../netlify/functions/lib/log.mjs";
import { NETLIFY_NPX } from "./env/cli.mjs";

const run = promisify(execFile);

// The branch each context builds from.
export const BRANCHES = { production: "main", staging: "staging" };

// How often to look while the build runs, and for how long.
export const POLL_MS = 15 * 1000;
export const TIMEOUT_MS = 20 * 60 * 1000;

// Netlify's deploy states that end a build without a site to serve.
const FAILED = new Set(["error", "rejected", "cancelled"]);

export const USAGE = `
  bin/nff redeploy --production|--staging [--yes] [--dry-run]
                                      build the context again without a
                                      push: production builds main,
                                      staging builds staging. Names the
                                      commit it builds and the one
                                      served now, asks first on
                                      production unless --yes, then
                                      waits for the deploy: ready once
                                      /version.json shows the commit,
                                      or failed with the deploy's URL.
                                      Logged`
  .slice(1);

// `git ls-remote origin refs/heads/<branch>`'s answer -> the commit,
// or null when the branch is not there.
export const remoteHead = (text, branch) => {
  const line = String(text).split("\n")
    .find((l) => l.split("\t")[1] === `refs/heads/${branch}`);

  return line ? line.split("\t")[0] : null;
};

// The served commit, from /version.json under `site`, or null when it
// does not answer with one.
export const servedCommit = async (site, { fetchImpl = fetch } = {}) => {
  try {
    const res = await fetchImpl(new URL("/version.json", site), {
      headers: { "cache-control": "no-cache" },
    });

    if (!res.ok) return null;

    const { commit } = await res.json();

    return commit || null;
  } catch {
    return null;
  }
};

// Where a deploy's log is read in Netlify's app.
export const deployUrl = (deploy) => (deploy.admin_url
  ? `${deploy.admin_url}/deploys/${deploy.id}`
  : deploy.deploy_ssl_url || deploy.deploy_url || deploy.id);

// One look at the build. -> "ready", "failed" or "waiting".
export const outcome = (deploy, served, sha) => {
  if (FAILED.has(deploy.state)) return "failed";
  if (deploy.state === "ready" && served === sha) return "ready";

  return "waiting";
};

// The Netlify CLI's `api` command, as the Keychain's token, with its
// JSON answer parsed. The token goes in the child's environment only.
const netlifyApi = (method, data) => new Promise((resolve, reject) => {
  const child = spawn("npx", [...NETLIFY_NPX, "api", method, "--data",
    JSON.stringify(data)], {
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  let stdout = "";

  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) return reject(new Error(`netlify api ${method} failed (${
      code}).`));
    try {
      return resolve(JSON.parse(stdout));
    } catch {
      return reject(new Error(`netlify api ${method} did not answer JSON.`));
    }
  });
});

const lsRemote = async (branch) => (await run("git",
  ["ls-remote", "origin", `refs/heads/${branch}`])).stdout;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const redeploy = async (context, {
  yes = false, dryRun = false, by = "cli", out, ask,
}, deps = {}) => {
  const {
    ls = lsRemote, api = netlifyApi, fetchImpl = fetch, wait = pause,
    now = Date.now, env = process.env,
  } = deps;
  const branch = BRANCHES[context];

  if (!branch) throw new Error("Say which: --production or --staging.");

  const site = env.NETLIFY_SITE_ID;
  const url = env.SITE_URL;

  if (!site || !url) {
    throw new Error(`The ${context} env file needs NETLIFY_SITE_ID and `
      + "SITE_URL. Nothing was built.");
  }

  const sha = remoteHead(await ls(branch), branch);

  if (!sha) throw new Error(`origin has no ${branch} branch. Nothing was `
    + "built.");

  const before = await servedCommit(url, { fetchImpl });

  out(`Branch:  ${branch}`);
  out(`Builds:  ${sha}`);
  out(`Serving: ${before || "unknown (no /version.json)"}${
    before === sha ? " (the same commit)" : ""}`);

  if (dryRun) return out(`--dry-run: would rebuild ${context} from ${branch}.`);

  if (context === "production" && !yes) {
    if (!ask) {
      throw new Error("Production: there is no terminal to confirm at; pass "
        + "--yes to go ahead. Nothing was built.");
    }

    const phrase = "redeploy production";
    const answer = await ask(`Production: rebuild main at ${sha}? Type "${
      phrase}" to go ahead: `);

    if (answer.trim() !== phrase) return out("Nothing was built.");
  }

  const build = await api("createSiteBuild", {
    site_id: site, body: { branch },
  });
  const deployId = build.deploy_id;

  log.info({
    event: "site.redeploy", by, context, branch, before, after: sha,
    deploy: deployId || null,
  });
  out(`Build started: deploy ${deployId}. Waiting for it to finish.`);

  if (!deployId) {
    throw new Error("Netlify started the build but named no deploy to "
      + "watch. Look in Netlify's Deploys.");
  }

  const end = now() + TIMEOUT_MS;
  let deploy = { id: deployId };

  while (now() < end) {
    await wait(POLL_MS);
    deploy = await api("getDeploy", { deploy_id: deployId });

    const served = deploy.state === "ready"
      ? await servedCommit(url, { fetchImpl }) : null;
    const state = outcome(deploy, served, sha);

    if (state === "ready") {
      log.info({
        event: "site.redeploy.ready", by, context, branch, before,
        after: sha, deploy: deployId,
      });

      return out(`Ready: ${context} serves ${sha}.`);
    }
    if (state === "failed") {
      log.info({
        event: "site.redeploy.failed", by, context, branch, before,
        after: sha, deploy: deployId, state: deploy.state,
      });

      throw new Error(`Failed: the ${context} build ended ${deploy.state}${
        deploy.error_message ? ` (${deploy.error_message})` : ""}. ${
        before ? `${before} is still served. ` : ""}Its log: ${
        deployUrl(deploy)}`);
    }
  }

  throw new Error(`Not ready after ${TIMEOUT_MS / 60000} minutes (deploy `
    + `state ${deploy.state || "unknown"}). Look at ${deployUrl(deploy)}`);
};
