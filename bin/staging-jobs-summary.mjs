#!/usr/bin/env node
// What the Staging jobs workflow prints. The repository is public, so
// anyone can read a workflow's log: it gets the HTTP status and counts,
// never the report itself, which can hold order ids, customer emails
// and names in its errors and violations. Every number below is a
// length or a count; the only text is the status and the names of the
// steps that failed, which are fixed words in lib/jobs.mjs.
//
//   node bin/staging-jobs-summary.mjs <http status> <response file>
//
// Exits 1 unless the status is 2xx and the response parses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STEP = /^[A-Za-z]{1,40}$/;

// A count of one report field: a list's length, a number as it is.
const count = (value) => {
  if (Array.isArray(value)) return value.length;

  return Number.isInteger(value) ? value : 0;
};

// (status, response text) -> { ok, lines }. Lines hold only digits,
// the status and step names.
export const summarize = (status, text) => {
  const code = /^\d{3}$/.test(String(status)) ? String(status) : "000";

  if (!code.startsWith("2")) {
    return { ok: false, lines: [`Staging jobs: HTTP ${code}.`] };
  }

  let report;

  try {
    report = JSON.parse(text);
  } catch {
    return { ok: false, lines: [`Staging jobs: HTTP ${code}, not JSON.`] };
  }
  if (!report || typeof report !== "object") {
    return { ok: false, lines: [`Staging jobs: HTTP ${code}, no report.`] };
  }

  const errors = Array.isArray(report.errors) ? report.errors : [];
  const steps = [...new Set(errors.map((e) => e && e.step)
    .filter((s) => STEP.test(String(s))))];
  const named = steps.length ? ` (${steps.join(", ")})` : "";
  const counts = (report.counts && typeof report.counts === "object")
    ? report.counts : report;
  const fields = ["deliveryReminded", "closed", "squareSynced", "muted",
    "checkoutsRescued", "pickupsToConfirm", "scrubbed", "checkoutsSwept",
    "authSwept"];
  const lines = [`Staging jobs: HTTP ${code}.`,
    `${fields.map((f) => `${f} ${count(counts[f])}`).join(", ")}.`,
    `Errors ${errors.length}${named}, invariants ${count(report.invariants)}.`];

  return { ok: true, lines };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [status, file] = process.argv.slice(2);
  let text = "";

  try {
    text = readFileSync(file, "utf8");
  } catch {
    // An empty response summarizes as "not JSON".
  }

  const { ok, lines } = summarize(status, text);

  console.log(lines.join("\n"));
  process.exit(ok ? 0 : 1);
}
