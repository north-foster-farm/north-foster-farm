// The e2e command (bin/nff e2e, #610): work out what a branch changed,
// choose the e2e specs and pages from e2e/dispatch.json, dispatch
// e2e.yml with them, wait for the run and print only what failed.
//
// The table: { shared: [glob], entries: [{ paths, specs, pages }] },
// globs as node:path's matchesGlob reads them. A changed path that
// matches a shared glob, or no glob at all, selects every spec the
// table names; otherwise a path selects the specs and pages of every
// entry it matches. The tests (test/e2e-dispatch.test.mjs) fix the
// contract of choose() and e2eCommand().
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { promisify } from "node:util";

import { REPO } from "../promote.mjs";

const execute = promisify(execFile);

export const USAGE = `
  bin/nff e2e [e2e/<spec> ...] [/<page>/ ...] [--all] [--dry-run]
              [--base=<ref>] [--help | -h]
                                      run in GitHub Actions the e2e specs
                                      this branch's changes against
                                      origin/next (or --base) reach, as
                                      e2e/dispatch.json maps them; wait,
                                      then print each failing test's
                                      file, name, page and project and
                                      the run's link. Specs or pages
                                      named skip the table; --all takes
                                      every spec it names. The branch
                                      must be pushed. --dry-run prints
                                      the choice and dispatches nothing.
                                      Exits 0 passed, 1 failed, 2
                                      nothing dispatched, 3 no verdict
                                      (GitHub did not answer, or the run
                                      outlasted the wait). --help or -h
                                      prints this and dispatches
                                      nothing; any other flag, bin/nff's
                                      own --staging and --no-email
                                      among them, is refused`
  .slice(1);

export const BASE = "origin/next";
export const WORKFLOW = "e2e.yml";
// The bullpen's rules (common.md): one look at a run every 3 minutes
// at most, since every lane shares one API rate limit.
export const LOOK_EVERY_MS = 3 * 60 * 1000;
export const GIVE_UP_MS = 4 * 60 * 60 * 1000;
// The most looks at a run in a row that may fail (a 404, or gh failing
// any other way) before the command gives up on a verdict (#623). A
// look that answers resets the count.
export const LOOK_TRIES = 3;
// The exit codes: the run passed, failed; nothing was dispatched; the
// run was dispatched but how it ended is unknown.
export const PASSED = 0;
export const FAILED = 1;
export const NOT_DISPATCHED = 2;
export const NO_VERDICT = 3;
// The workflow refuses named specs on these: the run would cancel theirs.
const PROMOTED = new Set(["next", "staging", "main"]);
// The run's jobs that only gather the others' results.
const GATES = new Set(["e2e", "e2e-named", "e2e-burn-in-advisory",
  "e2e-burn-in-named"]);

const unique = (list) => [...new Set(list)].sort();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const flagOn = (value) => !!value && value !== "false";

const tableSpecs = (table) => unique(table.entries.flatMap((e) => e.specs));
const tablePages = (table) => unique(table.entries
  .flatMap((e) => e.pages || []));

// The choice for these changed paths: pure, no I/O.
export const choose = (paths, table) => {
  const reasons = paths.map((path) => {
    if (table.shared.some((glob) => matchesGlob(path, glob))) {
      return { path, why: "shared" };
    }
    const hit = table.entries
      .filter((e) => e.paths.some((glob) => matchesGlob(path, glob)));

    if (!hit.length) return { path, why: "unknown" };

    return {
      path, why: "table",
      specs: unique(hit.flatMap((e) => e.specs)),
      pages: unique(hit.flatMap((e) => e.pages || [])),
    };
  });
  const all = reasons.some((r) => r.why !== "table");

  return all
    ? { all, specs: tableSpecs(table), pages: tablePages(table), reasons }
    : {
      all,
      specs: unique(reasons.flatMap((r) => r.specs)),
      pages: unique(reasons.flatMap((r) => r.pages)),
      reasons,
    };
};

// The workflow's inputs for a choice, the one place they are made.
// Pages go only with a narrow choice: when the choice is everything,
// none are sent, so the keyboard walk covers the whole site (#615).
export const dispatchInputs = ({ all, specs, pages = [] }) => ({
  specs: specs.join(" "),
  ...(!all && pages.length ? { pages: pages.join(" ") } : {}),
});

// The test e2e.yml's plan job puts to a named spec: a plain path
// under e2e/ ending in .spec.mjs, with no ".." or "//".
const SPEC = /^e2e\/[A-Za-z0-9._/-]+[.]spec[.]mjs$/;

