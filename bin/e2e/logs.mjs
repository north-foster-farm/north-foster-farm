#!/usr/bin/env node
// Staging's function and edge-function logs for one failed e2e run,
// pulled and summarized, so a failure is read from evidence before
// any code changes (#495, #507). It runs on the Mac only: it reads
// through `bin/nff netlify`, the Keychain token, and the raw lines
// stay under .ignored/ (the repository is public; never upload them).
//
//   node bin/e2e/logs.mjs <run-id> [--since ISO --until ISO]
//
// The Netlify CLI keeps 100 lines per function per call, so each
// function is pulled in two-minute slices, and a full slice is split
// again into 20-second ones. The summary lists each failed test with
// its time, every line that is not info or that names a slow or
// failed hand-off (function.slow, gate.next_slow, gate.next_failed),
// and every gap of 20 s or more in which no function logged.

import { execFileSync } from "node:child_process";
import {
  mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "north-foster-farm/north-foster-farm";
const STAGING = "https://staging--north-foster-farm.netlify.app";

export const CAP = 100;
export const SLICE_MS = 2 * 60_000;
export const SPLIT_MS = 20_000;
export const GAP_MS = 20_000;
const MARKED = /function\.slow|gate\.next_(slow|failed)|function\.crashed/;

// -> [[since, until], …] covering the window in steps of `ms`.
export const slices = (since, until, ms) => {
  const out = [];

  for (let t = Date.parse(since); t < Date.parse(until); t += ms) {
    out.push([new Date(t).toISOString(),
      new Date(Math.min(t + ms, Date.parse(until))).toISOString()]);
  }

  return out;
};

// The failed tests in a run's log: [{ at, title }]. Playwright's list
// reporter marks each with ✘, after the step's timestamp.
const FAILED =
  /(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+✘\s+\d+\s+(.*?)(?:\s+\([\d.]+m?s?\))?$/;

export const failuresIn = (runLog) => {
  const seen = new Map();

  for (const raw of String(runLog).split("\n")) {
    const m = FAILED.exec(raw);

    if (m && !seen.has(m[2])) seen.set(m[2], m[1]);
  }

  return [...seen].map(([title, at]) => ({ at, title }));
};

// -> the summary's lines, from the log rows and the failures.
export const summarize = (rows, failures, { capped = [] } = {}) => {
  const sorted = [...rows].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp));
  const out = [`${sorted.length} log lines.`];

  if (capped.length) {
    out.push(`Still capped at ${CAP} (lines may be missing): ${
      capped.join(", ")}`);
  }
  out.push("", "Failed tests:");
  for (const f of failures) out.push(`  ${f.at}  ${f.title}`);
  out.push("", "Errors, warnings and slow or failed hand-offs:");
  for (const r of sorted) {
    if (r.level === "info" && !MARKED.test(r.message)) continue;
    // A stack's own lines repeat the first; keep the head and cause.
    if (/^\s+at /.test(r.message)) continue;
    out.push(`  ${r.timestamp} ${r.source}/${r.name} ${r.level} ${
      r.message.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  out.push("", `Gaps of ${GAP_MS / 1000} s or more with no function line:`);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Date.parse(sorted[i].timestamp)
      - Date.parse(sorted[i - 1].timestamp);

    if (gap >= GAP_MS) {
      out.push(`  ${sorted[i - 1].timestamp} -> ${sorted[i].timestamp} ` +
        `(${Math.round(gap / 1000)} s)`);
    }
  }

  return out;
};

// The linked site, which a worktree lacks: NETLIFY_SITE_ID, else the
// checkout's own link (.netlify/state.json, written by `netlify link`).
const siteId = () => {
  if (process.env.NETLIFY_SITE_ID) return process.env.NETLIFY_SITE_ID;
  try {
    return JSON.parse(readFileSync(join(ROOT, ".netlify", "state.json"),
      "utf8")).siteId || null;
  } catch {
    return null;
  }
};

const run = (cmd, args) => execFileSync(cmd, args, {
  cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, ...(siteId() ? { NETLIFY_SITE_ID: siteId() } : {}) },
});

// One pull: -> the rows. `kind` is "function" or "edge-function".
const pull = (kind, name, since, until) => {
  const target = kind === "function"
    ? ["--function", name] : ["--source", "edge-functions",
      "--edge-function", name];
  const text = run(join(ROOT, "bin", "nff"), ["netlify", "logs", "--url",
    STAGING, ...target, "--since", since, "--until", until, "--json"]);

  return text.split("\n").filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
};

// Every line of one function in the window, split until under the cap.
const pullAll = (kind, name, since, until, capped) => {
  const rows = [];

  for (const [a, b] of slices(since, until, SLICE_MS)) {
    const got = pull(kind, name, a, b);

    if (got.length < CAP) {
      rows.push(...got);
      continue;
    }
    for (const [c, d] of slices(a, b, SPLIT_MS)) {
      const part = pull(kind, name, c, d);

      if (part.length >= CAP) capped.push(`${name} ${c}`);
      rows.push(...part);
    }
  }

  return rows;
};

const main = (argv) => {
  const id = argv[0];

  if (!/^\d+$/.test(id || "")) {
    console.error("Usage: node bin/e2e/logs.mjs <run-id> " +
      "[--since ISO --until ISO]");
    process.exit(2);
  }

  const flag = (name) => {
    const i = argv.indexOf(name);

    return i > 0 ? argv[i + 1] : null;
  };
  const meta = JSON.parse(run("gh", ["run", "view", id, "-R", REPO,
    "--json", "createdAt,updatedAt,headSha"]));
  const since = flag("--since") || meta.createdAt;
  const until = flag("--until") || meta.updatedAt;
  const failures = failuresIn(run("gh", ["run", "view", id, "-R", REPO,
    "--log"]));
  const functions = readdirSync(join(ROOT, "netlify", "functions"))
    .filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
  const capped = [];
  const rows = [];

  for (const name of functions) {
    rows.push(...pullAll("function", name, since, until, capped));
  }
  rows.push(...pullAll("edge-function", "gate", since, until, capped));

  const dir = join(ROOT, ".ignored", "e2e-logs");

  mkdirSync(dir, { recursive: true });

  const file = join(dir, `${id}.jsonl`);

  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  console.log(`Run ${id} on ${meta.headSha.slice(0, 8)}, ${since} to ` +
    `${until}. Raw lines: ${file}`);
  console.log(summarize(rows, failures, { capped }).join("\n"));
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
