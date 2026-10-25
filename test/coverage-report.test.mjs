import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addedLines, markdown, notice, parseLcov, ranges, run, summarize,
} from "../bin/coverage/report.mjs";

const LCOV = [
  "TN:",
  "SF:/repo/netlify/lib/a.mjs",
  "DA:1,1",
  "DA:2,0",
  "DA:3,4",
  "DA:5,0",
  "LF:4",
  "LH:2",
  "end_of_record",
  "SF:bin/b.mjs",
  "DA:1,0",
  "DA:2,1",
  "end_of_record",
  "",
].join("\n");

const DIFF = [
  "diff --git a/netlify/lib/a.mjs b/netlify/lib/a.mjs",
  "--- a/netlify/lib/a.mjs",
  "+++ b/netlify/lib/a.mjs",
  "@@ -1,0 +2,2 @@",
  "+x",
  "+y",
  "@@ -9 +5 @@",
  "-z",
  "+w",
  "@@ -12,3 +7,0 @@",
  "diff --git a/docs/c.md b/docs/c.md",
  "--- a/docs/c.md",
  "+++ b/docs/c.md",
  "@@ -1 +1 @@",
  "diff --git a/old.mjs b/old.mjs",
  "--- a/old.mjs",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "",
].join("\n");

describe("parseLcov", () => {
  it("reads each file's hits, relative to the root", () => {
    const files = parseLcov(LCOV, "/repo");

    assert.deepEqual([...files.keys()], ["netlify/lib/a.mjs", "bin/b.mjs"]);
    assert.deepEqual(
      [...files.get("netlify/lib/a.mjs")], [[1, 1], [2, 0], [3, 4], [5, 0]],
    );
  });
});

describe("addedLines", () => {
  it("takes the new side of each hunk and skips a deleted file", () => {
    const files = addedLines(DIFF);

    assert.deepEqual([...files.keys()], ["netlify/lib/a.mjs", "docs/c.md"]);
    assert.deepEqual([...files.get("netlify/lib/a.mjs")], [2, 3, 5]);
    assert.deepEqual([...files.get("docs/c.md")], [1]);
  });
});

describe("summarize", () => {
  const coverage = parseLcov(LCOV, "/repo");

  it("counts every instrumented line overall", () => {
    assert.deepEqual(summarize(coverage, null), {
      overall: { covered: 3, total: 6 },
    });
  });

  it("counts only changed lines the coverage measures", () => {
    const { changed, files } = summarize(coverage, addedLines(DIFF));

    assert.deepEqual(changed, { covered: 1, total: 3 });
    assert.deepEqual(files, [{
      path: "netlify/lib/a.mjs", covered: 1, total: 3, uncovered: [2, 5],
    }]);
  });

  it("measures nothing when no changed line is instrumented", () => {
    const { changed, files } = summarize(coverage, new Map([
      ["docs/c.md", new Set([1])], ["bin/b.mjs", new Set([9])],
    ]));

    assert.deepEqual(changed, { covered: 0, total: 0 });
    assert.deepEqual(files, []);
  });
});

describe("ranges", () => {
  it("joins runs of consecutive lines", () => {
    assert.equal(ranges([3, 4, 5, 9, 11, 12]), "3-5, 9, 11-12");
    assert.equal(ranges([]), "");
  });
});

describe("markdown", () => {
  it("shows overall, changed lines and each changed file", () => {
    const text = markdown(
      summarize(parseLcov(LCOV, "/repo"), addedLines(DIFF)),
    );

    assert.match(text, /\| Overall \| 50\.0% \(3 of 6\) \|/);
    assert.match(text, /\| Changed lines \| 33\.3% \(1 of 3\) \|/);
    assert.match(
      text, /\| `netlify\/lib\/a\.mjs` \| 33\.3% \(1 of 3\) \| 2, 5 \|/,
    );
  });

  it("says when a change has no measured line", () => {
    const text = markdown({
      overall: { covered: 1, total: 2 }, changed: { covered: 0, total: 0 },
      files: [],
    });

    assert.match(text, /\| Changed lines \| no measured lines \|/);
    assert.doesNotMatch(text, /Changed file/);
  });

  it("lists ten changed files and counts the rest", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.mjs`, covered: 1, total: 1, uncovered: [],
    }));
    const text = markdown({
      overall: { covered: 12, total: 12 },
      changed: { covered: 12, total: 12 }, files,
    });

    assert.match(text, /f9\.mjs/);
    assert.doesNotMatch(text, /f10\.mjs/);
    assert.match(text, /And 2 more changed files\./);
  });
});

describe("notice", () => {
  it("puts both figures on one annotation line", () => {
    assert.equal(
      notice({
        overall: { covered: 3, total: 6 }, changed: { covered: 1, total: 3 },
      }),
      "::notice title=Coverage::overall 50.0%, changed lines 33.3%",
    );
  });
});

describe("run", () => {
  const read = () => LCOV;

  it("diffs against the base it is given", () => {
    const refs = [];
    const git = (ref) => {
      refs.push(ref);

      return DIFF;
    };

    const text = run(["--base", "abc123", "cov.info"], { read, git });

    assert.deepEqual(refs, ["abc123"]);
    assert.match(text, /Changed lines/);
  });

  it("reports overall only with no base", () => {
    assert.doesNotMatch(run([], { read }), /Changed lines/);
  });

  it("says so, and never throws, when the lcov file is missing", () => {
    const missing = () => {
      throw new Error("ENOENT: coverage/lcov.info");
    };

    assert.match(run([], { read: missing }), /No report: ENOENT/);
    assert.equal(
      run(["--notice"], { read: missing }),
      "::notice title=Coverage::no report",
    );
  });
});