// The specs to send, blanks dropped, and the ones e2e.yml would refuse.
export const checkSpecs = (specs) => {
  const kept = specs.map((s) => String(s).trim()).filter(Boolean);

  return {
    specs: kept,
    bad: kept.filter((s) => !SPEC.test(s) || /\.\.|\/\//.test(s)),
  };
};

// The test e2e.yml's plan job puts to a page: a plain site path, with
// no ".." or "//".
const PAGE = /^\/[A-Za-z0-9._/-]*$/;

// The pages to send, blanks dropped, and the ones e2e.yml would refuse.
export const checkPages = (pages) => {
  const kept = pages.map((p) => String(p).trim()).filter(Boolean);

  return {
    pages: kept,
    bad: kept.filter((p) => !PAGE.test(p) || /\.\.|\/\//.test(p)),
  };
};

// A ref for git: never one git could read as an option.
export const checkBase = (base) => !!base && !base.startsWith("-");

// Text from a log or the API with every C0 and C1 control character
// gone, colors and other escape sequences first, so none reaches the
// terminal. Bidi overrides and isolates go too, so none reorders a
// line.
/* eslint-disable no-control-regex -- control characters are the point */
export const printable = (text) => String(text)
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
  .replace(/\t/g, " ")
  .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, "");
/* eslint-enable no-control-regex */

// The failing tests in a job's log, from Playwright's closing list
// ("2 failed" and one line per test), or failing that, its numbered
// reports. -> [{ file, line, title, projects }]
export const failuresInLog = (log) => {
  const lines = String(log).split("\n").map((l) => printable(l
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""))
    .trimEnd());
  const test = /^\s*(?:\d+\) )?\[([^\]]+)\] › (e2e\/[^:\s]+):(\d+):\d+ › (.+)$/;
  const found = new Map();
  const add = (m) => {
    const [, project, file, line, title] = m;
    const key = `${file}\n${title.trim()}`;
    const seen = found.get(key)
      || { file, line: Number(line), title: title.trim(), projects: [] };

    if (!seen.projects.includes(project)) seen.projects.push(project);
    found.set(key, seen);
  };

  lines.forEach((l, i) => {
    if (!/^\s+\d+ failed$/.test(l)) return;
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = lines[j].match(test);

      if (!m || /^\s*\d+\)/.test(lines[j])) break;
      add(m);
    }
  });
  if (!found.size) {
    for (const l of lines) {
      if (/^\s+\d+\) \[/.test(l)) {
        const m = l.match(test);

        if (m) add(m);
      }
    }
  }

  return [...found.values()];
};

// The site page a test's name carries, as the keyboard walk's
// "/order/ tabs cleanly" does: the first word that is a path.
export const pageOf = (title) => {
  const m = title.match(/(?:^|[\s›])(\/[A-Za-z0-9._~\-/]*)(?=\s|$)/);

  return m ? m[1] : null;
};

export const failureLine = (f) => {
  const page = pageOf(f.title);
  const where = [page && `page ${page}`, f.projects.join(", ")]
    .filter(Boolean).join("; ");

  return `  ${f.file}:${f.line} › ${f.title} (${where})`;
};

// --- The real seams ---------------------------------------------------

const git = async (args) => (await execute("git", args)).stdout.trim();

export const changedArgs = (base) => ["diff", "--name-only",
  "--no-renames", "--end-of-options", `${base}...HEAD`];

// GitHub's REST API through gh, signed in already: parsed JSON, or the
// text of a log. gh refuses an answer holding an escape sequence, as a
// Playwright log's colors do, unless told to pass it (#623); what it
// passes is printed only through printable().
export const ghArgs = (path, { method = "GET", body } = {}) => ["api",
  "-X", method, "--allow-escape-sequences", path,
  ...(body === undefined ? [] : ["--input", "-"])];

export const ghApi = (path, { method = "GET", body } = {}) =>
  new Promise((resolve, reject) => {
    const args = ghArgs(path, { method, body });
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const said = (stderr.trim() || stdout.trim() || `exit ${code}`)
          .split("\n").map(printable).join("\n");

        reject(new Error(`gh api ${printable(method)} ${printable(path)}: ${
          said}`));

        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch {
        resolve(stdout);
      }
    });
    child.stdin.end(body === undefined ? "" : JSON.stringify(body));
  });

