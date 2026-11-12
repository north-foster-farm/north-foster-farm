// The "Push the lane branch" step of .github/workflows/claude.yml must
// never replace a lane with work it lacks (#552). Each case runs the
// step's real script against a scratch bare repo standing in for GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yml = readFileSync(".github/workflows/claude.yml", "utf8");
const marker = "- name: Push the lane branch";
const block = yml.slice(yml.indexOf(marker));
const run = block.slice(block.indexOf("        run: |\n") + 16);
const body = run.slice(0, run.indexOf("\n\n"));
assert.ok(body.trimEnd().endsWith('"refs/lane/run:refs/heads/$branch"'));
const script = body
  .split("\n")
  .map((l) => l.replace(/^ {10}/, ""))
  .join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "push-step-"));
  const bare = join(dir, "gh.git");
  const work = join(dir, "w");
  const sh = (cwd, ...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "next", work]);
  const g = (...a) => sh(work, ...a);
  g("config", "user.email", "a@b");
  g("config", "user.name", "a");
  g("remote", "add", "origin", bare);
  const commit = (file, text, msg = file, date = "") => {
    writeFileSync(join(work, file), text);
    g("add", file);
    g("commit", "-qm", msg, ...(date ? ["--date", date] : []));
  };
  commit("base", "0");
  g("push", "-q", "origin", "next");
  g("fetch", "-q", "origin");
  const stepFile = join(dir, "step.sh");
  const urlLine = 'url="https://github.com/$REPO"';
  assert.ok(script.includes(urlLine));
  writeFileSync(stepFile, script.replace(urlLine, `url="${bare}"`));
  const run = (extra = {}) =>
    spawnSync("bash", [stepFile], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE: "7",
        REPO: "o/r",
        GH_TOKEN: "x",
        RUNNER_TEMP: dir,
        ...extra,
      },
    });
  const lane = () => {
    try {
      return sh(bare, "rev-parse", "refs/heads/lane/cloud-7");
    } catch {
      return null;
    }
  };
  const bundle = join(dir, "lane-bundles", "lane-work.bundle");
  const replaced = join(dir, "lane-bundles", "lane-replaced.bundle");
  return { g, commit, run, lane, bundle, replaced, work, dir };
}

test("a review run on next leaves the lane alone", () => {
  const { g, commit, run, lane } = setup();
  g("checkout", "-q", "-b", "work");
  commit("a", "1");
  g("push", "-q", "origin", "work:lane/cloud-7");
  const before = lane();
  g("checkout", "-q", "--detach", "origin/next");
  assert.equal(run().status, 0);
  assert.equal(lane(), before);
});

test("a new lane is pushed, then extended", () => {
  const { g, commit, run, lane } = setup();
  g("checkout", "-q", "-b", "work");
  commit("a", "1");
  assert.equal(run().status, 0);
  assert.equal(lane(), g("rev-parse", "HEAD"));
  commit("b", "2");
  assert.equal(run().status, 0);
  assert.equal(lane(), g("rev-parse", "HEAD"));
});

test("a lane rebased onto a moved next, with new work, is pushed", () => {
  const { g, commit, run, lane } = setup();
  g("checkout", "-q", "-b", "work");
  commit("a", "1");
  assert.equal(run().status, 0);
  g("checkout", "-q", "next");
  commit("n", "moved");
  g("push", "-q", "origin", "next");
  g("fetch", "-q", "origin");
  g("checkout", "-q", "work");
  g("rebase", "-q", "origin/next");
  commit("b", "2");
  assert.equal(run().status, 0);
  assert.equal(lane(), g("rev-parse", "HEAD"));
});

test("a run that would drop lane commits fails and pushes nothing", () => {
  const { g, commit, run, lane } = setup();
  g("checkout", "-q", "-b", "work");
  commit("a", "1");
  assert.equal(run().status, 0);
  const before = lane();
  g("checkout", "-q", "--detach", "origin/next");
  commit("other", "x");
  assert.notEqual(run().status, 0);
  assert.equal(lane(), before);
});

