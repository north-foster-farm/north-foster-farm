// The harness of the #612 criteria tests (test/hotfix.test.mjs and
// test/hotfix-round3.criteria.mjs): throwaway repositories, the seam
// the commands reach git and GitHub through, and the checks the tests
// share. What the tests expect, and the contract, are in those files'
// headers. The implementer may change how this runs, never what a
// test expects.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { promisify } from "node:util";

import { hotfixCommand } from "../bin/hotfix.mjs";

export const exec = promisify(execFile);

export const fixture = (name) => JSON.parse(readFileSync(new URL(
  `fixtures/github/${name}.json`, import.meta.url), "utf8"));
export const F = fixture("ruleset-25361439");
export const RULESET_PATH =
  /^\/?repos\/north-foster-farm\/north-foster-farm\/rulesets\/25361439$/;
export const CHECKS_PATH = new RegExp("^/?repos/north-foster-farm/"
  + "north-foster-farm/commits/([0-9a-f]{40})/check-runs(?:\\?(.*))?$");
export const GREEN = fixture("check-runs-green").response;
export const NONE = fixture("check-runs-none").response;
export const REQUIRED = ["lint-and-test", "supply-chain", "codeql"];

export const ZERO = "0".repeat(40);
// The saved copy's file, in the git common directory (round 3, B).
export const LEFTOVER = "nff-hotfix-ruleset-25361439.json";
const ROOT = mkdtempSync(join(tmpdir(), "hotfix-criteria-"));
const GLOBAL = join(ROOT, "gitconfig");

writeFileSync(GLOBAL, "");
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Git with none of this machine's own settings (signing, hooks,
// editors), so the repositories behave the same here and in CI.
export const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: "1",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
};

export const gitIn = (cwd) => async (args) => (await exec("git", args,
  { cwd, env: ENV, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

export const A =
  ["one", "two", "three", "four", "five", "six", "seven", "eight"];
export const lines = (list) => `${list.join("\n")}\n`;
export const withLine = (i, text) =>
  lines(A.map((l, j) => (j === i ? text : l)));

// The pre-receive hook: one line per ref update, `<push> <old> <new>
// <ref>`, where <push> tells one push from another.
const HOOK = (log) => [
  "#!/bin/sh",
  "while read old new ref",
  "do",
  `  echo "$$ $old $new $ref" >> "${log}"`,
  "done",
  "exit 0",
  "",
].join("\n");

// Each file's text (a string or bytes), or null to delete it.
export const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(dir, name), { force: true });
    } else {
      writeFileSync(join(dir, name), text);
    }
  }
};

export const commit = async (g, dir, files, subject) => {
  write(dir, files);
  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", subject]);

  return g(["rev-parse", "HEAD"]);
};

let count = 0;

