// `bin/nff env push` and `env check` (#264): the tracked sample says
// which keys a context has and which are secret, the ignored local
// file holds the values, and Netlify gets them one `env:set` at a
// time, since `env:import` can't target a context and `-r` deletes
// what the file lacks. Nothing here deletes a variable, and nothing
// prints or returns a value: every message names keys only.
//
// Site variables only: account-level shared variables are out of
// scope, and the site's API listing doesn't show them.
//
// run(args) -> Promise<stdout> is the Netlify CLI, injected so the
// tests run with no network.

// Where each sample's keys live on Netlify. Staging is the staging
// branch's deploys; a value on branch-deploy would reach every branch.
export const TARGETS = {
  production: { context: "production", shared: ["all"] },
  staging: { context: "branch:staging", shared: ["all", "branch-deploy"] },
};

// Names env check leaves alone (#267). PICKUP_SCHEDULE belongs to
// `bin/nff schedule set`; production's RESEND_READ_KEY stays until P9,
// because the old site reads it.
export const ignoredNames = (env) => new Set([
  "PICKUP_SCHEDULE",
  ...(env === "production" ? ["RESEND_READ_KEY"] : []),
]);

// Names that belong to staging alone: its machine token, the e2e
// suite's, the access gate's (docs/secrets.md, "Staging") and the stock
// source's (#453). Production holds none of them, not even as an empty
// name: their presence is the failure, whatever the value.
export const STAGING_ONLY = [
  "STAGING_TOKEN", "E2E_STAGING_TOKEN", "GATE_RESEND_KEY", "GATE_MAIL_FROM",
  "GATE_TOOLBAR_EMAIL", "STOCK_SOURCE", "STOCK_SOURCE_TOKEN",
  "STOCK_SOURCE_LOCATION_ID", "STOCK_OVERRIDES",
];

// Names that no longer exist anywhere. Their presence in a sample, an
// env file or Netlify is the failure, whatever the value: ADMIN_EMAILS
// became FARM_, DEV_ and ESCALATED_NOTIFICATIONS_EMAIL.
export const RETIRED = ["ADMIN_EMAILS"];

export const retiredIn = (names) => {
  const held = new Set(names);

  return RETIRED.filter((n) => held.has(n));
};

export const stagingOnlyIn = (env, names) => {
  const held = new Set(names);

  return env === "production" ? STAGING_ONLY.filter((n) => held.has(n)) : [];
};

// May be absent in every context: launch day unsets VENMO_HIDDEN to
// show the button, and unset reads as shown (lib/paypal.mjs);
// the previous Square key exists only during a swap. A sample marks more
// with an "Optional:" line in the key's comment, for its context alone.
export const OPTIONAL = new Set([
  "VENMO_HIDDEN",
  "SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS",
]);

export const isOptional = (sample, name) => OPTIONAL.has(name)
  || (sample.optional || []).includes(name);

// Set by Netlify or by netlify.toml, never by a sample.
export const NETLIFY_PROVIDED = new Set([
  "BRANCH", "BUILD_ID", "CACHED_COMMIT_REF", "COMMIT_REF", "CONTEXT",
  "DEPLOY_ID", "DEPLOY_PRIME_URL", "DEPLOY_URL", "HEAD",
  "INCOMING_HOOK_BODY", "INCOMING_HOOK_TITLE", "INCOMING_HOOK_URL",
  "NETLIFY", "NETLIFY_IMAGES_CDN_DOMAIN", "PULL_REQUEST", "REPOSITORY_URL",
  "REVIEW_ID", "SITE_ID", "SITE_NAME", "URL",
  "HUGO_VERSION", "NODE_VERSION", "HUGO_ENV", "HUGO_ENABLEGITINFO",
  "NPM_FLAGS", "YARN_FLAGS", "PNPM_FLAGS", "YARN_VERSION",
]);