// The reviewer's table (#552): each case adds work to a lane that
// already exists, in a way git cherry's patch-id calls a different change.
const ten = Array.from({ length: 10 }, (_, i) => `line${ i }\n`).join("");

function laneWithFile() {
  const c = setup();
  c.commit("f", ten);
  c.g("push", "-q", "origin", "next");
  c.g("fetch", "-q", "origin");
  c.g("checkout", "-q", "-b", "work");
  writeFileSync(join(c.work, "f"), ten.replace("line5", "LANE"));
  c.g("commit", "-qam", "lane change");
  assert.equal(c.run().status, 0);
  return c;
}

function moveNext(c, edit) {
  c.g("checkout", "-q", "next");
  writeFileSync(join(c.work, "f"), edit(ten));
  c.g("commit", "-qam", "next edit");
  c.g("push", "-q", "origin", "next");
  c.g("fetch", "-q", "origin");
  c.g("checkout", "-q", "work");
}

test("a rebase onto a next that edited a nearby line is pushed", () => {
  const c = laneWithFile();
  moveNext(c, (t) => t.replace("line3", "NEAR"));
  c.g("rebase", "-q", "origin/next");
  c.commit("b", "2");
  assert.equal(c.run().status, 0);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
});

test("a rebase with a resolved conflict is pushed", () => {
  const c = laneWithFile();
  moveNext(c, (t) => t.replace("line5", "THEIRS"));
  assert.throws(() => c.g("rebase", "-q", "origin/next"));
  writeFileSync(join(c.work, "f"), ten.replace("line5", "BOTH"));
  c.g("add", "f");
  execFileSync("git", ["rebase", "--continue"], {
    cwd: c.work,
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  c.commit("b", "2");
  assert.equal(c.run().status, 0);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
});

test("an amended lane commit, with new content, is pushed", () => {
  const c = laneWithFile();
  const before = c.lane();
  writeFileSync(join(c.work, "f"), ten.replace("line5", "AMENDED"));
  c.g("commit", "-q", "--amend", "-a", "-m", "lane change");
  c.commit("b", "2");
  assert.equal(c.run().status, 0);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
  const heads = execFileSync("git", ["bundle", "list-heads", c.replaced], {
    encoding: "utf8",
  });
  assert.ok(heads.includes(before), "the bundle holds the old lane tip");
});

test("a two-commit lane squash-landed on next, plus new work", () => {
  const c = laneWithFile();
  c.commit("g", "second");
  assert.equal(c.run().status, 0);
  c.g("checkout", "-q", "next");
  c.g("merge", "-q", "--squash", "work");
  c.g("commit", "-qm", "Squashed lane");
  c.g("push", "-q", "origin", "next");
  c.g("fetch", "-q", "origin");
  c.g("checkout", "-q", "-b", "again", "origin/next");
  c.commit("b", "2");
  assert.equal(c.run().status, 0);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
});

test("a next that conflicts with the lane, plus new work, is refused", () => {
  const c = laneWithFile();
  const before = c.lane();
  moveNext(c, (t) => t.replace("line5", "THEIRS"));
  c.g("checkout", "-q", "-b", "other", "origin/next");
  c.commit("b", "2");
  assert.notEqual(c.run().status, 0);
  assert.equal(c.lane(), before);
  assert.ok(existsSync(c.bundle));
});

test("a reused subject by another author date is refused", () => {
  const c = laneWithFile();
  const before = c.lane();
  c.g("checkout", "-q", "-b", "other", "origin/next");
  c.commit("x", "1", "lane change", "2001-01-01T00:00:00Z");
  assert.notEqual(c.run().status, 0);
  assert.equal(c.lane(), before);
  assert.ok(existsSync(c.bundle));
});

test("one run commit stands for one lane commit, not two", () => {
  const c = setup();
  c.g("checkout", "-q", "-b", "work");
  c.commit("a", "1", "wip", "2001-01-01T00:00:00Z");
  c.commit("b", "2", "wip", "2001-01-01T00:00:00Z");
  assert.equal(c.run().status, 0);
  const before = c.lane();
  c.g("checkout", "-q", "-b", "other", "origin/next");
  c.commit("z", "9", "wip", "2001-01-01T00:00:00Z");
  c.commit("n", "3", "new");
  assert.notEqual(c.run().status, 0);
  assert.equal(c.lane(), before);
});

test("a file the run planted is never in the uploaded directory", () => {
  const c = setup();
  c.g("checkout", "-q", "-b", "work");
  c.commit("a", "1");
  const planted = join(tmpdir(), "x");
  mkdirSync(join(c.dir, "lane-bundles"));
  writeFileSync(join(c.dir, "lane-bundles", "lane-work.bundle"), planted);
  assert.equal(c.run().status, 0);
  assert.equal(existsSync(c.bundle), false);
});

test("a follow-up from next that ignored the lane is refused, kept", () => {
  const c = laneWithFile();
  const before = c.lane();
  c.g("checkout", "-q", "-b", "fresh", "origin/next");
  c.commit("b", "2");
  assert.notEqual(c.run().status, 0);
  assert.equal(c.lane(), before);
  assert.ok(existsSync(c.bundle));
  const refs = execFileSync("git", ["bundle", "list-heads", c.bundle], {
    encoding: "utf8",
  });
  assert.match(refs, /refs\/lane\/run/);
});

test("a follow-up on top of the lane is a fast-forward", () => {
  const c = laneWithFile();
  c.g("fetch", "-q", "origin");
  c.g("checkout", "-q", "-B", "next2", "origin/lane/cloud-7");
  c.commit("b", "2");
  assert.equal(c.run().status, 0);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
});

test("a run that moves origin/next to the lane tip gets no way past", () => {
  const c = laneWithFile();
  const before = c.lane();
  c.g("checkout", "-q", "-b", "other", "origin/next");
  c.commit("b", "2");
  c.g("update-ref", "refs/remotes/origin/next", before);
  assert.notEqual(c.run().status, 0);
  assert.equal(c.lane(), before);
});

test("a hostile config in the workspace's .git never runs", () => {
  const c = laneWithFile();
  const marker = join(c.dir, "ran");
  c.commit("b", "2");
  writeFileSync(
    join(c.work, ".git", "config"),
    `${readFileSync(join(c.work, ".git", "config"), "utf8")
    }[merge "x"]\n\tdriver = touch ${marker}\n` +
      `[core]\n\tfsmonitor = touch ${marker}\n` +
      `[url "https://evil.invalid/"]\n\tinsteadOf = https://github.com/\n`,
  );
  assert.equal(c.run().status, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
});

test("a hostile user config in the environment never runs", () => {
  const c = laneWithFile();
  const marker = join(c.dir, "ran-global");
  const global = join(c.dir, "hostile-gitconfig");
  writeFileSync(
    global,
    `[url "https://evil.invalid/"]\n\tinsteadOf = ${c.dir}\n` +
      `[merge "x"]\n\tdriver = touch ${marker}\n` +
      `[core]\n\tfsmonitor = touch ${marker}\n`,
  );
  c.commit("b", "2");
  const r = c.run({
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: `touch ${marker}`,
    GIT_CONFIG_PARAMETERS: `'core.fsmonitor=touch ${marker}'`,
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
});

test("a hostile template directory never runs and leaves no url key", () => {
  const c = laneWithFile();
  const marker = join(c.dir, "ran-hook");
  const tpl = join(c.dir, "tpl");
  mkdirSync(join(tpl, "hooks"), { recursive: true });
  writeFileSync(
    join(tpl, "config"),
    `[url "https://evil.invalid/"]\n\tinsteadOf = ${c.dir}\n`,
  );
  const hook = join(tpl, "hooks", "reference-transaction");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const global = join(c.dir, "hostile-gitconfig");
  writeFileSync(global, `[init]\n\ttemplateDir = ${tpl}\n`);
  c.commit("b", "2");
  const r = c.run({ GIT_CONFIG_GLOBAL: global, GIT_TEMPLATE_DIR: tpl });
  assert.equal(r.status, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(c.lane(), c.g("rev-parse", "HEAD"));
  const cfg = readFileSync(join(c.dir, "push.git", "config"), "utf8");
  assert.doesNotMatch(cfg, /url\./);
});
