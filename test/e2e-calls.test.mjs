// The e2e suite's count of function calls (#519): which requests are
// calls, the tally, the workers' files added up, and the report and
// its line (e2e/support/calls.mjs).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  NO_SPEC, countCall, createTally, functionPath, mergeTallies, record,
  report, setChargeTo, summaryLine, workerTally, writeReport, writeWorker,
} from "../e2e/support/calls.mjs";

const BASE = "https://staging--north-foster-farm.netlify.app";

const tallyOf = (calls) => {
  const tally = createTally();

  for (const [spec, path] of calls) record(tally, spec, path);

  return tally;
};

describe("a function call", () => {
  it("is /api/ or /.netlify/functions/ on the deploy's own host", () => {
    assert.equal(functionPath(`${BASE}/api/stock?x=1`, BASE), "/api/stock");
    assert.equal(functionPath(`${BASE}/.netlify/functions/jobs`, BASE),
      "/.netlify/functions/jobs");
    // The request fixture's relative paths.
    assert.equal(functionPath("/api/dates", BASE), "/api/dates");
  });

  it("is not a page, an asset or another site's API", () => {
    for (const url of [
      `${BASE}/order/`, `${BASE}/apiary/`, `${BASE}/scripts/api/x.js`,
      "https://connect.squareupsandbox.com/api/v1/x",
      "data:text/plain,api", "not a url",
    ]) {
      assert.equal(functionPath(url, BASE), null, url);
    }
  });
});

describe("the tally", () => {
  it("counts each call by spec and by path", () => {
    assert.deepEqual(tallyOf([
      ["e2e/a.spec.mjs", "/api/stock"],
      ["e2e/a.spec.mjs", "/api/staging/e2e"],
      ["e2e/b.spec.mjs", "/api/stock"],
    ]), {
      total: 3,
      specs: { "e2e/a.spec.mjs": 2, "e2e/b.spec.mjs": 1 },
      paths: { "/api/stock": 2, "/api/staging/e2e": 1 },
    });
  });

  it("adds up the workers' tallies", () => {
    const merged = mergeTallies([
      tallyOf([["e2e/a.spec.mjs", "/api/stock"]]),
      tallyOf([["e2e/a.spec.mjs", "/api/stock"],
        ["e2e/b.spec.mjs", "/api/dates"]]),
      createTally(),
    ]);

    assert.equal(merged.total, 3);
    assert.deepEqual(merged.specs,
      { "e2e/a.spec.mjs": 2, "e2e/b.spec.mjs": 1 });
    assert.deepEqual(merged.paths, { "/api/stock": 2, "/api/dates": 1 });
  });

  it("charges a call to the spec running, or the one named", () => {
    const before = structuredClone(workerTally());

    setChargeTo(() => "e2e/now.spec.mjs");
    assert.equal(countCall("/api/staging/e2e", BASE), true);
    assert.equal(countCall("/api/stock", BASE, "e2e/made.spec.mjs"), true);
    assert.equal(countCall("/order/", BASE), false);
    setChargeTo(() => NO_SPEC);

    const now = workerTally();

    assert.equal(now.total, before.total + 2);
    assert.equal(now.specs["e2e/now.spec.mjs"], 1);
    assert.equal(now.specs["e2e/made.spec.mjs"], 1);
  });
});

describe("the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "nff-calls-"));

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("sorts the most first, then by name", () => {
    const out = report(tallyOf([
      ["e2e/b.spec.mjs", "/api/x"], ["e2e/a.spec.mjs", "/api/x"],
      ["e2e/c.spec.mjs", "/api/y"], ["e2e/c.spec.mjs", "/api/y"],
    ]));

    assert.deepEqual(Object.keys(out.specs),
      ["e2e/c.spec.mjs", "e2e/a.spec.mjs", "e2e/b.spec.mjs"]);
    assert.deepEqual(out.paths, { "/api/x": 2, "/api/y": 2 });
  });

  it("names the total and the ten busiest specs on one line", () => {
    const calls = [];

    for (let i = 1; i <= 12; i += 1) {
      for (let n = 0; n < i; n += 1) {
        calls.push([`e2e/s${i}.spec.mjs`, "/api/x"]);
      }
    }

    const line = summaryLine(tallyOf(calls));

    assert.match(line, /^Function calls: 78 in all; busiest specs: /);
    assert.match(line, /s12\.spec\.mjs 12, s11\.spec\.mjs 11, /);
    assert.match(line, /s3\.spec\.mjs 3\.$/);
    assert.doesNotMatch(line, /s2\.spec|s1\.spec|\n/);
    assert.equal(summaryLine(createTally()), "Function calls: 0 in all.");
  });

  it("is written from the workers' files", () => {
    const workers = join(dir, "workers");
    const file = join(dir, "function-calls.json");

    writeWorker(tallyOf([["e2e/a.spec.mjs", "/api/stock"]]), "0-1", workers);
    writeWorker(tallyOf([["e2e/a.spec.mjs", "/api/dates"],
      ["e2e/b.spec.mjs", "/api/stock"]]), "1-2", workers);

    assert.equal(writeReport({ dir: workers, file }),
      "Function calls: 3 in all; busiest specs: a.spec.mjs 2, b.spec.mjs 1.");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      total: 3,
      specs: { "e2e/a.spec.mjs": 2, "e2e/b.spec.mjs": 1 },
      paths: { "/api/stock": 2, "/api/dates": 1 },
    });
  });

  it("is a zero, not a failure, when no worker wrote one", () => {
    const file = join(dir, "none.json");

    assert.equal(writeReport({ dir: join(dir, "missing"), file }),
      "Function calls: 0 in all.");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).total, 0);
  });
});
