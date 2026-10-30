/* eslint-disable camelcase -- Netlify names its fields its way */
// `bin/nff redeploy` (#510): a context built again without a push. The
// right branch, the production confirm, the wait for /version.json and
// a log line for each rebuild.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BRANCHES, TIMEOUT_MS, deployUrl, outcome, redeploy, remoteHead,
} from "../bin/redeploy.mjs";

// Netlify's answers (test/fixtures/netlify/redeploy.json says where
// from), with the commit put in.
const NETLIFY = JSON.parse(readFileSync(
  new URL("fixtures/netlify/redeploy.json", import.meta.url), "utf8"));

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const ENV = {
  NETLIFY_SITE_ID: "SITE_ID_1",
  SITE_URL: "https://staging--north-foster-farm.netlify.app",
};

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

const logged = (lines, event) => lines.filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l)).filter((l) => l.event === event);

// A stand-in for git, the Netlify CLI and the site. `states` are the
// deploy's states, one per look; `serves` the commits /version.json
// names, the first before the build.
const world = ({
  heads = { main: SHA, staging: SHA },
  states = ["building", "ready"], serves = [OLD, SHA], answer,
} = {}) => {
  const calls = { ls: [], api: [], asked: [], out: [] };
  const served = [...serves];
  const looks = [...states];

  return {
    calls,
    opts: {
      out: (line) => calls.out.push(line),
      ask: answer === undefined ? null : async (question) => {
        calls.asked.push(question);

        return answer;
      },
    },
    deps: {
      env: ENV,
      wait: async () => {},
      ls: async (branch) => {
        calls.ls.push(branch);

        return heads[branch] ? `${heads[branch]}\trefs/heads/${branch}\n` : "";
      },
      api: async (method, data) => {
        calls.api.push({ method, data });

        if (method === "createSiteBuild") return NETLIFY.build;

        const state = looks.length > 1 ? looks.shift() : looks[0];

        return { ...NETLIFY.deploys[state], commit_ref: SHA };
      },
      fetchImpl: async (url) => {
        assert.equal(String(url), `${ENV.SITE_URL}/version.json`);

        const commit = served.length > 1 ? served.shift() : served[0];

        return new Response(JSON.stringify({ commit, version: "1.0.0" }));
      },
    },
  };
};

