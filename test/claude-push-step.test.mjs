// The "Push the lane branch" step of .github/workflows/claude.yml must
// never replace a lane with work it lacks (#552). Each case runs the
// step's real script against a scratch bare repo standing in for GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yml = readFileSync(".github/workflows/claude.yml", "utf8");
const marker = "- name: Push the lane branch";
const block = yml.slice(yml.indexOf(marker));
const body = block.slice(block.indexOf("        run: |\n") + 16);
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
  g("config", `url.${bare}.insteadOf`, "https://github.com/o/r");
  g("remote", "add", "origin", bare);
  const commit = (file, text) => {
    writeFileSync(join(work, file), text);
    g("add", file);
    g("commit", "-qm", file);
  };
  commit("base", "0");
  g("push", "-q", "origin", "next");
  g("fetch", "-q", "origin");
  const stepFile = join(dir, "step.sh");
  writeFileSync(stepFile, script);
  const run = () =>
    spawnSync("bash", [stepFile], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, ISSUE: "7", REPO: "o/r", GH_TOKEN: "x" },
    });
  const lane = () => {
    try {
      return sh(bare, "rev-parse", "refs/heads/lane/cloud-7");
    } catch {
      return null;
    }
  };
  return { g, commit, run, lane };
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
