// Fails when a tracked file names the drop site's old venue (#541).
// The farm's drop site is a bare street address in North Scituate; the
// venue's name is no longer a place on the map, so no page, email,
// function, data file, doc or test may say it.
//
// test/fixtures/square/ holds responses recorded from Square, which
// are never hand-edited; the files there are re-recorded
// (bin/fixtures/record), and the check covers them once they are.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OLD = new RegExp(["Village", "Green"].join("\\s+"), "gi");
const SKIP = [
  /^test\/fixtures\/square\//, /\.(png|jpe?g|webp|avif|ico|pdf|woff2?)$/i,
];

// -> ["path:line: text", ...], one per hit in a tracked file.
export const findOldPlace = (root = ".") => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString().split("\0").filter(Boolean)
    .filter((f) => !SKIP.some((re) => re.test(f)));
  const hits = [];

  for (const f of files) {
    let text;

    try {
      text = readFileSync(`${root}/${f}`, "utf8");
    } catch {
      continue;
    }
    // The whole file at once, so a phrase wrapped across two lines
    // and one with two spaces both count.
    for (const m of text.matchAll(OLD)) {
      const line = text.slice(0, m.index).split("\n").length;

      hits.push(`${f}:${line}: ${m[0].replace(/\s+/g, " ")}`);
    }
  }

  return hits;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = findOldPlace();

  if (hits.length) {
    console.error(`The drop site's old venue name is still in:\n${
      hits.join("\n")}`);
    process.exit(1);
  }
}