// Variables that set how Netlify builds (secret scanning, the build
// image), not what the site reads.
const NETLIFY_SETTING = /^(SECRETS_SCAN_|NETLIFY_BUILD_|NETLIFY_USE_)/;

const netlifyOwn = (name) => NETLIFY_PROVIDED.has(name)
  || NETLIFY_SETTING.test(name);

// The sample and the local file -> { sets, skipped, errors }. Each
// set: { name, value, secret }. Every problem is found before anything
// is set, so a push either starts whole or not at all.
export const planPush = (sample, local, file) => {
  const errors = [...sample.errors.map((e) => `Sample: ${e}`),
    ...local.errors.map((e) => `${file}: ${e}`)];
  const sets = [];
  const skipped = [...sample.local];

  for (const name of sample.keys) {
    const value = local.values.get(name);

    // An optional key may be absent from the file as well as empty, so
    // a key added to a sample later does not stop a push.
    if (value === undefined && !isOptional(sample, name)) {
      errors.push(`${name} is in the sample but not in ${file}.`);
    } else if (!value && isOptional(sample, name)) {
      skipped.push(name);
    } else if (!value) {
      errors.push(`${name} is empty in ${file}.`);
    } else {
      sets.push({ name, value, secret: sample.secrets.includes(name) });
    }
  }

  return { sets, skipped, errors };
};

// What Netlify already holds that a push can't fix. `env:set --secret`
// on a variable that exists only sets the value (netlify-cli 26), so a
// plain variable stays plain. -> problems, names only; vars is the
// whole site's list (remoteVars).
export const preflight = (plan, vars) => {
  const byName = new Map(vars.map((v) => [v.name, v]));
  const problems = [];

  for (const { name, secret } of plan.sets) {
    const v = byName.get(name);

    if (secret && v && !v.secret) {
      problems.push(`${name} is a plain variable on Netlify, and env push ` +
        "can't make it secret. Mark it secret in the Netlify UI (Project " +
        "configuration, Environment variables), or unset it and push " +
        `again: ${unsetAll(v).join("; ")}.`);
    }
  }

  return problems;
};

// The commands that remove a variable from every context it has.
const unsetAll = (v) => v.values.map((x) =>
  `bin/nff netlify env:unset ${v.name} --context ${x.context}`);

// Sets each key on one context, then reads every non-secret back. It
// stops at the first CLI failure. Netlify returns no secret's value,
// so env check confirms those by name. -> { set, failed, error,
// untried }, names only: set took, failed didn't read back, error is
// { name, message } for the failure that stopped it.
export const pushEnv = async (run, plan, context, site) => {
  if (!site) throw new Error("No NETLIFY_SITE_ID in the env file.");

  const set = [];
  const failed = [];
  const names = plan.sets.map((s) => s.name);

  for (const [i, { name, value, secret }] of plan.sets.entries()) {
    let step = "env:set";

    try {
      await run(["env:set", name, value, "--context", context,
        ...(secret ? ["--secret"] : []), "--force", "--site", site]);
      set.push(name);

      if (!secret) {
        step = "env:get";

        const back = String(await run(["env:get", name, "--context",
          context, "--site", site])).replace(/\n$/, "");

        if (back !== value) failed.push(name);
      }
    } catch (error) {
      return {
        set, failed,
        error: {
          name,
          message: step === "env:get"
            ? `set, but read back failed: ${error.message}` : error.message,
        },
        untried: names.slice(i + 1),
      };
    }
  }

  return { set, failed, error: null, untried: [] };
};

// The CLI's own output with every value we hold blanked out, for an
// error message that must name no value.
export const redact = (text, values) => [...values]
  .filter((v) => v && v.length > 3)
  .sort((a, b) => b.length - a.length)
  .reduce((out, v) => out.split(v).join("[value]"), String(text));

// The Netlify CLI for env commands, with the two that carry a value
// done in-process over Netlify's API, so no value is ever on a command
// line, where `ps` and shell history would show it. `env:set` and
// `env:get` (the arguments pushEnv builds) are answered here; anything
// else goes to `cli`, which only ever gets names and ids. Every error
// is scrubbed of every value we hold and of the token, and quotes none
// of Netlify's reply, which can echo a value.
export const API = "https://api.netlify.com/api/v1";

