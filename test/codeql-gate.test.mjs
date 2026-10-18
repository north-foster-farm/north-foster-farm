/* eslint-disable camelcase -- GitHub names its fields its way */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  blocking, check, findAnalysis, main, seen,
} from "../bin/codeql/gate.mjs";

const ENV = {
  GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", SHA: "abc", REF: "refs/heads/x",
};

const reply = (body, status = 200) => async (url) => ({
  ok: status === 200,
  status,
  json: async () => (typeof body === "function" ? body(url) : body),
});

const analysis = (extra = {}) => ({
  tool: { name: "CodeQL" }, error: "", ref: "refs/heads/next",
  created_at: "2026-10-18T10:00:00Z", ...extra,
});
const alert = (level, state = "open") => ({
  state, rule: { security_severity_level: level },
});

describe("findAnalysis", () => {
  it("takes the newest clean CodeQL analysis", () => {
    const found = findAnalysis([
      analysis({ ref: "refs/heads/old", created_at: "2026-10-01T00:00:00Z" }),
      analysis({ ref: "refs/heads/next" }),
      analysis({ ref: "refs/heads/bad", error: "boom" }),
      analysis({ tool: { name: "Other" }, ref: "refs/heads/other" }),
    ]);

    assert.equal(found.ref, "refs/heads/next");
  });

  it("is null when there is none to use", () => {
    assert.equal(findAnalysis([]), null);
    assert.equal(findAnalysis([analysis({ error: "boom" })]), null);
  });
});

describe("blocking", () => {
  it("counts only open high and critical security alerts", () => {
    const alerts = [
      alert("critical"), alert("high"), alert("medium"), alert("low"),
      alert(null), alert("high", "dismissed"), alert("critical", "fixed"),
    ];

    assert.equal(blocking(alerts).length, 2);
  });
});

describe("seen", () => {
  it("asks for the commit's analyses and reuses one", async () => {
    let asked;
    const found = await seen({
      env: ENV,
      fetchImpl: reply((url) => {
        asked = url;

        return [analysis()];
      }),
    });

    assert.equal(found.ref, "refs/heads/next");
    assert.match(asked, /\/repos\/o\/r\/code-scanning\/analyses\?sha=abc&/);
  });

  it("does not reuse one for a pull request whose base moved on",
    async () => {
      const fetchImpl = reply([analysis()]);
      const env = { ...ENV, BASE_SHA: "base" };

      assert.equal(await seen({
        env, fetchImpl, ancestor: async () => false,
      }), null);
      assert.equal((await seen({
        env, fetchImpl, ancestor: async () => true,
      })).ref, "refs/heads/next");
    });

  it("finds none, and scans, while the repository has no analyses (404)",
    async () => {
      assert.equal(await seen({ env: ENV, fetchImpl: reply([], 404) }), null);
    });

  it("fails when GitHub will not answer, rather than scan blind",
    async () => {
      await assert.rejects(seen({ env: ENV, fetchImpl: reply([], 403) }),
        /GitHub answered 403/);
    });
});

describe("check", () => {
  it("counts blocking alerts on the ref", async () => {
    let asked;
    const count = await check({
      env: ENV,
      fetchImpl: reply((url) => {
        asked = url;

        return [alert("high"), alert("low")];
      }),
    });

    assert.equal(count, 1);
    assert.match(asked, /ref=refs%2Fheads%2Fx/);
  });
});

describe("main", () => {
  const quiet = (fn) => async () => {
    const log = mock.method(console, "log", () => {});

    try {
      return await fn(log);
    } finally {
      log.mock.restore();
    }
  };

  it("exits 1 on a blocking alert, printing a count and no detail",
    quiet(async (log) => {
      const code = await main("check", {
        env: ENV, fetchImpl: reply([alert("critical")]),
      });
      const printed = log.mock.calls.map((c) => c.arguments[0]).join("\n");

      assert.equal(code, 1);
      assert.match(printed, /open high or critical alerts: 1\nFAIL/);
      assert.doesNotMatch(printed, /critical\b(?!\s+alerts)/);
    }));

  it("exits 0 when nothing blocks", quiet(async () => {
    assert.equal(await main("check", {
      env: ENV, fetchImpl: reply([alert("medium")]),
    }), 0);
  }));
});