describe("redeploy", () => {
  it("builds main for production and staging for staging", () => {
    assert.deepEqual(BRANCHES, { production: "main", staging: "staging" });
  });

  it("reads the branch's commit from ls-remote", () => {
    const text = `${OLD}\trefs/heads/staging-env\n${SHA}\trefs/heads/staging\n`;

    assert.equal(remoteHead(text, "staging"), SHA);
    assert.equal(remoteHead(text, "main"), null);
  });

  it("is ready only once the deploy is and /version.json shows it", () => {
    const { ready, building, error } = NETLIFY.deploys;

    assert.equal(outcome(ready, SHA, SHA), "ready");
    assert.equal(outcome(ready, OLD, SHA), "waiting");
    assert.equal(outcome(building, SHA, SHA), "waiting");
    assert.equal(outcome(error, OLD, SHA), "failed");
  });

  it("rebuilds staging, waits, and logs the rebuild", async (t) => {
    const lines = capture(t);
    const w = world();

    await redeploy("staging", { by: "james", ...w.opts }, w.deps);

    assert.deepEqual(w.calls.ls, ["staging"]);
    assert.deepEqual(w.calls.api[0], {
      method: "createSiteBuild",
      data: { site_id: "SITE_ID_1", body: { branch: "staging" } },
    });
    assert.deepEqual(w.calls.api.slice(1).map((c) => c.data),
      [{ deploy_id: "DEPLOY_ID_1" }, { deploy_id: "DEPLOY_ID_1" }]);
    assert.deepEqual(w.calls.out.slice(0, 3), [
      "Branch:  staging", `Builds:  ${SHA}`, `Serving: ${OLD}`,
    ]);
    assert.equal(w.calls.out.at(-1), `Ready: staging serves ${SHA}.`);
    assert.deepEqual(w.calls.asked, [], "staging never asks");

    const [line] = logged(lines, "site.redeploy");

    assert.equal(line.by, "james");
    assert.equal(line.context, "staging");
    assert.equal(line.branch, "staging");
    assert.equal(line.before, OLD);
    assert.equal(line.after, SHA);
    assert.equal(line.deploy, "DEPLOY_ID_1");
    assert.ok(line._time);
    assert.equal(logged(lines, "site.redeploy.ready").length, 1);
  });

  it("asks before production, and builds nothing on a wrong answer",
    async (t) => {
      const lines = capture(t);
      const w = world({ answer: "yes" });

      await redeploy("production", w.opts, w.deps);

      assert.deepEqual(w.calls.ls, ["main"]);
      assert.match(w.calls.asked[0],
        /rebuild main at a{40}\? Type "redeploy production"/);
      assert.deepEqual(w.calls.api, []);
      assert.equal(w.calls.out.at(-1), "Nothing was built.");
      assert.deepEqual(logged(lines, "site.redeploy"), []);
    });

  it("builds main once production is confirmed", async (t) => {
    capture(t);
    const w = world({ answer: "redeploy production" });

    await redeploy("production", w.opts, w.deps);

    assert.equal(w.calls.api[0].data.body.branch, "main");
    assert.equal(w.calls.out.at(-1), `Ready: production serves ${SHA}.`);
  });

  it("skips the question with --yes, and refuses without a terminal",
    async (t) => {
      capture(t);
      const yes = world();

      await redeploy("production", { yes: true, ...yes.opts }, yes.deps);
      assert.equal(yes.calls.api[0].method, "createSiteBuild");

      const none = world();

      await assert.rejects(redeploy("production", none.opts, none.deps),
        /no terminal to confirm at; pass --yes/);
      assert.deepEqual(none.calls.api, []);
    });

  it("reports a failed build with its URL and logs it", async (t) => {
    const lines = capture(t);
    const w = world({ states: ["building", "error"], serves: [OLD] });

    await assert.rejects(redeploy("staging", w.opts, w.deps), (error) => {
      assert.match(error.message, /build ended error \(Build script/);
      assert.match(error.message, new RegExp(`${OLD} is still served`));
      assert.ok(error.message.endsWith(deployUrl(NETLIFY.deploys.error)));

      return true;
    });
    assert.equal(deployUrl(NETLIFY.deploys.error),
      "https://app.netlify.com/projects/north-foster-farm/deploys/"
      + "DEPLOY_ID_1");
    assert.equal(logged(lines, "site.redeploy").length, 1);
    assert.equal(logged(lines, "site.redeploy.failed")[0].state, "error");
  });

  it("waits for /version.json when the deploy is ready first", async (t) => {
    capture(t);
    const w = world({ states: ["ready"], serves: [OLD, OLD, SHA] });

    await redeploy("staging", w.opts, w.deps);

    assert.equal(w.calls.api.length, 3, "two looks at the deploy");
  });

  it("gives up after the timeout, naming the deploy", async (t) => {
    capture(t);
    const w = world({ states: ["building"] });
    let clock = 0;

    await assert.rejects(redeploy("staging", w.opts, {
      ...w.deps, now: () => { clock += TIMEOUT_MS / 4; return clock; },
    }), /Not ready after 20 minutes \(deploy state building\)/);
  });

  it("does nothing but print with --dry-run", async (t) => {
    const lines = capture(t);
    const w = world();

    await redeploy("staging", { dryRun: true, ...w.opts }, w.deps);

    assert.deepEqual(w.calls.api, []);
    assert.match(w.calls.out.at(-1), /--dry-run: would rebuild staging/);
    assert.deepEqual(logged(lines, "site.redeploy"), []);
  });

  it("refuses with no context, or with no site in the env file", async () => {
    const w = world();

    await assert.rejects(redeploy(null, w.opts, w.deps),
      /--production or --staging/);
    await assert.rejects(redeploy("staging", w.opts, { ...w.deps, env: {} }),
      /needs NETLIFY_SITE_ID and SITE_URL/);
    await assert.rejects(redeploy("staging", w.opts,
      { ...w.deps, ls: async () => "" }), /origin has no staging branch/);
  });
});