// The repositories, as they stand when a hotfix is wanted: `staging`
// one commit ahead of `main`, `next` two ahead of `staging`, a lane
// cut from `next` and one cut from `main`, a backup branch and a tag.
// `base` adds files to `main`'s first commit, and `shape(seed, c, dir)`
// may rearrange origin before the checkouts clone it.
export const world = async ({ base = {}, shape } = {}) => {
  count += 1;
  const dir = join(ROOT, `w${count}`);
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const work = join(dir, "work");
  const lander = join(dir, "lander");
  const log = join(dir, "pushes.log");

  mkdirSync(seed, { recursive: true });
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin],
    { env: ENV });
  writeFileSync(join(origin, "hooks", "pre-receive"), HOOK(log));
  chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
  writeFileSync(log, "");

  const s = gitIn(seed);

  await s(["init", "-q", "-b", "main"]);
  await s(["remote", "add", "origin", origin]);

  const c = {};

  c.M0 = await commit(s, seed,
    { "a.txt": lines(A), "b.txt": "bee\n", ...base }, "Start the site");
  await s(["tag", "v1"]);
  c.S1 = await commit(s, seed, { "c.txt": "sea\n" }, "Add c");
  c.N1 = await commit(s, seed, { "b.txt": "bee changed on next\n" },
    "Change b");
  c.N2 = await commit(s, seed,
    { "a.txt": withLine(1, "two from next"), "d.txt": "dee\n" },
    "Reword two");
  await s(["checkout", "-q", "-b", "lane/alpha"]);
  c.alpha = await commit(s, seed, { "e.txt": "alpha\n" }, "Alpha work");
  await s(["checkout", "-q", "-b", "lane/beta", c.M0]);
  c.beta = await commit(s, seed, { "f.txt": "beta\n" }, "Beta work");
  await s(["checkout", "-q", "--detach", c.M0]);

  await s(["push", "-q", "origin",
    `${c.M0}:refs/heads/main`, `${c.S1}:refs/heads/staging`,
    `${c.N2}:refs/heads/next`, "lane/alpha", "lane/beta",
    `${c.S1}:refs/heads/backup/keep`, "refs/tags/v1"]);

  if (shape) await shape(s, c, seed);

  await exec("git", ["clone", "-q", origin, work], { env: ENV });
  await exec("git", ["clone", "-q", origin, lander], { env: ENV });

  const w = gitIn(work);
  const gitCalls = [];
  const events = [];
  const leftover = join(await w(["rev-parse", "--path-format=absolute",
    "--git-common-dir"]), LEFTOVER);
  const saved = () => (existsSync(leftover)
    ? readFileSync(leftover, "utf8") : null);
  // CI's verdict on a commit origin took as a head: "green", "partial"
  // (codeql has not run) or "none" (nothing has run yet).
  const ci = () => t.ci;
  const heads = () => new Set(t.pushes()
    .filter((p) => /^refs\/heads\/(next|staging|main)$/.test(p.ref))
    .map((p) => p.now));
  const gh = github(events, { ci, heads });
  const failed = (args) => Object.assign(
    new Error(`git ${args.join(" ")} failed`),
    { stdout: "", stderr: "! [remote rejected]" });
  const t = {
    dir, origin, work, c, gh, gitCalls, events, leftover, saved,
    seed: s, w, o: gitIn(origin), l: gitIn(lander), lander,
    // The answer to every question, the questions asked, which pushes
    // fail (`failPush` before origin takes them, `failAfter` once
    // origin has taken them, as a dropped connection would), and what
    // CI has made of the heads origin took.
    answer: true, questions: [], asked: [], printed: [], ci: "green",
    failPush: () => false, failAfter: () => false,
    deps: {
      // A push is logged with the ruleset as it stood when it was made.
      git: async (args) => {
        gitCalls.push(args);
        if (args[0] === "push") {
          events.push({ kind: "push", args, ruleset: gh.state() });
          if (t.failPush(args)) throw failed(args);
          if (t.failAfter(args)) {
            await w(args);
            throw failed(args);
          }
        }

        return w(args);
      },
      // A write is logged with the saved copy's file as it stood when
      // the write was sent.
      api: (path, options = {}) => {
        if ((options.method ?? "GET") !== "GET") {
          events.push({ kind: "send", body: options.body, file: saved() });
        }

        return gh.api(path, options);
      },
      // What was printed before each question is kept with it, so a
      // test can tell what the reader saw before answering.
      confirm: async (question) => {
        t.questions.push(String(question));
        t.asked.push({ question: String(question), before: [...t.printed] });

        return t.answer;
      },
    },
    pushes: () => readFileSync(log, "utf8").split("\n").filter(Boolean)
      .map((line) => {
        const [push, old, now, ref] = line.split(" ");

        return { push, old, now, ref };
      }),
  };

  return t;
};

// GitHub, answering from the recorded GET of ruleset 25361439. A PUT
// is answered with that recording's shape carrying what was sent, as
// GitHub returns the ruleset it stored; no PUT was recorded, since
// that would change the real ruleset. With `tamper` on, a PUT that
// gives `next` back is stored without `staging`, as if GitHub had not
// taken the restore whole, so the read-back differs from the saved
// copy. With `failRestore` on, every such PUT fails and changes
// nothing, as a run killed in the window would leave it. `set` puts
// the ruleset as a test derived it. The check runs of a commit are
// the green recording, with its head_sha, once origin took the commit
// as a head (less the codeql runs when CI is "partial"), and the empty
// recording otherwise; both paged as GitHub pages them. Any other call
// was never recorded.
const checkRuns = (sha, query, { ci, heads }) => {
  const params = new URLSearchParams(query ?? "");
  const size = Number(params.get("per_page") ?? 30);
  const page = Number(params.get("page") ?? 1);
  let all = [];

  if (heads().has(sha) && ci() !== "none") {
    all = GREEN.check_runs.map((run) => ({ ...run, head_sha: sha }))
      .filter((run) => ci() !== "partial" || run.name !== "codeql");
  }

  return {
    ...structuredClone(NONE), total_count: all.length,
    check_runs: structuredClone(all.slice((page - 1) * size, page * size)),
  };
};

