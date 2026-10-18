import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { devSchedule, weekdaySchedule } from "../bin/dev-schedule.mjs";
import {
  buildEnvironment, checkEnv, missingAtBuild, planPush, preflight,
  previewLeaks, pushEnv, redact, remoteFor, remoteVars, STAGING_ONLY,
  stagingOnlyIn,
} from "../bin/env/netlify.mjs";
import { parseSample, readSample, readValues } from "../bin/env/sample.mjs";
import { checkSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { loadEnv } from "../netlify/functions/lib/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, "fixtures/.env.staging.sample"),
  "utf8");
const FILE = ".env.staging";

// James's filled-in .env.staging for the fixture: the sample with its
// secrets in.
const filled = (changes = {}) => {
  const values = new Map([
    ["SITE_CONTEXT", "branch-deploy"],
    ["SITE_URL", "https://staging.example.test"],
    ["SQUARE_ACCESS_TOKEN", "fake-square-token-1234"],
    ["SQUARE_LOCATION_ID", "FAKELOCATION"],
    ["VENMO_HIDDEN", "1"],
    ["MAIL_FROM", "[STAGING] North Foster Farm <farm@example.test>"],
    ["MAIL_REPLY_TO", "\"Farm\" \\ <reply@example.test>"],
    ["NETLIFY_AUTH_TOKEN", "fake-netlify-token-5678"],
  ]);

  for (const [name, value] of Object.entries(changes)) {
    if (value === null) values.delete(name);
    else values.set(name, value);
  }

  return { values, errors: [] };
};

// A Netlify CLI and API that keep what they're set, per context, and
// never return a secret's value, as Netlify doesn't. Like netlify-cli
// 26, --secret takes only on a new variable. failOn: a key whose
// env:set exits non-zero.
const netlify = (seed = [], { failOn } = {}) => {
  const vars = new Map(seed.map((v) => [v.key, structuredClone(v)]));
  const calls = [];

  const run = async (args) => {
    calls.push(args);
    const [command, name, value] = args;

    if (command === "env:set") {
      if (name === failOn) throw new Error("netlify env:set failed (1).");

      const ctx = args[args.indexOf("--context") + 1];
      const [context, param] = ctx.startsWith("branch:")
        ? ["branch", ctx.slice(7)] : [ctx, undefined];
      const v = vars.get(name) || { key: name, values: [] };

      v["is_secret"] = vars.has(name) ? !!v["is_secret"]
        : args.includes("--secret");
      v.values = v.values.filter((x) => x.context !== context
        || x["context_parameter"] !== param);
      v.values.push({ context, "context_parameter": param, value });
      vars.set(name, v);

      return "";
    }
    if (command === "env:get") {
      const ctx = args[3].replace(/^branch:/, "");
      const v = vars.get(name);
      const x = v && v.values.find((y) => (y["context_parameter"]
        || y.context) === ctx);

      return x && !v["is_secret"] ? `${x.value}\n` : "";
    }
    if (command === "api" && name === "getSite") {
      return JSON.stringify({ "account_id": "acct" });
    }
    if (command === "api" && name === "getEnvVars") {
      return JSON.stringify([...vars.values()].map((v) => ({
        ...v,
        values: v.values.map((x) => (v["is_secret"]
          ? { ...x, value: undefined } : x)),
      })));
    }
    throw new Error(`Unexpected netlify ${args.join(" ")}`);
  };

  return { run, calls, vars };
};

const staging = () => readSample(FIXTURE, "staging");

