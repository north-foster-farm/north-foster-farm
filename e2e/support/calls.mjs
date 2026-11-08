// The function calls a run makes (#519), so the testing budget rests
// on a count rather than a guess: Netlify restricted the account on
// 2026-11-02 for Functions overages. A function call is a request to
// the deploy's own host whose path starts with /api/ or
// /.netlify/functions/.
//
// Each worker keeps a tally (e2e/support/counted.mjs feeds it from
// the test's pages, request contexts and the back office) and writes
// it to WORKER_DIR when it stops. The run's global teardown
// (e2e/support/calls-teardown.mjs) adds them up into REPORT and
// prints one line. Nothing here sends a request.
//
// No Playwright import: e2e/support/staging.mjs counts its own calls
// here, and bin/e2e/sweep.mjs loads that outside the runner.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PREFIXES = ["/api/", "/.netlify/functions/"];

// Under the config's outputDir, which Playwright empties at the start
// of every run, so no earlier run's workers are counted.
export const WORKER_DIR = join(root, "test-results", "e2e", "function-calls");
export const REPORT = join(root, "test-results", "function-calls.json");

// Who the calls outside a test are charged to: a worker's setup, or
// the sweep.
export const NO_SPEC = "(outside a spec)";

// -> the path of a function call on `base`'s host, or null. A relative
// URL is the deploy's own, as the request fixture resolves it.
export const functionPath = (url, base) => {
  let target;

  try {
    target = new URL(url, base);
  } catch {
    return null;
  }
  if (target.host !== new URL(base).host) return null;

  return PREFIXES.some((p) => target.pathname.startsWith(p))
    ? target.pathname : null;
};

export const createTally = () => ({ total: 0, specs: {}, paths: {} });

export const record = (tally, spec, path) => {
  tally.total += 1;
  tally.specs[spec] = (tally.specs[spec] || 0) + 1;
  tally.paths[path] = (tally.paths[path] || 0) + 1;
};

const add = (into, counts) => {
  for (const [key, n] of Object.entries(counts || {})) {
    into[key] = (into[key] || 0) + n;
  }
};

export const mergeTallies = (tallies) => {
  const out = createTally();

  for (const t of tallies) {
    out.total += t.total || 0;
    add(out.specs, t.specs);
    add(out.paths, t.paths);
  }

  return out;
};

// -> [key, n] pairs, the most first, then by name.
export const busiest = (counts, limit = Infinity) => Object.entries(counts)
  .sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
  .slice(0, limit);

// The report's shape: each count sorted, the most first.
export const report = (tally) => ({
  total: tally.total,
  specs: Object.fromEntries(busiest(tally.specs)),
  paths: Object.fromEntries(busiest(tally.paths)),
});

export const summaryLine = (tally) => {
  const top = busiest(tally.specs, 10)
    .map(([spec, n]) => `${spec.replace(/^e2e\//, "")} ${n}`);

  return `Function calls: ${tally.total} in all${
    top.length ? `; busiest specs: ${top.join(", ")}` : ""}.`;
};

// This process's tally, which `countCall` feeds. `chargeTo` names the
// spec a call is charged to when the caller doesn't say.
const mine = createTally();
let chargeTo = () => NO_SPEC;

export const workerTally = () => mine;

export const setChargeTo = (fn) => {
  chargeTo = fn;
};

// Counts `url` if it is a function call on `base`. -> whether it was.
export const countCall = (url, base, spec = chargeTo()) => {
  const path = functionPath(url, base);

  if (path) record(mine, spec, path);

  return !!path;
};

export const writeWorker = (tally, name, dir = WORKER_DIR) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(tally));
};

export const readWorkers = (dir = WORKER_DIR) => {
  let names;

  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }

  return names.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
};

// Adds up the workers' tallies, writes the report and -> its line.
export const writeReport = ({ dir = WORKER_DIR, file = REPORT } = {}) => {
  const tally = mergeTallies(readWorkers(dir));

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report(tally), null, 2)}\n`);

  return summaryLine(tally);
};
