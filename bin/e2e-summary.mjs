#!/usr/bin/env node
// Turn Playwright's JSON report into the staging run's summary: which
// specs passed, which failed, and the lines to paste into
// e2e/staging-passing.txt (#449).
//
//   node bin/e2e-summary.mjs <report.json> <sha>
//
// Writes Markdown to $GITHUB_STEP_SUMMARY, or to stdout without it.

import { appendFileSync, readFileSync } from "node:fs";

const [file, sha = ""] = process.argv.slice(2);
if (!file) {
  console.error("usage: e2e-summary.mjs <report.json> <sha>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch {
  report = null;
}

const out = [];
if (!report && process.env.RUN_OUTCOME === "success") {
  // The run step exits cleanly without a report only when no spec was left.
  out.push(`## E2E staging at ${sha.slice(0, 12)}`, "");
  out.push("Every spec is on the passing list.");
} else if (!report) {
  out.push("## E2E staging", "", "No report was written: the run");
  out.push("stopped before any spec finished. See the log.");
} else {
  // Spec file to { passed, failed, skipped } test counts
  const specs = new Map();
  const walk = (suite, spec) => {
    const here = suite.file ? `e2e/${suite.file.split("/").pop()}` : spec;
    for (const s of suite.specs ?? []) {
      for (const t of s.tests ?? []) {
        const row = specs.get(here) ?? { passed: 0, failed: 0, skipped: 0 };
        if (t.status === "expected" || t.status === "flaky") row.passed++;
        else if (t.status === "skipped") row.skipped++;
        else row.failed++;
        specs.set(here, row);
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, "");

  const names = [...specs.keys()].sort();
  const failed = names.filter((n) => specs.get(n).failed > 0);
  const passed = names.filter(
    (n) => specs.get(n).failed === 0 && specs.get(n).passed > 0,
  );
  const skipped = names.filter(
    (n) => specs.get(n).failed === 0 && specs.get(n).passed === 0,
  );
  const date = new Date().toISOString().slice(0, 10);

  out.push(`## E2E staging at ${sha.slice(0, 12)}`, "");
  out.push(
    `${passed.length} passed, ${failed.length} failed, ` +
      `${skipped.length} skipped (of ${names.length} specs)`,
    "",
  );
  out.push("### Failed", "");
  out.push(...(failed.length ? failed.map((n) => `- ${n}`) : ["None."]), "");
  out.push("### Passed: lines for e2e/staging-passing.txt", "", "```");
  out.push(...passed.map((n) => `${n} ${sha.slice(0, 12)} ${date}`));
  out.push("```", "");
  out.push("### Skipped on their own (opt-in or not on Netlify)", "");
  out.push(...(skipped.length ? skipped.map((n) => `- ${n}`) : ["None."]));
}

const text = `${out.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
} else {
  process.stdout.write(text);
}