const github = (events, commits) => {
  let current = structuredClone(F.ruleset);
  const calls = [];
  const gh = { tamper: false };
  const api = async (path, { method = "GET", body } = {}) => {
    calls.push({ path, method, body });
    const checks = CHECKS_PATH.exec(path);

    if (checks && method === "GET") {
      events.push({ kind: "checks", sha: checks[1] });

      return checkRuns(checks[1], checks[2], commits);
    }
    if (!RULESET_PATH.test(path)) {
      throw new Error(`unrecorded ${method} ${path}`);
    }
    if (method === "GET") {
      events.push({ kind: "read" });

      return structuredClone(current);
    }
    if (method === "PUT") {
      const restoring = (body?.conditions?.ref_name?.include ?? [])
        .includes("refs/heads/next");

      if (gh.failRestore && restoring) {
        events.push({ kind: "failed write" });
        throw new Error(`HTTP 502: PUT ${path}`);
      }
      current = { ...current, ...structuredClone(body) };
      const include = current.conditions?.ref_name?.include ?? [];

      if (gh.tamper && include.includes("refs/heads/next")) {
        current.conditions.ref_name.include =
          include.filter((ref) => ref !== "refs/heads/staging");
      }
      events.push({ kind: "write", ruleset: structuredClone(current) });

      return structuredClone(current);
    }
    throw new Error(`unrecorded ${method} ${path}`);
  };

  return Object.assign(gh, {
    api, calls, state: () => structuredClone(current),
    set: (ruleset) => {
      current = structuredClone(ruleset);
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
  });
};

// The parts of a ruleset that say what it protects.
export const guards = (r) => ({
  name: r.name, target: r.target, enforcement: r.enforcement,
  conditions: r.conditions, rules: r.rules, bypass_actors: r.bypass_actors,
});

// Every ref and what it points at.
export const refs = async (g) => Object.fromEntries((await g(["for-each-ref",
  "--format=%(refname) %(objectname)"])).split("\n").filter(Boolean)
  .map((line) => line.split(" ")));

export const head = (o, name) => o(["rev-parse", `refs/heads/${name}`]);
// A file as origin holds it, to the last byte.
export const show = async (t, ref, file) => (await exec("git",
  ["show", `${ref}:${file}`], { cwd: t.origin, env: ENV })).stdout;
export const has = async (o, ref, file) => {
  try {
    await o(["cat-file", "-e", `${ref}:${file}`]);

    return true;
  } catch {
    return false;
  }
};
export const isAncestor = async (g, a, b) => {
  try {
    await g(["merge-base", "--is-ancestor", a, b]);

    return true;
  } catch {
    return false;
  }
};
export const changedRefs = (before, now) => [...new Set([
  ...Object.keys(before), ...Object.keys(now),
])].filter((k) => before[k] !== now[k]).sort();

// One run of a command, as bin/nff would make it.
export const run = async (t, action, { dryRun = false, flags = {} } = {}) => {
  const printed = [];
  const from = t.pushes().length;
  const calls = t.gitCalls.length;
  const seen = t.events.length;
  let error;

  t.printed = printed;
  try {
    await hotfixCommand(action, [], {
      flags: dryRun ? { ...flags, "dry-run": true } : flags,
      out: (line) => printed.push(String(line)),
    }, t.deps);
  } catch (e) {
    error = e;
  }

  return {
    error, printed,
    text: [...printed, error?.message ?? ""].join("\n"),
    pushes: t.pushes().slice(from),
    gitCalls: t.gitCalls.slice(calls),
    events: t.events.slice(seen),
  };
};

export const ok = (r) => assert.ifError(r.error);
export const refused = (r) => {
  assert.ok(r.error, "it refuses");
  assert.match(r.error.message, /^Refused:/);
};

// The hotfix, landed by the ordinary means: a commit on `next`, then
// `staging`, then `main`, each a fast-forward. `to` picks the branches.
export const land = async (t, files, subject,
  { to = ["next", "staging", "main"], pick } = {}) => {
  await t.l(["fetch", "-q", "origin"]);
  await t.l(["checkout", "-q", "-B", "hot", "origin/next"]);

  let sha;

  if (pick) {
    await t.l(["cherry-pick", pick]);
    await t.l(["commit", "-q", "--amend", "-m", subject]);
    sha = await t.l(["rev-parse", "HEAD"]);
  } else {
    sha = await commit(t.l, t.lander, files, subject);
  }
  for (const branch of to) {
    await t.l(["push", "-q", "origin", `${sha}:refs/heads/${branch}`]);
  }

  return sha;
};

// Both steps of `finish`, the second once CI is green on `next`. The
// second is not run if the first failed.
export const finishBoth = async (t, options) => {
  const one = await run(t, "finish", options);
  const two = one.error ? undefined : await run(t, "finish", options);
  const all = two ? [one, two] : [one];

  return {
    one, two, error: one.error ?? two?.error,
    text: all.map((r) => r.text).join("\n"),
    pushes: all.flatMap((r) => r.pushes),
    gitCalls: all.flatMap((r) => r.gitCalls),
    events: all.flatMap((r) => r.events),
  };
};

export const PLAIN = [{ "a.txt": withLine(7, "eight fixed") }, "Fix eight"];
export const CONFLICT = [{ "a.txt": withLine(1, "two from main") }, "Fix two"];

// A resolution of CONFLICT that keeps both sides' lines, so the rebuilt
// next holds every line the placeholder added.
export const RESOLVED = lines(
  [A[0], "two from main", "two from next", ...A.slice(2)]);

// A placeholder commit's subject and the word that says it was dropped,
// on one printed line.
export const reportsDropped = (text, subject) => text.split("\n").some((line) =>
  line.includes(subject) && /drop|already/i.test(line));

// Force for every ref a push names, and force for one ref only
// (`--force-with-lease=<ref>` or `=<ref>:<expected>`).
export const FORCE = /^(-f|--force|--force-with-lease|--force-if-includes)$/;
export const LEASE = /^--force-with-lease=([^:]+)/;
export const branchOf = (ref) => ref.replace(/^\+/, "")
  .replace(/^refs\/heads\//, "");

// The destinations of one `git push` the seam saw, each with whether it
// was pushed with force and whether it was a deletion.
export const pushTargets = (args) => {
  const words = args.slice(1);
  const forced = words.some((w) => FORCE.test(w));
  const leased = words.map((w) => LEASE.exec(w)?.[1]).filter(Boolean)
    .map(branchOf);
  const deleting = words.includes("-d") || words.includes("--delete");
  const plain = words.filter((w) => !w.startsWith("-")).slice(1);

  return plain.map((spec) => {
    const dst = branchOf(spec.includes(":")
      ? spec.split(":").at(-1) : spec);

    return {
      spec, dst,
      force: forced || leased.includes(dst) || spec.startsWith("+"),
      delete: deleting || spec.startsWith(":"),
    };
  });
};

// The pushes among a run's events that move `next` or `staging`.
export const branchPushes = (events) => events.filter((e) => e.kind === "push"
  && pushTargets(e.args)
    .some((x) => !x.delete && ["next", "staging"].includes(x.dst)));

// One run kept its pushes to `next` and `staging` inside the window:
// narrowed to `main` alone before the first, restored to the saved
// copy after the last, and read back after that.
export const windowHeld = (r, label) => {
  const pushes = branchPushes(r.events);
  const writes = r.events.filter((e) => e.kind === "write");
  const at = (e) => r.events.indexOf(e);

  assert.ok(pushes.length > 0, `${label} pushes next or staging`);
  assert.ok(writes.length >= 2, `${label} narrows and restores the ruleset`);
  assert.ok(at(writes[0]) < at(pushes[0]),
    `${label} narrows the ruleset before its first push`);
  for (const p of pushes) {
    assert.deepEqual(p.ruleset.conditions.ref_name.include,
      ["refs/heads/main"], `${label} pushes while it covers main alone`);
  }
  assert.ok(at(writes.at(-1)) > at(pushes.at(-1)),
    `${label} restores the ruleset after its last push`);
  assert.deepEqual(guards(writes.at(-1).ruleset), guards(F.ruleset),
    `${label} restores the saved copy`);
  assert.ok(r.events.slice(at(writes.at(-1)) + 1)
    .some((e) => e.kind === "read"), `${label} reads it back after`);
};

// A run that needs no window: any push it forces to `next` or `staging`
// is made inside one all the same, and a run that writes the ruleset
// at all restores the saved copy and reads it back.
export const noBareForce = (r, label) => {
  const writes = r.events.filter((e) => e.kind === "write");

  for (const p of r.events.filter((e) => e.kind === "push")) {
    for (const x of pushTargets(p.args)) {
      if (x.force && !x.delete && ["next", "staging"].includes(x.dst)) {
        assert.deepEqual(p.ruleset.conditions.ref_name.include,
          ["refs/heads/main"], `${label} forces ${x.dst} only inside the `
          + "window");
      }
    }
  }
  if (writes.length) {
    assert.deepEqual(guards(writes.at(-1).ruleset), guards(F.ruleset),
      `${label} restores the saved copy`);
    assert.ok(r.events.slice(r.events.indexOf(writes.at(-1)) + 1)
      .some((e) => e.kind === "read"), `${label} reads it back after`);
  }
};

// No write ever left `main` open: it stays covered, both rules stay,
// and no one may bypass them.
export const neverOpens = (events) => {
  for (const { ruleset } of events.filter((e) => e.kind === "write")) {
    const types = (ruleset.rules ?? []).map((rule) => rule.type);

    assert.ok(ruleset.conditions.ref_name.include
      .includes("refs/heads/main"), "main stays in the ruleset");
    assert.ok(types.includes("non_fast_forward"),
      "the no force-push rule stays");
    assert.ok(types.includes("deletion"), "the no deletion rule stays");
    assert.deepEqual(ruleset.bypass_actors, [], "no bypass actor");
  }
};