describe("the env sample parser", () => {
  it("reads the header, groups and each key's block", () => {
    const parsed = parseSample(FIXTURE);

    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.header[0], ".env.staging.sample");
    assert.deepEqual(parsed.groups.map((g) => g.title), ["Site", "Square",
      "PayPal (Venmo)", "Mail", "Local tools"]);
    assert.match(parsed.groups[1].about.join(" "), /^Log in at /);

    const token = parsed.entries.find((e) => e.name === "NETLIFY_AUTH_TOKEN");

    assert.equal(token.group, "Local tools");
    assert.equal(token.local, true);
    assert.equal(token.purpose[0], "A personal access token.");
  });

  it("unquotes values as the guide writes them", () => {
    const { entries } = parseSample(FIXTURE);
    const value = (n) => entries.find((e) => e.name === n).value;

    assert.equal(value("MAIL_FROM"),
      "[STAGING] North Foster Farm <farm@example.test>");
    assert.equal(value("MAIL_REPLY_TO"), "\"Farm\" \\ <reply@example.test>");
  });

  it("takes an empty value as a secret, and local-only keys apart", () => {
    const s = staging();

    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.secrets, ["SQUARE_ACCESS_TOKEN"]);
    assert.deepEqual(s.local, ["NETLIFY_AUTH_TOKEN"]);
    assert.ok(!s.keys.includes("NETLIFY_AUTH_TOKEN"));
  });

  it("wants a working value for every development key", () => {
    const text = FIXTURE.replace("staging.sample", "development.sample");

    assert.deepEqual(readSample(text, "development").errors,
      ["SQUARE_ACCESS_TOKEN has no value; development needs one."]);
  });

  it("names what breaks the layout, never a value", () => {
    const text = [
      "### .env.x.sample", "", "LOOSE=secret-value-1", "", "## Group", "##",
      "## Where.", "", "# FIRST", "# Its purpose.", "SECOND=x", "",
      "# BARE", "BARE=y", "", "# DUP", "# Again.", "DUP=1", "",
      "# DUP", "# Again.", "DUP=2",
    ].join("\n");
    const { errors } = parseSample(text);

    assert.deepEqual(errors, [
      "Line 3: LOOSE has no comment block.",
      "Line 3: LOOSE is in no ## group.",
      "Line 11: SECOND follows the block for FIRST.",
      "Line 14: BARE has no purpose line.",
      "Line 22: DUP again.",
    ]);
    assert.ok(!errors.join(" ").includes("secret-value-1"));
  });

  it("wants the ### header", () => {
    assert.deepEqual(parseSample("## G\n##\n## Where.\n\n# A\n# B.\nA=1")
      .errors, ["No ### header at the top."]);
  });

  it("reads a filled-in file and loadEnv agrees on its values", () => {
    const { values, errors } = readValues(FIXTURE);

    assert.deepEqual(errors, []);
    assert.equal(values.get("MAIL_REPLY_TO"),
      "\"Farm\" \\ <reply@example.test>");
    assert.equal(values.get("SQUARE_ACCESS_TOKEN"), "");

    const before = process.env.MAIL_REPLY_TO;

    delete process.env.MAIL_REPLY_TO;

    const loaded = loadEnv(join(here, "fixtures/.env.staging.sample"));

    assert.equal(loaded.MAIL_REPLY_TO, values.get("MAIL_REPLY_TO"));
    assert.equal(loaded.MAIL_FROM, values.get("MAIL_FROM"));
    for (const name of Object.keys(loaded)) delete process.env[name];
    if (before !== undefined) process.env.MAIL_REPLY_TO = before;
  });
});

