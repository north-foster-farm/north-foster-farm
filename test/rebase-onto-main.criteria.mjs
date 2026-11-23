// Criteria tests for #890 (a guarded command to rebase staging onto
// main inside the ruleset window), written by the test agent from the
// issue's words alone, before any implementation (2026-11-23). One
// `it` per box of the "Done when" list marked (test), named for its
// box. Held out of `npm test` as rebase-onto-main.criteria.mjs until
// the implementer renames it to rebase-onto-main.test.mjs, a pure
// rename.
//
// What the issue asks: when `main` has moved ahead of `staging`, one
// command rebases `next` and `staging` onto `main`, forcing `next`
// first and then `staging`, each push inside ruleset 25361439's
// force-push window, reusing hotfix's `window()` and preflight
// (bin/hotfix.mjs). `staging` takes the rebased commit only once its
// required checks (lint-and-test, supply-chain, codeql) pass on a push
// to `next`.
//
// PROVISIONAL, since the issue names none of it; each is the test
// agent's pick, and the implementer may change it here, in the same
// change, saying so:
// - The module is bin/rebase.mjs. It exports
//   `rebaseCommand(rest, { flags, out }, deps)`, as hotfixCommand
//   takes its arguments, and `bin/nff rebase [--dry-run]` routes to it.
//   `deps` is hotfix's seam: `git`, `api`, `sleep`, `signals` and
//   `confirm`, which test/hotfix-world.mjs fills with real git against
//   throwaway repositories and the recorded GitHub.
// - It takes two runs, as `bin/nff hotfix finish` does. The first
//   rebuilds `staging` (its own commits onto `main`) and `next` (its own
//   commits onto the rebuilt staging), and force-pushes `next` to the
//   rebuilt staging inside the window, keeping the rebuilt next on
//   origin under a name of the implementer's choosing; `staging` does
//   not move. The second, once the three checks are green on `next`,
//   force-pushes `staging` to that commit inside a second window and
//   moves `next` to the rebuilt next. A run before they are green
//   refuses, naming each check not yet green. These tests read only
//   where the branches end up, never the kept branch's name.
// - A refusal's message begins "Refused:", as hotfix's do.
// - "Every use is logged" is read with James's comment on the issue
//   ("Its use of the force-push window is logged each time"): one
//   line per window, through netlify/functions/lib/log.mjs, as
//   `{ event: "rebase.window", by: "cli", branch, beforeId, afterId }`:
//   the branch the window forced (`next` in the first, `staging` in
//   the second) and its commit before and after. The commits sit under
//   id keys because log.mjs's scrub turns any run of 10 or more digits
//   under any other key into "[phone]", and a SHA often holds one
//   (seen while writing these tests). A window whose push fails is
//   logged too. A refusal and a dry run log nothing (docs/security.md,
//   "Logging changes to production records").

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { shipLog } from "../bin/ship-log.mjs";
import { flush } from "../netlify/functions/lib/log.mjs";
import {
  F, REQUIRED, ZERO, commit, guards, has, head, isAncestor, neverOpens,
  pushTargets, refs, show, withLine, world,
} from "./hotfix-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Loaded per test, so the missing module fails each test, not the file.
// The path is a URL, not a literal, so Knip (npm run lint) does not
// refuse the import of a module that does not exist yet.
const MODULE = new URL("../bin/rebase.mjs", import.meta.url).href;
const load = async () => {
  const module = await import(MODULE);

  assert.equal(typeof module.rebaseCommand, "function",
    "bin/rebase.mjs exports rebaseCommand");

  return module.rebaseCommand;
};

// The hotfix that put `main` ahead of `staging`: a commit on `main`
// that neither `staging` nor `next` holds.
const HOTFIX = [{ "a.txt": withLine(7, "eight fixed") }, "Fix eight"];

// The repositories of test/hotfix-world.mjs (`staging` one commit past
// the old `main`, `next` two past `staging`, lane/alpha cut from
// `next`, lane/beta from the old `main`), with `main` moved one commit
// ahead, as a hotfix through a release branch leaves it.
const ahead = (more) => world({
  shape: async (s, c, seed) => {
    c.H = await commit(s, seed, ...HOTFIX);
    await s(["push", "-q", "origin", `${c.H}:refs/heads/main`]);
    if (more) await more(s, c, seed);
  },
});

// No waits, so the restore's retries take no time.
const quick = (t) => {
  t.deps.sleep = async () => {};

  return t;
};