export const envRunner = ({
  cli, token, values = [], fetchImpl = fetch,
}) => {
  const secrets = [...values, token];
  const scrub = (text) => redact(text, secrets);
  const headers = {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
  };
  let account = null;

  const call = async (method, path, body) => {
    let res;

    try {
      res = await fetchImpl(`${API}${path}`, {
        method, headers, body: body === undefined ? undefined
          : JSON.stringify(body),
      });
    } catch (error) {
      // No `cause`: it would carry the unscrubbed message and stack.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(scrub(`Netlify did not answer (${error.message}).`));
    }
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) {
      throw new Error(`Netlify answered ${res.status} to ${method} ${
        path.replace(/\?.*/, "")}.`);
    }

    return res.status === 204 ? {} : res.json().catch(() => ({}));
  };
  const accountOf = async (site) => {
    if (!account) {
      const found = await call("GET", `/sites/${encodeURIComponent(site)}`);

      account = found && (found["account_id"] || found["account_slug"]);
      if (!account) throw new Error(`Site ${site} names no account.`);
    }

    return account;
  };
  const where = (ctx) => (ctx.startsWith("branch:")
    ? { context: "branch", "context_parameter": ctx.slice(7) }
    : { context: ctx });
  const flag = (args, name) => args[args.indexOf(name) + 1];

  return async (args) => {
    if (args[0] !== "env:set" && args[0] !== "env:get") return cli(args);

    try {
      const [command, name] = args;
      const site = flag(args, "--site");
      const ctx = flag(args, "--context");
      const acct = encodeURIComponent(await accountOf(site));
      const path = `/accounts/${acct}/env/${encodeURIComponent(name)}?site_id=${
        encodeURIComponent(site)}`;
      const there = await call("GET", path);

      if (command === "env:get") {
        const x = there && there.values.find((v) => v.context
          === where(ctx).context && v["context_parameter"]
          === where(ctx)["context_parameter"]);

        return x && !there["is_secret"] && x.value !== undefined
          ? `${x.value}\n` : "";
      }

      const value = args[2];
      const secret = args.includes("--secret");

      if (there) {
        await call("PATCH", path, { ...where(ctx), value });
      } else {
        await call("POST", path.replace(/\/env\/[^?]*/, "/env"), [{
          key: name,
          "is_secret": secret,
          scopes: ["builds", "functions", "runtime",
            ...(secret ? [] : ["post_processing"])],
          values: [{ ...where(ctx), value }],
        }]);
      }

      return "";
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error
      throw new Error(scrub(error.message));
    }
  };
};

// A value's context as `env:set` names it: production, branch-deploy,
// deploy-preview, dev, all, or branch:<name>.
const contextOf = (v) => (v.context === "branch"
  ? `branch:${v["context_parameter"]}` : v.context);

