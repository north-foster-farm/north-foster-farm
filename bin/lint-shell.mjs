#!/usr/bin/env node
// ShellCheck over every tracked shell script (#782, step 4), inside
// `npm run lint`, so the commit hook and CI's lint-and-test run it. A
// shell script is a tracked `.sh` or `.bash` file, or one with no
// extension whose first line runs sh, bash or dash. Any finding fails
// the run, a note included. ShellCheck comes from PATH: Homebrew's on
// the Mac, the one GitHub's runners ship with in CI.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHEBANG = /^#!.*\b(sh|bash|dash)\b/;

// -> the shell scripts among `files`, read through `firstLine(file)`.
export const shellScripts = (files, firstLine) => files.filter((f) =>
  /\.(sh|bash)$/.test(f) || (!extname(f) && SHEBANG.test(firstLine(f))));

const main = () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    "cwd": root, "encoding": "utf8",
  }).split("\0").filter((f) => f && existsSync(join(root, f)));
  const firstLine = (f) => (statSync(join(root, f)).isFile()
    ? readFileSync(join(root, f), "utf8").split("\n", 1)[0] : "");
  const scripts = shellScripts(tracked, firstLine);
  // "--" first, so no file name can read as an option.
  const run = spawnSync("shellcheck", ["--", ...scripts], {
    "cwd": root, "stdio": "inherit",
  });

  if (run.error) {
    console.error(`ShellCheck did not run (${run.error.code}). Install ` +
      "it (brew install shellcheck) and run npm run lint again.");
    process.exit(1);
  }
  if (run.status === 0) {
    console.log(`ShellCheck: ${scripts.length} shell scripts, no findings.`);
  }
  process.exit(run.status ?? 1);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
