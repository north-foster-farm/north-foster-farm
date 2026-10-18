import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  API, envRunner, planPush, pushEnv, remoteVars,
} from "../bin/env/netlify.mjs";
import { readSample, readValues } from "../bin/env/sample.mjs";

const TOKEN = "nfp_personal_access_token_1234";
const SAMPLE = [
  "### x",
  "## Square",
  "##",
  "## About.",
  "# SQUARE_ACCESS_TOKEN",
  "# The token.",
  "SQUARE_ACCESS_TOKEN=",
  "# SQUARE_ENV",
  "# Which Square.",
  "SQUARE_ENV=sandbox",
].join("\n").replace("# SQUARE_ACCESS_TOKEN", "\n# SQUARE_ACCESS_TOKEN")
  .replace("# SQUARE_ENV", "\n# SQUARE_ENV");
const FILE = readValues([
  "SQUARE_ACCESS_TOKEN=sq-live-secret-value-9876",
  "SQUARE_ENV=sandbox",
].join("\n"));
const values = [...FILE.values.values()];

// Netlify's REST API for env vars, as far as the runner uses it, with
// a log of every request. fail: a status to answer every write with,
// echoing the body as a careless server might.
const netlifyApi = ({ fail } = {}) => {
  const vars = new Map();
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;

    seen.push({ method: options.method, path: u.pathname, body, headers:
      options.headers });

    const json = (data, status = 200) => new Response(
      JSON.stringify(data), { status });

    if (u.pathname === "/api/v1/sites/SITE") {
      return json({ "account_id": "acct" });
    }
    if (fail && options.method !== "GET") {
      return new Response(options.body, { status: fail });
    }

    const key = decodeURIComponent(u.pathname.split("/env/")[1] || "");

    if (options.method === "GET") {
      return vars.has(key) ? json(vars.get(key)) : json({}, 404);
    }
    if (options.method === "POST") {
      for (const v of body) vars.set(v.key, v);

      return json(body);
    }

    const v = vars.get(key);

    v.values = v.values.filter((x) => x.context !== body.context
      || x["context_parameter"] !== body["context_parameter"]);
    v.values.push(body);

    return json(v);
  };

  return { fetchImpl, seen, vars };
};

const runner = (api, cli = async () => { throw new Error("cli called"); }) =>
  envRunner({ cli, token: TOKEN, values, fetchImpl: api.fetchImpl });

const plan = () => planPush(readSample(SAMPLE, "staging"), FILE,
  ".env.staging");

describe("env push over the API, with no value in a command line", () => {
  it("sets new and existing variables, secrets as secret", async () => {
    const api = netlifyApi();
    const run = runner(api);
    const pushed = await pushEnv(run, plan(), "branch:staging", "SITE");

    assert.deepEqual(pushed.set, ["SQUARE_ACCESS_TOKEN", "SQUARE_ENV"]);
    assert.deepEqual(pushed.failed, []);

    const token = api.vars.get("SQUARE_ACCESS_TOKEN");

    assert.equal(token["is_secret"], true);
    assert.deepEqual(token.values, [{
      context: "branch", "context_parameter": "staging",
      value: "sq-live-secret-value-9876",
    }]);
    assert.ok(!token.scopes.includes("post_processing"));

    // Again, to production: the variable exists, so its value is added.
    await pushEnv(run, plan(), "production", "SITE");
    assert.equal(api.vars.get("SQUARE_ENV").values.length, 2);
    assert.ok(api.seen.some((r) => r.method === "PATCH"));
    assert.ok(api.seen.every((r) => r.headers.Authorization
      === `Bearer ${TOKEN}`));
    assert.ok(api.seen.every((r) => !r.path.includes("secret-value")));
  });

  it("never gives the CLI a value, and still lists variables", async () => {
    const api = netlifyApi();
    const calls = [];
    const run = runner(api, async (args) => {
      calls.push(args);

      return JSON.stringify(args[1] === "getSite" ? { "account_id": "acct" }
        : []);
    });

    await pushEnv(run, plan(), "branch:staging", "SITE");
    await remoteVars(run, "SITE");

    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => !c.some((a) => values.some(
      (v) => String(a).includes(v)))), "no value in any argv");
    assert.ok(calls.every((c) => c[0] === "api"));
  });

  it("prints no value when a push fails, however Netlify answers",
    async () => {
      const run = runner(netlifyApi({ fail: 422 }));
      const pushed = await pushEnv(run, plan(), "branch:staging", "SITE");

      assert.equal(pushed.error.name, "SQUARE_ACCESS_TOKEN");
      assert.match(pushed.error.message, /Netlify answered 422/);

      const shown = JSON.stringify(pushed);

      for (const secret of [...values, TOKEN]) {
        assert.ok(!shown.includes(secret), "no value or token in the result");
      }
    });

  it("scrubs a network error that quotes a value", async () => {
    const run = envRunner({
      cli: async () => "", token: TOKEN, values,
      fetchImpl: async () => {
        throw new Error(`socket hang up for ${values[0]} with ${TOKEN}`);
      },
    });

    await assert.rejects(run(["env:set", "SQUARE_ENV", "sandbox",
      "--context", "production", "--force", "--site", "SITE"]), (error) => {
      assert.ok(!error.message.includes(values[0]));
      assert.ok(!error.message.includes(TOKEN));
      assert.match(error.message, /did not answer/);

      return true;
    });
  });

  it("reads a plain value back and no secret", async () => {
    const api = netlifyApi();
    const run = runner(api);

    await pushEnv(run, plan(), "branch:staging", "SITE");

    assert.equal(await run(["env:get", "SQUARE_ENV", "--context",
      "branch:staging", "--site", "SITE"]), "sandbox\n");
    assert.equal(await run(["env:get", "SQUARE_ACCESS_TOKEN", "--context",
      "branch:staging", "--site", "SITE"]), "");
    assert.ok(API.startsWith("https://api.netlify.com"));
  });
});