describe("bin/nff env push", () => {
  it("sets each sample key, secrets as secret, one context", async () => {
    const plan = planPush(staging(), filled(), FILE);
    const cli = netlify();

    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.skipped, ["NETLIFY_AUTH_TOKEN"]);

    const pushed = await pushEnv(cli.run, plan, "branch:staging", "SITE");
    const sets = cli.calls.filter((c) => c[0] === "env:set");

    assert.deepEqual(pushed.failed, []);
    assert.deepEqual(sets.map((c) => c[1]), ["SITE_CONTEXT", "SITE_URL",
      "SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID", "VENMO_HIDDEN",
      "MAIL_FROM", "MAIL_REPLY_TO"]);
    for (const c of sets) {
      assert.deepEqual(c.slice(3), [
        "--context", "branch:staging",
        ...(c[1] === "SQUARE_ACCESS_TOKEN" ? ["--secret"] : []), "--force",
        "--site", "SITE",
      ]);
    }
    assert.ok(!cli.calls.some((c) => c[0] === "env:unset"));
  });

  it("reads non-secrets back and never asks for a secret", async () => {
    const cli = netlify();

    await pushEnv(cli.run, planPush(staging(), filled(), FILE),
      "branch:staging", "SITE");

    const gets = cli.calls.filter((c) => c[0] === "env:get").map((c) => c[1]);

    assert.equal(gets.length, 6);
    assert.ok(!gets.includes("SQUARE_ACCESS_TOKEN"));
  });

  it("names a value that doesn't read back", async () => {
    const cli = netlify();
    const run = async (args) => (args[0] === "env:get" && args[1] === "SITE_URL"
      ? "something else\n" : cli.run(args));
    const pushed = await pushEnv(run, planPush(staging(), filled(), FILE),
      "branch:staging", "SITE");

    assert.deepEqual(pushed.failed, ["SITE_URL"]);
  });

  it("sets nothing while a key is missing or empty", () => {
    const plan = planPush(staging(), filled({
      SITE_URL: null, SQUARE_ACCESS_TOKEN: "",
    }), FILE);

    assert.deepEqual(plan.errors, [
      "SITE_URL is in the sample but not in .env.staging.",
      "SQUARE_ACCESS_TOKEN is empty in .env.staging.",
    ]);
  });

  it("skips VENMO_HIDDEN left empty, for launch day's unset", () => {
    const plan = planPush(staging(), filled({ VENMO_HIDDEN: "" }), FILE);

    assert.deepEqual(plan.errors, []);
    assert.ok(plan.skipped.includes("VENMO_HIDDEN"));
    assert.ok(!plan.sets.some((s) => s.name === "VENMO_HIDDEN"));
  });

  it("blanks values out of the CLI's errors", () => {
    assert.equal(redact("bad KEY=fake-square-token-1234 here",
      ["fake-square-token-1234", "1"]), "bad KEY=[value] here");
  });
});