// The CLI's JSON, or a message that quotes none of it.
const parsed = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Netlify's answer to ${what} wasn't JSON.`);
  }
};

// Every variable on the site, from the API (the CLI's `env:list` shows
// one context and hides how a value is attached). -> [{ name, secret,
// scopes, values: [{ context, value }] }]; a secret's value is never
// returned.
export const remoteVars = async (run, siteId) => {
  if (!siteId) throw new Error("No NETLIFY_SITE_ID in the env file.");

  const site = parsed(await run(["api", "getSite", "--data",
    JSON.stringify({ "site_id": siteId })]), "getSite");
  const account = site["account_id"] || site["account_slug"];

  if (!account) throw new Error(`Site ${siteId} names no account.`);

  const vars = parsed(await run(["api", "getEnvVars", "--data",
    JSON.stringify({ "account_id": account, "site_id": siteId })]),
  "getEnvVars");

  if (!Array.isArray(vars)) {
    throw new Error("Netlify's variable list wasn't a list.");
  }

  return vars.map((v) => ({
    name: v.key,
    secret: !!v["is_secret"],
    scopes: Array.isArray(v.scopes) ? v.scopes : null,
    values: (v.values || []).map((x) => ({
      context: contextOf(x),
      value: x.value,
    })),
  }));
};

// One context's view of the site's variables. -> Map name -> { secret,
// scopes, own, shared: [contexts], value }: own when the context has a
// value of its own; shared naming the wider contexts whose value
// reaches it, and "all" always, since that one value reaches every
// deploy.
export const remoteFor = (vars, env) => {
  const target = TARGETS[env];
  const seen = new Map();

  for (const v of vars) {
    const own = v.values.find((x) => x.context === target.context);
    const shared = v.values.map((x) => x.context)
      .filter((c) => target.shared.includes(c) && (!own || c === "all"));

    if (own || shared.length) {
      seen.set(v.name, {
        secret: v.secret,
        scopes: v.scopes || null,
        own: !!own,
        shared,
        value: own ? own.value
          : v.values.find((x) => x.context === shared[0]).value,
      });
    }
  }

  return seen;
};

// The three-way comparison. -> { problems, unset }: problems are
// lines naming keys; unset are the commands that would clear a name
// Netlify has and the file doesn't, for James to run (push never
// deletes).
export const checkEnv = ({ env, sample, local, remote, file }) => {
  const { context } = TARGETS[env];
  const ignored = ignoredNames(env);
  const problems = [...sample.errors.map((e) => `Sample: ${e}`),
    ...local.errors.map((e) => `${file}: ${e}`)];
  const unset = [];
  const inSample = new Set([...sample.keys, ...sample.local]);
  const unsetOwn = (name) => unset.push(
    `bin/nff netlify env:unset ${name} --context ${context}`);
  const forbidden = (where, names) => {
    for (const name of stagingOnlyIn(env, names)) {
      problems.push(`${name}: is staging only, yet in ${where}.`);
    }
  };

  const retired = (where, names) => {
    for (const name of retiredIn(names)) {
      problems.push(`${name}: is retired, yet in ${where}. Use ${
        "FARM_, DEV_ and ESCALATED_NOTIFICATIONS_EMAIL"}.`);
    }
  };

  retired("the sample", inSample);
  retired(file, local.values.keys());
  retired(`Netlify's ${context}`, remote.keys());
  for (const name of retiredIn(remote.keys())) {
    if (remote.get(name).own) unsetOwn(name);
  }
  forbidden("the sample", inSample);
  forbidden(file, local.values.keys());
  forbidden(`Netlify's ${context}`, remote.keys());
  for (const name of stagingOnlyIn(env, remote.keys())) {
    if (remote.get(name).own) unsetOwn(name);
  }

  for (const name of sample.keys) {
    const value = local.values.get(name);
    const there = remote.get(name);

    if (value === undefined && !isOptional(sample, name)) {
      problems.push(`${name}: in the sample, not in ${file}.`);
    } else if (!value && isOptional(sample, name) && there) {
      problems.push(`${name}: empty in ${file}, set on Netlify's ${
        context}.`);
      if (there.own) unsetOwn(name);
    } else if (!value && !isOptional(sample, name)) {
      // Never a delete: the key is required, and the file is behind.
      problems.push(`${name}: empty in ${file}: fill it in.`);
    }
    if (!there) {
      if (!isOptional(sample, name) || value) {
        problems.push(`${name}: not on Netlify's ${context} (env push).`);
      }
      continue;
    }
    if (there.shared.length) {
      problems.push(`${name}: its value is attached to ${
        there.shared.join(" and ")}, not ${context} alone.`);
    }
    if (there.scopes && !there.scopes.includes("builds")) {
      problems.push(`${name}: not in the builds scope, so the build ` +
        "can't check it.");
    }
    if (sample.secrets.includes(name) && !there.secret) {
      problems.push(`${name}: plain on Netlify, secret in the sample. ` +
        "env push can't change that: mark it secret in the Netlify UI, " +
        "or unset it and push again.");
    } else if (!sample.secrets.includes(name) && !there.secret && value
      && there.value !== undefined && there.value !== value) {
      problems.push(`${name}: differs from ${file} (env push).`);
    }
  }

  for (const name of local.values.keys()) {
    if (!inSample.has(name) && !ignored.has(name)
      && !stagingOnlyIn(env, [name]).length && !retiredIn([name]).length) {
      problems.push(`${name}: in ${file}, not in the sample.`);
    }
  }

  for (const [name, there] of remote) {
    if (inSample.has(name) && !sample.local.includes(name)) continue;
    if (ignored.has(name) || netlifyOwn(name)) continue;
    if (stagingOnlyIn(env, [name]).length || retiredIn([name]).length) continue;

    problems.push(sample.local.includes(name)
      ? `${name}: local only, yet on Netlify's ${context}.`
      : `${name}: on Netlify's ${context}, not in the sample.`);
    if (there.own) unsetOwn(name);
  }

  return { problems, unset };
};

