import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALSO_ACCEPTED, SHELLS, completionScript, parseUsage,
} from "../bin/completion.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nff = (...args) => spawnSync(process.execPath,
  [join(root, "bin/nff"), ...args],
  { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
const have = (shell) => !spawnSync(shell, ["-c", "true"]).error;

// The CLI's own usage, as it prints it.
const USAGE = (() => {
  const run = nff();

  return `${run.stdout}${run.stderr}`;
})();

// A small usage in the real layout: a flag line at 8 and at 29 spaces,
// a description at 38 that names a flag and must be ignored.
const SMALL = [
  "Usage:",
  "  --yes skips the typed confirmation.",
  "  bin/nff orders list [--open] [--status=paid]",
  "  bin/nff orders cancel <id> --reason <why> |",
  "                             --no-reason [--no-refund]",
  "                                      the money back; --not-a-flag is",
  "                                      prose and is ignored",
  "  bin/nff audience import <csv> [--date=YYYY-MM-DD]",
  "        [--dry-run]",
  "  bin/nff address approve|deny <email>",
  "  bin/nff --production export [--out <file>]",
  "  bin/nff errors show <file|-> [--sha <commit>]",
  "  bin/nff supply waivers [--file <waivers.json>]",
  "  bin/nff news mail <post> [--out <dir>]",
  "  bin/nff events                      every series",
  "  bin/nff events new                  a code",
  "  bin/nff promote staging|main [release/<name>] [--dry-run]",
  "",
].join("\n");

describe("parsing the usage text", () => {
  const model = parseUsage(SMALL);

  it("builds the tree of groups, actions and alternatives", () => {
    assert.deepEqual(model.children.get(""),
      ["address", "audience", "errors", "events", "export", "news", "orders",
        "promote", "supply"]);
    assert.deepEqual(model.children.get("orders"), ["cancel", "list"]);
    assert.deepEqual(model.children.get("address"), ["approve", "deny"]);
    assert.deepEqual(model.children.get("promote"), ["main", "staging"]);
    assert.deepEqual(model.children.get("events"), ["new"],
      "a command that is also a group");
    assert.ok(model.flags.has("events") === false);
  });

  it("takes each command's flags, from its line and the lines "
    + "continuing it, and none from a description", () => {
    assert.deepEqual(model.flags.get("orders list"), ["--open", "--status="]);
    assert.deepEqual(model.flags.get("orders cancel"),
      ["--no-reason", "--no-refund", "--reason"]);
    assert.deepEqual(model.flags.get("audience import"),
      ["--date=", "--dry-run"]);
    assert.deepEqual(model.flags.get("promote main"), ["--dry-run"]);
    assert.ok(!JSON.stringify([...model.flags]).includes("--not-a-flag"));
  });

  it("skips a context flag before the command, and keeps it as a flag",
    () => {
      assert.deepEqual(model.children.get(""), model.children.get("")
        .filter((w) => w !== "--production"));
      assert.deepEqual(model.flags.get("export"), ["--out", "--production"]);
    });

  it("marks the commands whose argument is a file, and the flags that "
    + "take one", () => {
    assert.deepEqual([...model.files].sort(),
      ["audience import", "errors show"]);
    assert.deepEqual(model.fileFlags, ["--file", "--out"]);
  });
});

describe("the completion scripts", () => {
  it("name each shell, refuse another, and say nothing else", () => {
    for (const shell of SHELLS) {
      const text = completionScript(shell, SMALL, { contexts: ["staging"] });

      assert.match(text, new RegExp(`\\(${shell}\\)`));
      assert.match(text, /_nff_children\(\) \{/);
      assert.match(text, /printf '%s\\n' --staging --yes --no-email --scratch/);
      assert.equal(text, completionScript(shell, SMALL,
        { contexts: ["staging"] }), "the same text each time");
    }
    assert.throws(() => completionScript("fish", SMALL),
      /Which shell\? bin\/nff completion zsh\|bash/);
    assert.ok(ALSO_ACCEPTED.includes("--yes"));
  });

  it("print from bin/nff on stdout alone, so sourcing one in a profile "
    + "shows nothing", () => {
    for (const shell of SHELLS) {
      const run = nff("completion", shell);

      assert.equal(run.status, 0);
      assert.equal(run.stderr, "", "no startup message on stderr");
      assert.match(run.stdout, /^# Tab completion for bin\/nff/);
    }

    const bad = nff("completion", "fish");

    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Which shell\? bin\/nff completion zsh\|bash/);
  });

  // The CLI's own usage, read the plain way: each `bin/nff` line's
  // leading words, whatever follows. Not the parser's own logic.
  const commandPaths = () => {
    const paths = [];

    for (const m of USAGE.matchAll(/^ {2}bin\/nff (?:--\S+ )*(.*)$/gm)) {
      const left = m[1].split(/\s{2,}/)[0];
      const words = left.match(/^[a-z][a-z|-]*(?: [a-z][a-z|-]*)*/);

      if (!words) continue;

      const expand = (parts) => parts.reduce((all, part) => all.flatMap(
        (path) => part.split("|").map((w) => [...path, w])), [[]]);

      paths.push(...expand(words[0].split(" ")));
    }

    return paths;
  };
  const headFlags = () => [...USAGE.matchAll(/^ {2}bin\/nff (.*)$/gm)]
    .map((m) => {
      const left = m[1].split(/\s{2,}/)[0];
      const words = left.match(/^(?:--\S+ )*[a-z][a-z|-]*(?: [a-z][a-z|-]*)*/);

      return {
        words: (words ? words[0] : "").replace(/^(?:--\S+ )+/, ""),
        flags: [...left.matchAll(/--[a-z][a-z0-9-]*/g)].map((f) => f[0]),
      };
    });

  // A shell script run under bash or zsh: every command's path must be
  // reachable word by word, and every flag on its usage line offered.
  const checker = (paths, heads) => [
    "fail=0",
    ...paths.map((p) => `
      node=""; ok=1
      for w in ${p.join(" ")}; do
        if _nff_has "$node" "$w"; then node="\${node:+$node }$w"
        else ok=0; fi
      done
      (( ok )) || { print_fail "${p.join(" ")}"; }`),
    ...heads.filter((h) => h.words && h.flags.length).map((h) => {
      // Any alternative reaches the same flags: take the first.
      const node = h.words.split(" ").map((w) => w.split("|")[0]).join(" ");

      return h.flags.map((f) => `
      own="$(_nff_flags "${node}" | tr '\\n' ' ')"
      all="$(_nff_globals | tr '\\n' ' ')"
      offered=" $own $all "
      case "$offered" in
        *" ${f} "*|*" ${f}= "*) ;;
        *) print_fail "flag ${f} of ${node}";; esac`).join("");
    }),
    "exit $fail",
  ].join("\n");

  for (const shell of SHELLS) {
    it(`under ${shell}, reach every command in the usage and offer its `
      + "flags", { skip: !have(shell) }, () => {
      const dir = mkdtempSync(join(tmpdir(), "nff-completion-"));

      try {
        const script = join(dir, `nff.${shell}`);
        const run = join(dir, "check.sh");
        const body = nff("completion", shell).stdout;

        writeFileSync(script, body);
        writeFileSync(run, [
          shell === "zsh" ? "compdef() { :; }" : "",
          "print_fail() { echo \"MISSING: $1\"; fail=1; }",
          `source ${script}`,
          checker(commandPaths(), headFlags()),
        ].join("\n"));

        const out = spawnSync(shell, shell === "zsh" ? ["-f", run] : [run],
          { encoding: "utf8" });

        assert.equal(out.stdout, "", out.stdout + out.stderr);
        assert.equal(out.status, 0, out.stderr);
        assert.ok(commandPaths().length > 60, "the usage was read");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`passes ${shell}'s own syntax check`, { skip: !have(shell) }, () => {
      const dir = mkdtempSync(join(tmpdir(), "nff-completion-"));

      try {
        const script = join(dir, "nff");

        writeFileSync(script, nff("completion", shell).stdout);

        const out = spawnSync(shell, ["-n", script], { encoding: "utf8" });

        assert.equal(out.status, 0, out.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("completes as a person would, under bash", { skip: !have("bash") },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "nff-completion-"));

      try {
        const script = join(dir, "nff.bash");
        const run = join(dir, "try.sh");

        const here = join(dir, "here");

        mkdirSync(here);
        writeFileSync(script, nff("completion", "bash").stdout);
        writeFileSync(join(here, "list.csv"), "");
        writeFileSync(join(here, "waivers.json"), "");
        writeFileSync(run, [
          `source ${script}`,
          "try() { COMP_WORDS=(\"$@\"); COMP_CWORD=$(( $# - 1 ));",
          "  _nff_complete; echo \"${COMPREPLY[*]}\"; }",
          "try bin/nff orders ca",
          "try bin/nff audience import ''",
          "try bin/nff audience import x.csv --sk",
          "try bin/nff supply waivers --file ''",
          "try bin/nff orders show NFF-1 ''",
          "try bin/nff env filled --dev",
          "try bin/nff env filled --",
        ].join("\n"));

        const out = spawnSync("bash", [run], { cwd: here, encoding: "utf8" });
        const lines = out.stdout.split("\n");

        assert.equal(out.status, 0, out.stderr);
        assert.equal(lines[0], "cancel");
        assert.equal(lines[1], "list.csv waivers.json", "a CSV is a file");
        assert.equal(lines[2], "--skip --skip-welcome");
        assert.equal(lines[3], "list.csv waivers.json", "--file is a file");
        assert.equal(lines[4], "", "nothing after a positional argument");
        assert.equal(lines[5], "--development");
        const offered = lines[6].split(" ");

        assert.equal(new Set(offered).size, offered.length, "no flag twice");
        for (const flag of ["--development", "--staging", "--production",
          "--yes", "--no-email", "--scratch"]) {
          assert.ok(offered.includes(flag), `${flag} is offered`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
});
