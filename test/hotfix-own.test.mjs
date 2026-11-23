// The implementer's own tests of round 3 of bin/hotfix.mjs (the
// security review of #631, 2026-11-18): what the review left to the
// implementer, beside the criteria tests in test/hotfix.test.mjs and
// test/hotfix-round3.test.mjs, which they never replace. They use the
// criteria tests' harness, test/hotfix-world.mjs, unchanged.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BACKOFF, RULESET_PATH, SIGNALS, realDeps,
} from "../bin/hotfix.mjs";
import {
  F, PLAIN, ZERO, changedRefs, guards, head, land, ok, pushTargets, refs,
  run, world,
} from "./hotfix-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// No waits, each one noted.
const noWaits = (t) => {
  t.waits = [];
  t.deps.sleep = async (ms) => {
    t.waits.push(ms);
  };

  return t;
};

const moves = (args) => args[0] === "push" && pushTargets(args)
  .some((x) => !x.delete && ["next", "staging"].includes(x.dst));

describe("bin/hotfix.mjs, round 3: the implementer's own", () => {
  it("tries the restore three times, waiting between, then prints a "
    + "recovery command that runs against the saved copy", async () => {
    const t = noWaits(await world());

    t.gh.failRestore = true;
    const r = await run(t, "start");
    const restores = t.gh.calls.filter((c) => c.method === "PUT"
      && c.body.conditions.ref_name.include.includes("refs/heads/next"));

    assert.equal(restores.length, 3, "three tries");
    assert.deepEqual(t.waits, BACKOFF, "with the backoff between them");

    const command = r.error.message
      .match(/`gh api -X PUT (\S+) --input ([^`]+)`/);

    assert.ok(command, "prints a gh api command");
    assert.equal(command[1], RULESET_PATH);
    assert.equal(command[2], t.leftover, "whose --input is the saved file");
    assert.deepEqual(JSON.parse(readFileSync(command[2], "utf8")),
      guards(F.ruleset), "which holds the restoring PUT's body");
  });

  it("restores the ruleset and exits on SIGINT, SIGTERM and SIGHUP inside "
    + "the window", async () => {
    for (const [signal, code] of Object.entries(SIGNALS)) {
      const t = noWaits(await world());
      const handlers = new Map();
      let exited;
      let exit;
      const done = new Promise((resolve) => {
        exit = resolve;
      });
      const git = t.deps.git;

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
          ["refs/heads/main"], "the window is open");
        handlers.get(signal)();
        await done;
        throw new Error("killed");
      };

      await run(t, "start");
      assert.equal(exited, code, `${signal} exits ${code}`);
      assert.deepEqual(guards(t.gh.state()), guards(F.ruleset),
        `${signal} restores the ruleset`);
      assert.equal(t.saved(), null, "and deletes the saved copy");
      assert.equal(handlers.size, 0, "the handlers go with the window");
    }
  });

  it("passes git's errors through printable()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotfix-own-"));

    try {
      spawnSync("git", ["init", "-q", dir]);
      await assert.rejects(realDeps.git(["-C", dir, "show",
        "\x1b]8;;evil\x07\x1b[31mzz‮"]), (error) => {
        // What it must not hold.
        // eslint-disable-next-line no-control-regex -- #791 c7105461370
        assert.ok(!/[\x00-\x1f\x7f-\x9f‪-‮]/.test(error.message),
          error.message);
        assert.match(error.message, /zz/, "and still says what git said");

        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("when the rebuilt staging is main, step 1 pushes only "
    + "hotfix/rebuilt, step 2 leaves staging at main, and a rerun after "
    + "a failed delete only deletes", async () => {
    const t = noWaits(await world());

    ok(await run(t, "start"));
    // The hotfix is a copy of staging's own commit, so the rebuilt
    // staging is main.
    await land(t, {}, "Hotfix c", { pick: t.c.S1 });
    const main = await head(t.o, "main");
    const written = t.gh.writes().length;
    const one = await run(t, "finish");

    ok(one);
    assert.equal(t.gh.writes().length, written,
      "no window, no ruleset write");
    let now = await refs(t.o);

    assert.equal(now["refs/heads/next"], main, "next stays at main");
    assert.ok(now["refs/heads/hotfix/rebuilt"]);

    t.failPush = (args) => pushTargets(args).some((x) => x.delete);
    assert.ok((await run(t, "finish")).error, "the delete fails");
    t.failPush = () => false;
    const mid = await refs(t.o);

    assert.equal(mid["refs/heads/staging"], main, "staging stays at main");
    assert.equal(mid["refs/heads/next"], mid["refs/heads/hotfix/rebuilt"]);

    const again = await run(t, "finish");

    ok(again);
    now = await refs(t.o);
    assert.deepEqual(changedRefs(mid, now), [
      "refs/heads/hotfix/next", "refs/heads/hotfix/rebuilt",
      "refs/heads/hotfix/staging",
    ], "only the hotfix branches go");
    assert.ok(again.pushes.every((p) => p.now === ZERO));
  });

  it("when the rebuilt next is the rebuilt staging, step 2 still moves "
    + "staging to it", async () => {
    // At start, next and staging are the same commit.
    const t = noWaits(await world({
      shape: async (s, c) => {
        await s(["push", "-q", "-f", "origin", `${c.S1}:refs/heads/next`]);
      },
    }));

    ok(await run(t, "start"));
    await land(t, ...PLAIN);
    ok(await run(t, "finish"));
    const mid = await refs(t.o);

    assert.equal(mid["refs/heads/next"], mid["refs/heads/hotfix/rebuilt"]);
    assert.notEqual(mid["refs/heads/next"], mid["refs/heads/main"]);
    ok(await run(t, "finish"));
    assert.equal(await head(t.o, "staging"), mid["refs/heads/next"],
      "staging takes the rebuilt staging");
  });

  it("start deletes the placeholders when the window refuses before it "
    + "pushes", async () => {
    const t = noWaits(await world());
    const before = await refs(t.o);
    const api = t.deps.api;
    let reads = 0;

    // Whole at the first check, narrowed by someone else at the window's.
    t.deps.api = async (path, options = {}) => {
      if ((options.method ?? "GET") === "GET") {
        reads += 1;
        if (reads === 2) {
          const r = structuredClone(F.ruleset);

          r.conditions.ref_name.include = ["refs/heads/main"];

          return r;
        }
      }

      return api(path, options);
    };
    const r = await run(t, "start");

    assert.match(r.error?.message ?? "", /^Refused:.*25361439/);
    assert.deepEqual(await refs(t.o), before, "the placeholders are gone");
    assert.deepEqual(t.gh.writes(), []);
  });

  it("bin/nff refuses a hotfix flag it does not take before it runs git "
    + "or gh", () => {
    const dir = mkdtempSync(join(tmpdir(), "hotfix-own-"));
    const log = join(dir, "calls.log");

    try {
      writeFileSync(log, "");
      for (const tool of ["git", "gh"]) {
        writeFileSync(join(dir, tool),
          `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`);
        chmodSync(join(dir, tool), 0o755);
      }

      const r = spawnSync(process.execPath, [join(root, "bin/nff"),
        "hotfix", "finish", "--dryrun"], {
        cwd: root, encoding: "utf8",
        env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin` },
      });

      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /--dryrun/);
      assert.equal(readFileSync(log, "utf8"), "", "no git, no gh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