// What deploy previews and `dev` may hold (#251, #255): the context
// name and the pickup schedule, nothing else. The repository is
// public, so a preview of any branch runs code anyone can write, with
// whatever its context holds. A preview then has no payment keys, no
// Resend keys and no webhook secrets, and the API says so (lib/site
// and orders.mjs: payments off).
export const PREVIEW_CONTEXTS = ["deploy-preview", "dev"];
export const PREVIEW_ALLOWED = new Set(["SITE_CONTEXT", "PICKUP_SCHEDULE"]);

// Every variable that reaches a preview or `dev` context beyond
// PREVIEW_ALLOWED: a value of its own there, or one attached to "all",
// which reaches every context, production's included. Netlify returns
// no secret's value, so the proof is by name: a name outside the list
// has no business in those contexts. SITE_CONTEXT must not say
// production. -> { problems, unset }, names only; unset are the
// commands James runs, since nothing here deletes.
export const previewLeaks = (vars) => {
  const problems = [];
  const unset = [];

  for (const v of vars) {
    if (netlifyOwn(v.name)) continue;

    for (const x of v.values) {
      const reaches = x.context === "all" ? PREVIEW_CONTEXTS
        : PREVIEW_CONTEXTS.filter((c) => c === x.context);

      if (!reaches.length) continue;

      const command = `bin/nff netlify env:unset ${v.name} ` +
        `--context ${x.context}`;

      if (!PREVIEW_ALLOWED.has(v.name)) {
        problems.push(x.context === "all"
          ? `${v.name}: attached to all, so production's value reaches ${
            reaches.join(" and ")}.`
          : `${v.name}: has a value on Netlify's ${x.context}, which may ` +
            "hold only SITE_CONTEXT and PICKUP_SCHEDULE.");
        unset.push(command);
      } else if (v.name === "SITE_CONTEXT" && x.value === "production") {
        problems.push(`SITE_CONTEXT: says production on ${
          x.context === "all" ? reaches.join(" and ") : x.context}.`);
        unset.push(command);
      } else if (x.context === "all") {
        problems.push(`${v.name}: attached to all, so production's value ` +
          `reaches ${reaches.join(" and ")}.`);
        unset.push(command);
      }
    }
  }

  return { problems, unset };
};

// A Netlify build's CONTEXT and BRANCH -> the sample it answers to, or
// null for a preview or another branch.
export const buildEnvironment = ({ CONTEXT: context, BRANCH: branch }) => {
  if (context === "production") return "production";
  if (context === "branch-deploy" && branch === "staging") return "staging";

  return null;
};

// The build's check: every key the sample lists for this context is
// in the environment and not empty. -> the missing names.
export const missingAtBuild = (sample, environment) => sample.keys
  .filter((name) => !isOptional(sample, name))
  .filter((name) => !environment[name]);