// One run of the command, as bin/nff would make it.
const rebase = async (t, { dryRun = false, flags = {} } = {}) => {
  const printed = [];
  const from = t.pushes().length;
  const seen = t.events.length;
  let error;

  t.printed = printed;
  try {
    const rebaseCommand = await load();

    await rebaseCommand([], {
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
    events: t.events.slice(seen),
  };
};

const ok = (r, label = "it runs") => assert.ifError(r.error, label);
const refused = (r) => {
  assert.ok(r.error, "it refuses");
  assert.match(r.error.message, /^Refused:/);
};

// A refusal that changed nothing: no push, no ruleset write, no saved
// copy left, origin's refs as they were.
const nothingChanged = async (t, r, before) => {
  assert.deepEqual(r.pushes, [], "nothing is pushed");
  assert.deepEqual(r.events.filter((e) => e.kind === "write"), [],
    "the ruleset is not written");
  assert.deepEqual(await refs(t.o), before, "origin's refs are unchanged");
};

// The pushes among a run's events that force `next` or `staging`.
const forced = (events) => events.filter((e) => e.kind === "push"
  && pushTargets(e.args).some((x) => x.force && !x.delete
    && ["next", "staging"].includes(x.dst)));

const moves = (args) => args[0] === "push" && pushTargets(args)
  .some((x) => !x.delete && ["next", "staging"].includes(x.dst));

// One run's window: narrowed to `main` alone, with the saved copy
// already in its file, before its first forced push; every forced push
// made while it covers `main` alone; the saved copy restored after the
// last, read back after that, and its file gone.
const windowHeld = (t, r, label) => {
  const pushes = forced(r.events);
  const writes = r.events.filter((e) => e.kind === "write");
  const sends = r.events.filter((e) => e.kind === "send");
  const at = (e) => r.events.indexOf(e);

  assert.ok(pushes.length > 0, `${label} forces next or staging`);
  assert.ok(writes.length >= 2, `${label} narrows and restores the ruleset`);
  assert.ok(at(writes[0]) < at(pushes[0]),
    `${label} narrows the ruleset before it forces a push`);
  assert.deepEqual(JSON.parse(sends[0].file), guards(F.ruleset),
    `${label} saves the whole ruleset to its file before it narrows it`);
  for (const p of pushes) {
    assert.deepEqual(p.ruleset.conditions.ref_name.include,
      ["refs/heads/main"], `${label} forces while it covers main alone`);
  }
  assert.ok(at(writes.at(-1)) > at(pushes.at(-1)),
    `${label} restores the ruleset after its last forced push`);
  assert.deepEqual(guards(writes.at(-1).ruleset), guards(F.ruleset),
    `${label} restores the saved copy`);
  assert.ok(r.events.slice(at(writes.at(-1)) + 1)
    .some((e) => e.kind === "read"), `${label} reads it back after`);
  assert.equal(t.saved(), null, `${label} deletes the saved copy after`);
  assert.deepEqual(guards(t.gh.state()), guards(F.ruleset),
    `${label} leaves ruleset 25361439 whole`);
};

// The subjects of the commits in `range` on origin, oldest first.
const subjects = async (t, range) => (await t.o(["log", "--reverse",
  "--format=%s", range])).split("\n").filter(Boolean);

// Both runs, the second once CI is green on `next`.
const both = async (t) => {
  const one = await rebase(t);

  ok(one, "the first run");
  const mid = await refs(t.o);
  const two = await rebase(t);

  ok(two, "the second run");

  return { one, two, mid };
};

// The lines the runs left for bin/nff to ship, as shipped.
const AXIOM = { AXIOM_TOKEN: "t", AXIOM_DATASET: "nff-site" };
const shipped = async () => {
  const bodies = [];

  await shipLog({
    env: AXIOM,
    fetchImpl: async (url, init) => {
      bodies.push(init.body);

      return { ok: true, status: 200 };
    },
  });

  return bodies.flatMap((b) => JSON.parse(b))
    .map((l) => ({ ...l, ...l.data }))
    .filter((l) => l.event === "rebase.window");
};

describe("bin/nff rebase: next and staging onto main (#890)", () => {
  it("box 1: one command rebases next and staging onto main, reusing "
    + "hotfix's window() and preflight: it refuses unless ruleset "
    + "25361439 covers exactly next, staging and main, saves its copy "
    + "without overwriting one, restores it on exit and on INT, TERM and "
    + "HUP, and reads the whole ruleset back", async () => {
    // It rebases both, each forced push inside its own window.
    {
      const t = quick(await ahead());
      const { c } = t;
      const others = async () => ({
        alpha: await head(t.o, "lane/alpha"),
        beta: await head(t.o, "lane/beta"),
        keep: await head(t.o, "backup/keep"),
        tag: await t.o(["rev-parse", "refs/tags/v1"]),
      });
      const lanes = await others();
      const { one, two, mid } = await both(t);

      windowHeld(t, one, "the first run");
      assert.ok(forced(one.events).some((e) => pushTargets(e.args)
        .some((x) => x.dst === "next")), "the first window forces next");
      windowHeld(t, two, "the second run");
      assert.ok(forced(two.events).some((e) => pushTargets(e.args)
        .some((x) => x.dst === "staging")), "the second window forces "
        + "staging");
      assert.equal(mid["refs/heads/staging"], c.S1,
        "next is forced first; staging waits");
      neverOpens([...one.events, ...two.events]);

      const main = await head(t.o, "main");
      const staging = await head(t.o, "staging");
      const next = await head(t.o, "next");

      assert.equal(main, c.H, "main does not move");
      assert.ok(await isAncestor(t.o, main, staging), "staging holds main");
      assert.ok(await isAncestor(t.o, staging, next), "next holds staging");
      assert.deepEqual(await subjects(t, `${main}..${staging}`), ["Add c"],
        "staging is its own commit replayed onto main");
      assert.deepEqual(await subjects(t, `${main}..${next}`),
        ["Add c", "Change b", "Reword two"],
        "next is its own commits replayed onto the rebuilt staging");
      assert.equal(await t.o(["rev-list", "--merges", `${main}..${next}`]),
        "", "with no merge commit");
      assert.equal(await show(t, "staging", "a.txt"),
        withLine(7, "eight fixed"), "staging has the hotfix");
      assert.equal(await show(t, "staging", "c.txt"), "sea\n",
        "and its own change");
      assert.ok(!await has(t.o, "staging", "d.txt"),
        "and none of next's");
      assert.equal(await show(t, "next", "a.txt"), [
        "one", "two from next", "three", "four", "five", "six", "seven",
        "eight fixed", "",
      ].join("\n"), "next has the hotfix and its own change");
      assert.equal(await show(t, "next", "b.txt"), "bee changed on next\n");
      assert.equal(await show(t, "next", "d.txt"), "dee\n");
      assert.deepEqual(await others(), lanes,
        "lanes, other branches and tags are not moved");
    }

    // It refuses unless the ruleset covers exactly next, staging and
    // main, with both its rules.
    const include = (list) => {
      const r = structuredClone(F.ruleset);

      r.conditions.ref_name.include = list;

      return r;
    };
    const noDeletion = structuredClone(F.ruleset);

    noDeletion.rules = noDeletion.rules.filter((x) => x.type !== "deletion");
    for (const [label, ruleset] of [
      ["a branch more", include(["refs/heads/next", "refs/heads/staging",
        "refs/heads/main", "refs/heads/release/*"])],
      ["staging missing", include(["refs/heads/next", "refs/heads/main"])],
      ["main alone", include(["refs/heads/main"])],
      ["no deletion rule", noDeletion],
    ]) {
      const t = quick(await ahead());

      t.gh.set(ruleset);
      const before = await refs(t.o);
      const r = await rebase(t);

      refused(r);
      assert.match(r.error.message, /25361439/, `${label}: names the ruleset`);
      await nothingChanged(t, r, before);
      assert.equal(t.saved(), null, `${label}: writes no saved copy`);
    }

    // A saved copy already there is never overwritten: it refuses.
    {
      const t = quick(await ahead());
      const left = `${JSON.stringify(guards(F.ruleset), null, 2)}\n`
        .replace("\n", "\n  \"left\": \"by an earlier run\",\n");

      writeFileSync(t.leftover, left);
      const before = await refs(t.o);
      const r = await rebase(t);

      refused(r);
      await nothingChanged(t, r, before);
      assert.equal(readFileSync(t.leftover, "utf8"), left,
        "the saved copy is left byte for byte");
    }

    // A push that fails inside the window: the ruleset is restored all
    // the same, read back, and the file goes.
    {
      const t = quick(await ahead());
      const before = await refs(t.o);

      t.failPush = moves;
      const r = await rebase(t);

      assert.ok(r.error, "the failed push is an error");
      assert.deepEqual(guards(t.gh.state()), guards(F.ruleset),
        "the ruleset is restored after a failed push");
      assert.equal(t.saved(), null, "and the saved copy deleted");
      assert.deepEqual(await refs(t.o), before, "nothing moved");
      neverOpens(r.events);
    }

    // INT, TERM and HUP inside the window restore the ruleset before the
    // process exits.
    for (const [signal, code] of
      [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
      const t = quick(await ahead());
      const handlers = new Map();
      let exited;
      let exit;
      const done = new Promise((resolve) => {
        exit = resolve;
      });
      const { git } = t.deps;

      t.deps.signals = {
        on: (name, handler) => handlers.set(name, handler),
        off: (name) => handlers.delete(name),
        exit: (n) => {
          exited = n;
          exit();
        },
      };
      // The signal comes while the push runs; the push then dies.
      t.deps.git = async (args) => {
        if (!moves(args)) return git(args);
        assert.deepEqual(t.gh.state().conditions.ref_name.include,
          ["refs/heads/main"], `${signal}: the window is open`);
        handlers.get(signal)();
        await done;
        throw new Error("killed");
      };
      await rebase(t);
      assert.equal(exited, code, `${signal} exits ${code}`);
      assert.deepEqual(guards(t.gh.state()), guards(F.ruleset),
        `${signal} restores the ruleset`);
      assert.equal(t.saved(), null, `${signal} deletes the saved copy`);
      assert.equal(handlers.size, 0, `${signal}: the handlers go after`);
    }

    // The read-back compares the whole ruleset, not its include list:
    // a restore GitHub stores with every branch but another field
    // changed is an error naming the ruleset, and the file stays.
    {
      const t = quick(await ahead());
      const { api } = t.deps;

      t.deps.api = async (path, options = {}) => {
        const answer = await api(path, options);
        const include = options.body?.conditions?.ref_name?.include ?? [];

        if (options.method === "PUT" && include.includes("refs/heads/next")) {
          t.gh.set({ ...t.gh.state(), enforcement: "evaluate" });
        }

        return answer;
      };
      const r = await rebase(t);

      assert.ok(r.error, "a read-back that differs is an error");
      assert.match(r.error.message, /25361439/, "naming the ruleset");
      assert.ok(t.saved(), "the saved copy stays");
      assert.deepEqual(JSON.parse(t.saved()), guards(F.ruleset),
        "holding the whole ruleset as it was");
    }
  });

  it("box 2: it takes --dry-run, which prints the plan and changes "
    + "nothing", async () => {
    const t = quick(await ahead());
    const before = await refs(t.o);
    const local = await refs(t.w);
    const at = await t.w(["rev-parse", "HEAD"]);
    const dry = await rebase(t, { dryRun: true });

    ok(dry, "the dry run");
    assert.ok(dry.printed.length > 0, "it prints the plan");
    for (const word of ["next", "staging", "main", "25361439"]) {
      assert.ok(dry.text.includes(word), `the plan names ${word}`);
    }
    await nothingChanged(t, dry, before);
    assert.equal(t.saved(), null, "no saved copy is written");
    assert.deepEqual(await refs(t.w), local, "no local ref moves");
    assert.equal(await t.w(["rev-parse", "HEAD"]), at, "HEAD stays");
    assert.equal(await t.w(["status", "--porcelain"]), "",
      "the working tree stays clean");

    // Between the two runs, too.
    ok(await rebase(t), "the first run");
    const mid = await refs(t.o);
    const again = await rebase(t, { dryRun: true });

    ok(again, "the dry run of the second step");
    assert.ok(again.printed.length > 0, "it prints the plan");
    await nothingChanged(t, again, mid);
    assert.equal(t.saved(), null);

    // A misspelled --dry-run never runs for real: bin/nff refuses it
    // before it runs git or gh.
    const dir = mkdtempSync(join(tmpdir(), "rebase-criteria-"));
    const calls = join(dir, "calls.log");

    try {
      writeFileSync(calls, "");
      for (const tool of ["git", "gh"]) {
        writeFileSync(join(dir, tool),
          `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 1\n`);
        chmodSync(join(dir, tool), 0o755);
      }

      const r = spawnSync(process.execPath, [join(root, "bin/nff"),
        "rebase", "--dryrun"], {
        cwd: root, encoding: "utf8",
        env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin` },
      });

      assert.notEqual(r.status, 0, "bin/nff rebase --dryrun fails");
      assert.match(`${r.stdout}${r.stderr}`, /--dryrun/,
        "naming the flag it does not take");
      assert.equal(readFileSync(calls, "utf8"), "", "no git, no gh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("box 3: it refuses unless the working tree is clean and main is "
    + "ahead of staging, and names the lanes that must rebase", async () => {
    // A working tree with uncommitted changes.
    {
      const t = quick(await ahead());

      writeFileSync(join(t.work, "a.txt"), "changed in the checkout\n");
      const before = await refs(t.o);
      const r = await rebase(t);

      refused(r);
      assert.match(r.error.message, /uncommitted|working tree|clean/i);
      await nothingChanged(t, r, before);
      assert.equal(t.saved(), null);
    }

    // Main not ahead of staging: staging holds main.
    {
      const t = quick(await world());
      const before = await refs(t.o);
      const r = await rebase(t);

      refused(r);
      assert.match(r.error.message, /main/);
      await nothingChanged(t, r, before);
    }

    // Main at staging's commit.
    {
      const t = quick(await world({
        shape: async (s, c) => {
          await s(["push", "-q", "origin", `${c.S1}:refs/heads/main`]);
        },
      }));
      const before = await refs(t.o);
      const r = await rebase(t);

      refused(r);
      await nothingChanged(t, r, before);
    }

    // The lanes holding a commit of the old next that main lacks are
    // named, in the plan and when the rebase is done; a lane cut from
    // main is not.
    {
      const t = quick(await ahead());
      const dry = await rebase(t, { dryRun: true });

      ok(dry);
      assert.match(dry.text, /lane\/alpha/, "the plan names lane/alpha");
      assert.doesNotMatch(dry.text, /lane\/beta/,
        "and not lane/beta, cut from main");

      const { one, two } = await both(t);
      const text = `${one.text}\n${two.text}`;

      assert.match(text, /lane\/alpha/, "the run names lane/alpha");
      assert.doesNotMatch(text, /lane\/beta/, "and not lane/beta");
    }
  });

  it("box 4: staging takes the rebased commit only after its required "
    + "checks pass on next", async () => {
    const t = quick(await ahead());
    const { c } = t;

    t.ci = "none";
    ok(await rebase(t), "the first run");
    const rebuilt = await head(t.o, "next");

    assert.notEqual(rebuilt, c.N2, "next is forced to the rebuilt staging");
    assert.ok(await isAncestor(t.o, c.H, rebuilt), "which holds main");
    assert.equal(await head(t.o, "staging"), c.S1, "staging has not moved");

    // Nothing has run on next yet.
    let before = await refs(t.o);
    let r = await rebase(t);

    refused(r);
    for (const name of REQUIRED) {
      assert.ok(r.error.message.includes(name), `names ${name}`);
    }
    await nothingChanged(t, r, before);

    // The codeql check has not run.
    t.ci = "partial";
    before = await refs(t.o);
    r = await rebase(t);
    refused(r);
    assert.match(r.error.message, /codeql/);
    await nothingChanged(t, r, before);

    // All three green on next's commit.
    t.ci = "green";
    r = await rebase(t);
    ok(r, "the run once the checks are green");
    assert.equal(await head(t.o, "staging"), rebuilt,
      "staging takes exactly the commit whose checks passed on next");

    const read = r.events.findIndex((e) => e.kind === "checks"
      && e.sha === rebuilt);
    const moved = r.events.findIndex((e) => e.kind === "push"
      && pushTargets(e.args).some((x) => x.dst === "staging" && !x.delete));

    assert.ok(read >= 0, "the checks of that commit are read");
    assert.ok(read < moved, "before staging is pushed");
    assert.ok(t.pushes().some((p) => p.ref === "refs/heads/next"
      && p.now === rebuilt && p.old !== ZERO), "that commit was pushed to "
      + "next first");
  });

  it("box 5: every use is logged", async () => {
    await flush({ env: {} });

    // A dry run and a refusal log nothing.
    {
      const t = quick(await ahead());

      ok(await rebase(t, { dryRun: true }));
      assert.deepEqual(await shipped(), [], "a dry run logs nothing");

      const clean = quick(await world());

      refused(await rebase(clean));
      assert.deepEqual(await shipped(), [], "a refusal logs nothing");
    }

    // Each window is one line: who, the branch it forced, and that
    // branch's commit before and after, whole.
    {
      const t = quick(await ahead());
      const { c } = t;
      const { mid } = await both(t);
      const lines = await shipped();

      assert.equal(lines.length, 2, "one line per window");
      for (const l of lines) assert.equal(l.by, "cli");

      const [one, two] = lines;

      assert.equal(one.branch, "next", "the first window forces next");
      assert.equal(one.beforeId, c.N2, "from the old next");
      assert.equal(one.afterId, mid["refs/heads/next"],
        "to the rebuilt staging");
      assert.equal(two.branch, "staging", "the second forces staging");
      assert.equal(two.beforeId, c.S1, "from its old commit");
      assert.equal(two.afterId, await head(t.o, "staging"),
        "to the rebuilt staging");
    }

    // A window whose push fails was still opened, so it is logged.
    {
      const t = quick(await ahead());

      t.failPush = moves;
      assert.ok((await rebase(t)).error);
      assert.equal((await shipped()).length, 1,
        "a window whose push failed is logged");
    }
  });
});