describe("bin/nff env check", () => {
  // Netlify after a clean push of the fixture to staging.
  const pushed = async (extra = []) => {
    const cli = netlify(extra);

    await pushEnv(cli.run, planPush(staging(), filled(), FILE),
      "branch:staging", "SITE");

    return cli;
  };
  const check = async (cli, env = "staging", local = filled()) => checkEnv({
    env, sample: staging(), local, file: FILE,
    remote: remoteFor(await remoteVars(cli.run, "SITE"), env),
  });

  it("passes after env push", async () => {
    assert.deepEqual(await check(await pushed()), { problems: [], unset: [] });
  });

  it("fails on a key missing from the file or from Netlify", async () => {
    const cli = await pushed();

    cli.vars.delete("SQUARE_LOCATION_ID");

    const { problems } = await check(cli, "staging",
      filled({ SITE_URL: null }));

    assert.deepEqual(problems, [
      "SITE_URL: in the sample, not in .env.staging.",
      "SQUARE_LOCATION_ID: not on Netlify's branch:staging (env push).",
    ]);
  });

  it("fails on a name only the file or only Netlify has", async () => {
    const cli = await pushed([
      { key: "STAGING_TOKEN", values: [{ context: "branch",
        "context_parameter": "staging", value: "" }] },
    ]);
    const { problems, unset } = await check(cli, "staging",
      filled({ PAYPAL_BUYER_EMAIL: "buyer@example.test" }));

    assert.deepEqual(problems, [
      "PAYPAL_BUYER_EMAIL: in .env.staging, not in the sample.",
      "STAGING_TOKEN: on Netlify's branch:staging, not in the sample.",
    ]);
    assert.deepEqual(unset,
      ["bin/nff netlify env:unset STAGING_TOKEN --context branch:staging"]);
  });

  it("fails on a value attached to all or to every branch", async () => {
    const cli = await pushed();

    cli.vars.get("SQUARE_ACCESS_TOKEN").values.push({
      context: "all", value: "x",
    });
    cli.vars.get("SITE_URL").values = [{ context: "branch-deploy",
      value: "https://staging.example.test" }];

    const { problems } = await check(cli);

    assert.deepEqual(problems, [
      "SITE_URL: its value is attached to branch-deploy, not " +
        "branch:staging alone.",
      "SQUARE_ACCESS_TOKEN: its value is attached to all, not " +
        "branch:staging alone.",
    ]);
  });

  it("fails on a secret set in the open, or a value that drifted",
    async () => {
      const cli = await pushed();

      cli.vars.get("SQUARE_ACCESS_TOKEN")["is_secret"] = false;
      cli.vars.get("SQUARE_LOCATION_ID").values[0].value = "OTHER";

      assert.deepEqual((await check(cli)).problems, [
        "SQUARE_ACCESS_TOKEN: plain on Netlify, secret in the sample. " +
          "env push can't change that: mark it secret in the Netlify UI, " +
          "or unset it and push again.",
        "SQUARE_LOCATION_ID: differs from .env.staging (env push).",
      ]);
    });

  it("flags a local-only key found on Netlify", async () => {
    const cli = await pushed([{ key: "NETLIFY_AUTH_TOKEN", "is_secret": true,
      values: [{ context: "branch", "context_parameter": "staging" }] }]);

    assert.deepEqual((await check(cli)).problems,
      ["NETLIFY_AUTH_TOKEN: local only, yet on Netlify's branch:staging."]);
  });

  it("ignores PICKUP_SCHEDULE, Netlify's own names and other contexts",
    async () => {
      const cli = await pushed([
        { key: "PICKUP_SCHEDULE", values: [{ context: "branch",
          "context_parameter": "staging", value: "2026-10-19 09:00-12:00" }] },
        { key: "HUGO_VERSION", values: [{ context: "all", value: "0.164" }] },
        { key: "AXIOM_TOKEN", values: [{ context: "production", value: "x" }] },
      ]);

      assert.deepEqual((await check(cli)).problems, []);
    });

  it("ignores production's RESEND_READ_KEY, and only production's",
    async () => {
      const prod = remoteFor([{ name: "RESEND_READ_KEY", secret: true,
        values: [{ context: "production" }] }], "production");

      assert.ok(prod.has("RESEND_READ_KEY"));
      assert.ok(!checkEnv({ env: "production", sample: staging(),
        local: filled(), file: ".env.production", remote: prod })
        .problems.some((p) => p.startsWith("RESEND_READ_KEY")));

      const cli = await pushed([{ key: "RESEND_READ_KEY", "is_secret": true,
        values: [{ context: "branch", "context_parameter": "staging" }] }]);

      assert.ok((await check(cli)).problems
        .includes("RESEND_READ_KEY: on Netlify's branch:staging, not in " +
          "the sample."));
    });

  it("fails production on a staging key, whatever its value", async () => {
    const prod = remoteFor([{ name: "STAGING_TOKEN", secret: true,
      values: [{ context: "production", value: "" }] }], "production");
    const { problems, unset } = checkEnv({ env: "production",
      sample: staging(), local: filled({ GATE_RESEND_KEY: "" }),
      file: ".env.production", remote: prod });

    assert.ok(problems.includes(
      "STAGING_TOKEN: is staging only, yet in Netlify's production."));
    assert.ok(problems.includes(
      "GATE_RESEND_KEY: is staging only, yet in .env.production."));
    assert.deepEqual(unset,
      ["bin/nff netlify env:unset STAGING_TOKEN --context production"]);
  });

  it("never puts a value in a problem", async () => {
    const cli = await pushed();

    cli.vars.get("SQUARE_LOCATION_ID").values[0].value = "OTHER";

    const text = JSON.stringify(await check(cli, "staging",
      filled({ SITE_URL: null, EXTRA: "fake-extra-value" })));

    for (const value of filled().values.values()) {
      if (value.length > 3) assert.ok(!text.includes(value));
    }
    assert.ok(!text.includes("OTHER") && !text.includes("fake-extra"));
  });
});

