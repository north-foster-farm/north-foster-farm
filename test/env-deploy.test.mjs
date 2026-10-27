import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deployAfterPush } from "../bin/env/deploy.mjs";

const HOOK = "https://api.netlify.com/build_hooks/secret-hook-id-1234";

const net = (status = 200) => {
  const seen = [];

  return {
    seen,
    fetchImpl: async (url, options) => {
      seen.push([url, options.method]);

      return new Response("{}", { status });
    },
  };
};

describe("env push, the deploy after it", () => {
  it("asks, and deploys on yes or a bare enter", async () => {
    for (const answer of ["y", "", "Y\n"]) {
      const n = net();
      const asked = [];
      const lines = await deployAfterPush({
        context: "staging", hook: HOOK, fetchImpl: n.fetchImpl,
        ask: async (q) => { asked.push(q); return answer; },
      });

      assert.deepEqual(asked, ["Deploy staging now? [Y/n] "]);
      assert.deepEqual(n.seen, [[HOOK, "POST"]]);
      assert.match(lines[0], /^Deploy of staging started/);
    }
  });

  it("skips the question with --allow-deploy", async () => {
    const n = net();
    const lines = await deployAfterPush({
      context: "production", hook: HOOK, allow: true, fetchImpl: n.fetchImpl,
    });

    assert.equal(n.seen.length, 1);
    assert.match(lines[0], /^Deploy of production started/);
  });

  it("ends on a not-live line when the answer is no", async () => {
    const n = net();
    const lines = await deployAfterPush({
      context: "staging", hook: HOOK, fetchImpl: n.fetchImpl,
      ask: async () => "n",
    });

    assert.deepEqual(n.seen, []);
    assert.match(lines[0], /^NOT LIVE YET: the staging site/);
    assert.match(lines[1], /--allow-deploy/);
  });

  it("does not deploy without a terminal or the flag", async () => {
    const n = net();
    const lines = await deployAfterPush({
      context: "production", hook: HOOK, fetchImpl: n.fetchImpl,
    });

    assert.deepEqual(n.seen, []);
    assert.match(lines[0], /^NOT LIVE YET/);
    assert.match(lines[1], /No terminal to ask on/);
  });

  it("says so when there is no hook", async () => {
    const lines = await deployAfterPush({ context: "staging", allow: true });

    assert.match(lines[0], /^NOT LIVE YET/);
    assert.match(lines[1], /No PICKUP_SCHEDULE_HOOK/);
  });

  it("fails without printing the hook when it answers badly", async () => {
    await assert.rejects(deployAfterPush({
      context: "staging", hook: HOOK, allow: true,
      fetchImpl: net(500).fetchImpl,
    }), (error) => {
      assert.match(error.message, /build hook answered 500\. NOT LIVE YET/);
      assert.ok(!error.message.includes("secret-hook-id"));

      return true;
    });
    await assert.rejects(deployAfterPush({
      context: "staging", hook: HOOK, allow: true,
      fetchImpl: async () => { throw new Error(HOOK); },
    }), (error) => !error.message.includes("secret-hook-id")
      && /did not answer/.test(error.message));
  });
});