export const realDeps = {
  // --no-renames: a moved file lists its old path too, so moving a
  // shared file still selects everything.
  changed: async (base) => (await git(changedArgs(base)))
    .split("\n").filter(Boolean),
  // The run checks out the pushed branch, so say when it is not HEAD.
  branch: async () => {
    const name = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const head = await git(["rev-parse", "HEAD"]);
    const pushed = await git(["rev-parse", "--verify", "--quiet",
      `refs/remotes/origin/${name}`]).catch(() => "");

    if (pushed !== head) {
      console.error(`[e2e] origin/${name} is ${pushed
        ? `at ${pushed.slice(0, 8)}` : "missing"}, not HEAD ${
        head.slice(0, 8)}: the run tests what is pushed.`);
    }

    return name;
  },
  api: ghApi,
  wait: (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
  get table() {
    return JSON.parse(readFileSync(
      new URL("../../e2e/dispatch.json", import.meta.url), "utf8"));
  },
};

// --- The command ------------------------------------------------------

const printChoice = (choice, out, { base, how }) => {
  if (how === "named") out("Named by hand, the table not read:");
  else if (how === "all") out("--all: every spec in e2e/dispatch.json.");
  else {
    out(`Against ${base}, ${plural(choice.reasons.length, "changed path")}:`);
    const wide = choice.reasons.filter((r) => r.why !== "table");

    for (const r of choice.all ? wide : choice.reasons) {
      const path = printable(r.path);

      if (r.why === "shared") out(`  ${path}: shared, so every spec`);
      else if (r.why === "unknown") {
        out(`  ${path}: not in the table, so every spec`);
      } else {
        out(`  ${path}: ${[...r.specs, ...r.pages].map(printable).join(" ")
          || "no e2e"}`);
      }
    }
    if (choice.all && wide.length < choice.reasons.length) {
      out(`  and ${plural(choice.reasons.length - wide.length,
        "path")} more the table maps`);
    }
  }
  const specs = choice.specs.map(printable).join(" ");
  const pages = choice.pages.map(printable).join(" ");

  out(`Specs (${choice.specs.length}): ${specs || "none"}`);
  if (choice.pages.length) {
    out(`Pages (${choice.pages.length}): ${pages}${
      choice.all ? " (not sent: every page is walked)" : ""}`);
  }
};

const runPath = (id) => `repos/${REPO}/actions/runs/${id}`;

const report = async (api, run, out) => {
  const { jobs = [] } = await api(`${runPath(run.id)}/jobs?per_page=100`);
  const failed = jobs.filter((j) => j.conclusion === "failure");
  const tests = new Map();

  for (const job of failed.filter((j) => !GATES.has(j.name))) {
    const log = await api(`repos/${REPO}/actions/jobs/${job.id}/logs`);

    for (const f of failuresInLog(log)) {
      const key = `${f.file}\n${f.title}`;
      const seen = tests.get(key);

      if (seen) seen.projects = unique([...seen.projects, ...f.projects]);
      else tests.set(key, f);
    }
  }

  out(`${run.conclusion === "failure" ? "Failed"
    : `Failed (${printable(run.conclusion)})`}: ${printable(run.html_url)}`);
  if (tests.size) {
    for (const f of tests.values()) out(failureLine(f));

    return;
  }
  // No test failed: a job did, before or around the tests.
  for (const job of failed) {
    const step = (job.steps || []).find((s) => s.conclusion === "failure");

    out(`  job ${printable(job.name)}${
      step ? `, at "${printable(step.name)}"` : ""}`);
  }
};

// The flags e2e reads. bin/nff's parser takes any `--name`, so a typo
// (--dryrun) or a global flag that means nothing here (--staging,
// --no-email: the run is GitHub's and sends no email) would otherwise
// fall through to "no arguments" and dispatch (#630).
export const FLAGS = ["all", "dry-run", "base", "help"];

export const unknownFlags = (flags) => Object.keys(flags)
  .filter((name) => !FLAGS.includes(name));

export const e2eCommand = async (args, { flags = {}, out }, deps = {}) => {
  const d = { ...realDeps, ...deps };

  // Before anything else is read: help wins over every other word.
  if (flagOn(flags.help) || args.includes("-h")) {
    out(USAGE);

    return 0;
  }

  const unknown = unknownFlags(flags);

  if (unknown.length) {
    out(`Not a flag bin/nff e2e takes: ${
      unknown.map((name) => `--${printable(name)}`).join(" ")}`);
    out(USAGE);

    return NOT_DISPATCHED;
  }

  const named = {
    specs: args.filter((a) => a.startsWith("e2e/")),
    pages: args.filter((a) => a.startsWith("/")),
  };
  const odd = args.filter((a) => !a.startsWith("e2e/") && !a.startsWith("/"));

  if (odd.length) {
    out(`Not a spec (e2e/...) or a page (/...): ${
      odd.map(printable).join(" ")}`);
    out(USAGE);

    return 2;
  }

  // A bare --base arrives as `true`: refuse it, never fall back to BASE.
  const given = flags.base !== undefined;
  const base = given ? flags.base : BASE;

  if (typeof base !== "string" || !checkBase(base)) {
    out(`Not a ref to compare with: --base${
      typeof base === "string" ? `=${printable(base)}` : ""}`);
    out(USAGE);

    return NOT_DISPATCHED;
  }
  let choice;
  let how = "changed";

  if (named.specs.length || named.pages.length) {
    how = "named";
    choice = { all: false, ...named, reasons: [] };
  } else if (flagOn(flags.all)) {
    how = "all";
    choice = { all: true, specs: tableSpecs(d.table),
      pages: tablePages(d.table), reasons: [] };
  } else {
    const paths = await d.changed(base);

    if (!paths.length) {
      out(`Nothing changed against ${base}: no run.`);

      return 0;
    }
    choice = choose(paths, d.table);
  }
  const { specs, bad } = checkSpecs(choice.specs);
  const { pages, bad: badPages } = checkPages(choice.pages);

  choice = { ...choice, specs, pages };
  printChoice(choice, out, { base, how });
  if (bad.length) {
    out(`Not a spec path e2e.yml takes: ${bad.map(printable).join(" ")}`);

    return 2;
  }
  if (badPages.length) {
    out(`Not a site path e2e.yml takes: ${
      badPages.map(printable).join(" ")}`);

    return 2;
  }

  if (flagOn(flags["dry-run"])) return 0;
  // An empty specs input runs the full suite: never send one.
  if (!choice.specs.length) {
    out(how === "named"
      ? "Name a spec too: e2e.yml runs pages only within named specs."
      : "No spec to run.");

    return how === "named" ? 2 : 0;
  }

  const ref = await d.branch();

  if (PROMOTED.has(ref)) {
    out(`e2e.yml runs named specs on lane branches only, not ${ref}.`);

    return 2;
  }
  const dispatched = await d.api(
    `repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: {
        ref,
        inputs: dispatchInputs(choice),
        // eslint-disable-next-line camelcase -- GitHub's name
        return_run_details: true,
      },
    });
  const id = dispatched.workflow_run_id;

  const url = printable(dispatched.html_url);

  out(`Dispatched on ${ref}: ${url}`);
  out(`Waiting; one look every ${LOOK_EVERY_MS / 60000} minutes.`);

  // From here on the command resolves to a code and never rejects.
  try {
    return await verdict(d, id, url, out);
  } catch (error) {
    noVerdict(out, url, `it stopped on ${firstLine(error)}`);

    return NO_VERDICT;
  }
};

const firstLine = (error) => printable(String(error?.message || error)
  .split("\n")[0]).slice(0, 200);

const noVerdict = (out, url, why) => {
  out(`No verdict: ${why}, so it is not known how the run ended.`);
  out(`See the run: ${url}`);
};

// One look at the run, looking again after a failed answer until
// LOOK_TRIES fail in a row. -> { run } or { error }
const look = async (d, id, out, pause) => {
  for (let failed = 1; ; failed += 1) {
    try {
      return { run: await d.api(runPath(id)) };
    } catch (error) {
      if (failed >= LOOK_TRIES) return { error };
      out(`GitHub did not answer (${firstLine(error)}); looking again.`);
      await pause();
    }
  }
};

const verdict = async (d, id, url, out) => {
  let waited = 0;
  const pause = async () => {
    await d.wait(LOOK_EVERY_MS);
    waited += LOOK_EVERY_MS;
  };
  let seen = await look(d, id, out, pause);

  while (seen.run && seen.run.status !== "completed") {
    if (waited >= GIVE_UP_MS) {
      noVerdict(out, url, `the run was still ${printable(seen.run.status)} `
        + `after ${GIVE_UP_MS / 3600000} hours and it stopped waiting`);

      return NO_VERDICT;
    }
    await pause();
    seen = await look(d, id, out, pause);
  }
  if (seen.error) {
    noVerdict(out, url, `GitHub did not answer ${LOOK_TRIES} looks in a row `
      + `(${firstLine(seen.error)})`);

    return NO_VERDICT;
  }
  const { run } = seen;

  if (run.conclusion === "success") {
    out(`Passed: ${printable(run.html_url)}`);

    return PASSED;
  }
  try {
    await report(d.api, run, out);
  } catch (error) {
    out(`Failed (${printable(run.conclusion)}): ${printable(run.html_url)}`);
    out(`  could not read which tests failed: ${firstLine(error)}`);
  }

  return FAILED;
};