describe("the build's env check", () => {
  it("answers to production's and the staging branch's samples", () => {
    assert.equal(buildEnvironment({ CONTEXT: "production" }), "production");
    assert.equal(buildEnvironment({ CONTEXT: "branch-deploy",
      BRANCH: "staging" }), "staging");
    assert.equal(buildEnvironment({ CONTEXT: "branch-deploy",
      BRANCH: "next" }), null);
    assert.equal(buildEnvironment({ CONTEXT: "deploy-preview" }), null);
    assert.equal(buildEnvironment({}), null);
  });

  it("names each key the sample lists that the build lacks", () => {
    const env = Object.fromEntries(filled().values);

    assert.deepEqual(missingAtBuild(staging(), env), []);
    delete env.SQUARE_ACCESS_TOKEN;
    env.SITE_URL = "";
    delete env.VENMO_HIDDEN;
    delete env.NETLIFY_AUTH_TOKEN;
    assert.deepEqual(missingAtBuild(staging(), env),
      ["SITE_URL", "SQUARE_ACCESS_TOKEN"]);
  });

  it("passes a build with no sample yet, and fails a missing key", () => {
    const script = join(here, "../bin/check-env.mjs");
    const run = (args, env) => {
      const r = spawnSync(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
      });

      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };

    const fixture = join(here, "fixtures/.env.staging.sample");
    const full = Object.fromEntries(filled().values);
    const short = { ...full, SQUARE_ACCESS_TOKEN: "" };

    assert.equal(run([], { CONTEXT: "deploy-preview" }).code, 0);
    assert.equal(run(["staging", join(here, "no-such.sample")], {}).code, 0);
    assert.equal(run(["nope"], {}).code, 1);
    assert.equal(run(["staging", fixture], full).code, 0);

    const failed = run(["staging", fixture], short);

    assert.equal(failed.code, 1);
    assert.match(failed.out,
      /Required for a staging build[^]*SQUARE_ACCESS_TOKEN/);
    assert.ok(!failed.out.includes("fake-"));

    // A layout slip warns; it never fails a build whose keys are set.
    const dir = mkdtempSync(join(tmpdir(), "nff-env-"));
    const messy = join(dir, ".env.staging.sample");

    writeFileSync(messy, FIXTURE
      .replace("# SITE_URL\n", "# SITE_URL\n\n")
      .replace("SQUARE_LOCATION_ID=", "export SQUARE_LOCATION_ID=")
      .replace("## Mail\n", "# OLD_KEY=gone\n\n## Mail\n"));

    const warned = run(["staging", messy], full);

    rmSync(dir, { recursive: true });
    assert.equal(warned.code, 0, warned.out);
    assert.match(warned.out, /warning, .*drop the export/);
    assert.match(warned.out, /warning, .*a comment outside a key's block/);
  });

  it("fails a production build that holds a staging key, even empty",
    () => {
      const script = join(here, "../bin/check-env.mjs");
      const fixture = join(here, "fixtures/.env.staging.sample");
      const full = Object.fromEntries(filled().values);
      const run = (env, which = "production") => {
        const r = spawnSync(process.execPath, [script, which, fixture],
          { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

        return { code: r.status, out: `${r.stdout}${r.stderr}` };
      };

      assert.equal(run(full).code, 0);
      for (const name of STAGING_ONLY) {
        const failed = run({ ...full, [name]: "" });

        assert.equal(failed.code, 1);
        assert.match(failed.out, new RegExp(`${name} is staging only`));
      }

      // Staging is where they belong.
      assert.equal(run({ ...full, STAGING_TOKEN: "x" }, "staging").code, 0);
    });

  it("keeps staging keys out of production's tracked sample", () => {
    const text = readFileSync(join(here, "../.env.production.sample"),
      "utf8");
    const names = parseSample(text).entries.map((e) => e.name);

    assert.deepEqual(stagingOnlyIn("production", names), []);
  });
});

describe("env push, refusing what it can't do", () => {
  const plain = { key: "SQUARE_ACCESS_TOKEN", "is_secret": false,
    values: [{ context: "branch", "context_parameter": "staging",
      value: "old" }, { context: "production", value: "older" }] };

  it("refuses up front when a secret is plain on Netlify", async () => {
    const cli = netlify([plain]);
    const plan = planPush(staging(), filled(), FILE);
    const problems = preflight(plan, await remoteVars(cli.run, "SITE"));

    assert.equal(problems.length, 1);
    assert.match(problems[0], /^SQUARE_ACCESS_TOKEN is a plain variable/);
    assert.match(problems[0], /Mark it secret in the Netlify UI/);
    assert.ok(problems[0].includes("bin/nff netlify env:unset " +
      "SQUARE_ACCESS_TOKEN --context branch:staging; bin/nff netlify " +
      "env:unset SQUARE_ACCESS_TOKEN --context production"));
    assert.ok(!problems[0].includes("old"));
  });

  it("passes a new secret, or one already secret", async () => {
    const plan = planPush(staging(), filled(), FILE);

    assert.deepEqual(preflight(plan, await remoteVars(netlify().run,
      "SITE")), []);
    assert.deepEqual(preflight(plan, await remoteVars(netlify([{
      ...plain, "is_secret": true }]).run, "SITE")), []);
  });

  it("stops at a failure and says what was and wasn't set", async () => {
    const cli = netlify([], { failOn: "SQUARE_LOCATION_ID" });
    const pushed = await pushEnv(cli.run, planPush(staging(), filled(),
      FILE), "branch:staging", "SITE");

    assert.deepEqual(pushed.set, ["SITE_CONTEXT", "SITE_URL",
      "SQUARE_ACCESS_TOKEN"]);
    assert.equal(pushed.error.name, "SQUARE_LOCATION_ID");
    assert.deepEqual(pushed.untried, ["VENMO_HIDDEN", "MAIL_FROM",
      "MAIL_REPLY_TO"]);
  });

  it("tells a failed read-back from a failed set", async () => {
    const cli = netlify();
    const run = async (args) => {
      if (args[0] === "env:get" && args[1] === "SITE_URL") {
        throw new Error("bin/nff netlify env:get failed (1).");
      }

      return cli.run(args);
    };
    const pushed = await pushEnv(run, planPush(staging(), filled(), FILE),
      "branch:staging", "SITE");

    assert.equal(pushed.error.name, "SITE_URL");
    assert.match(pushed.error.message, /^set, but read back failed: /);
    assert.deepEqual(pushed.set, ["SITE_CONTEXT", "SITE_URL"]);
  });

  it("wants a site id before it sets anything", async () => {
    const cli = netlify();

    await assert.rejects(pushEnv(cli.run, planPush(staging(), filled(),
      FILE), "branch:staging"), /No NETLIFY_SITE_ID/);
    assert.deepEqual(cli.calls, []);
  });

  it("never pushes the tools' own keys, marked or not", () => {
    const text = FIXTURE.replace(
      "# Local only: bin/nff reads it. env push skips it; never set on " +
        "Netlify.\n", "")
      .replace("# A personal access token.",
        "# A personal access token (Local only: never on Netlify).")
      .concat("\n# NETLIFY_SITE_ID\n# The site.\nNETLIFY_SITE_ID=abc\n");
    const s = readSample(text, "staging");

    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.local, ["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID"]);

    const unmarked = readSample(FIXTURE.replace(
      "# Local only: bin/nff reads it. env push skips it; never set on " +
        "Netlify.\n", ""), "staging");

    assert.deepEqual(unmarked.local, ["NETLIFY_AUTH_TOKEN"]);
  });

  it("takes Local only: with its colon, and nothing like it", () => {
    const s = readSample(FIXTURE.replace("# The sender.",
      "# The sender. Not local only: Netlify needs it."), "staging");

    assert.ok(s.keys.includes("MAIL_FROM"));
    assert.ok(!s.local.includes("MAIL_FROM"));
  });

  it("keeps an empty Public: key out of the secrets", () => {
    const s = readSample(FIXTURE.replace("# The sender.",
      "# The sender.\n# Public: not a secret."), "staging");

    assert.ok(s.keys.includes("MAIL_FROM"));
    assert.ok(!s.secrets.includes("MAIL_FROM"));
  });

  it("lets a sample's Optional: key be unset at build", () => {
    const s = readSample(FIXTURE.replace("# The sender.",
      "# The sender. Optional: unset, mail is logged."), "staging");

    assert.ok(s.optional.includes("MAIL_FROM"));
    assert.ok(!missingAtBuild(s, {}).includes("MAIL_FROM"));
    assert.ok(missingAtBuild(readSample(FIXTURE, "staging"), {})
      .includes("MAIL_FROM"));
  });

  it("names Netlify's answer that isn't JSON, quoting none of it",
    async () => {
      const run = async () => "Error: token sk_live_secret is bad";

      await assert.rejects(remoteVars(run, "SITE"), (error) => {
        assert.equal(error.message, "Netlify's answer to getSite wasn't JSON.");

        return true;
      });
    });
});

describe("env check, the rest of qa's cases", () => {
  const pushed = async (extra = []) => {
    const cli = netlify(extra);

    await pushEnv(cli.run, planPush(staging(), filled(), FILE),
      "branch:staging", "SITE");

    return cli;
  };
  const check = async (cli, local = filled()) => checkEnv({
    env: "staging", sample: staging(), local, file: FILE,
    remote: remoteFor(await remoteVars(cli.run, "SITE"), "staging"),
  });

  it("flags a key emptied locally but still on Netlify", async () => {
    const { problems, unset } = await check(await pushed(),
      filled({ VENMO_HIDDEN: "" }));

    assert.deepEqual(problems, ["VENMO_HIDDEN: empty in .env.staging, set " +
      "on Netlify's branch:staging."]);
    assert.deepEqual(unset,
      ["bin/nff netlify env:unset VENMO_HIDDEN --context branch:staging"]);
  });

  it("never suggests deleting a required key emptied locally",
    async () => {
      const { problems, unset } = await check(await pushed(),
        filled({ SQUARE_ACCESS_TOKEN: "" }));

      assert.deepEqual(problems,
        ["SQUARE_ACCESS_TOKEN: empty in .env.staging: fill it in."]);
      assert.deepEqual(unset, []);
    });

  it("passes VENMO_HIDDEN unset both places", async () => {
    const cli = await pushed();

    cli.vars.delete("VENMO_HIDDEN");
    assert.deepEqual((await check(cli, filled({ VENMO_HIDDEN: "" })))
      .problems, []);
  });

  it("flags a key the build can't see", async () => {
    const cli = await pushed();

    cli.vars.get("SITE_URL").scopes = ["functions", "runtime"];
    assert.deepEqual((await check(cli)).problems, ["SITE_URL: not in the " +
      "builds scope, so the build can't check it."]);
  });

  it("ignores Netlify's own settings", async () => {
    const cli = await pushed([{ key: "SECRETS_SCAN_OMIT_KEYS",
      values: [{ context: "all", value: "x" }] }]);

    assert.deepEqual((await check(cli)).problems, []);
  });
});

describe("development's pickup schedule", () => {
  it("is the fixture's generator, from today, and passes the check", () => {
    const now = new Date("2026-12-14T15:00:00Z");
    const result = checkSchedule(devSchedule(now), {
      timeZone: "America/New_York", now,
    });

    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(weekdaySchedule("2026-10-03", "2026-10-05"),
      "2026-10-05 09:00-12:00 13:00-17:00");
  });
});

describe("env check: previews and dev hold no production value (#251)", () => {
  const v = (name, ...contexts) => ({
    name, secret: true,
    values: contexts.map(([context, value]) => ({ context, value })),
  });

  it("passes when previews hold only the context name and schedule", () => {
    const r = previewLeaks([
      v("SITE_CONTEXT", ["production", "production"],
        ["deploy-preview", "deploy-preview"], ["dev", "dev"]),
      v("PICKUP_SCHEDULE", ["deploy-preview", "2026-10-19 09:00-12:00"]),
      v("RESEND_AUDIENCE_KEY", ["production"]),
      v("SQUARE_ACCESS_TOKEN", ["production"], ["branch:staging"]),
      v("HUGO_VERSION", ["all", "0.164"]),
      v("NETLIFY_BUILD_DEBUG", ["all", "1"]),
    ]);

    assert.deepEqual(r, { problems: [], unset: [] });
  });

  it("names every other value on deploy-preview or dev", () => {
    const r = previewLeaks([
      v("RESEND_AUDIENCE_KEY", ["production"], ["deploy-preview"]),
      v("RESEND_WEBHOOK_SECRET", ["dev"]),
      v("RESEND_READ_KEY", ["deploy-preview"], ["dev"]),
    ]);

    assert.deepEqual(r.problems, [
      "RESEND_AUDIENCE_KEY: has a value on Netlify's deploy-preview, which " +
        "may hold only SITE_CONTEXT and PICKUP_SCHEDULE.",
      "RESEND_WEBHOOK_SECRET: has a value on Netlify's dev, which may " +
        "hold only SITE_CONTEXT and PICKUP_SCHEDULE.",
      "RESEND_READ_KEY: has a value on Netlify's deploy-preview, which " +
        "may hold only SITE_CONTEXT and PICKUP_SCHEDULE.",
      "RESEND_READ_KEY: has a value on Netlify's dev, which may hold " +
        "only SITE_CONTEXT and PICKUP_SCHEDULE.",
    ]);
    assert.deepEqual(r.unset, [
      "bin/nff netlify env:unset RESEND_AUDIENCE_KEY --context deploy-preview",
      "bin/nff netlify env:unset RESEND_WEBHOOK_SECRET --context dev",
      "bin/nff netlify env:unset RESEND_READ_KEY --context deploy-preview",
      "bin/nff netlify env:unset RESEND_READ_KEY --context dev",
    ]);
  });

  it("flags a value attached to all, which reaches both", () => {
    const r = previewLeaks([
      v("AXIOM_TOKEN", ["all"]),
      v("PICKUP_SCHEDULE", ["all", "2026-10-19 09:00-12:00"]),
    ]);

    assert.deepEqual(r.problems, [
      "AXIOM_TOKEN: attached to all, so production's value reaches " +
        "deploy-preview and dev.",
      "PICKUP_SCHEDULE: attached to all, so production's value reaches " +
        "deploy-preview and dev.",
    ]);
  });

  it("flags a SITE_CONTEXT that says production", () => {
    const r = previewLeaks([
      v("SITE_CONTEXT", ["deploy-preview", "production"], ["dev", "dev"]),
    ]);

    assert.deepEqual(r.problems, ["SITE_CONTEXT: says production on " +
      "deploy-preview."]);
  });

  it("leaves other contexts and Netlify's own names alone", () => {
    const r = previewLeaks([
      v("SQUARE_ACCESS_TOKEN", ["production"], ["branch-deploy"],
        ["branch:staging"]),
      v("CONTEXT", ["deploy-preview", "x"]),
    ]);

    assert.deepEqual(r, { problems: [], unset: [] });
  });
});
