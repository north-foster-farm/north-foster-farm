// #673's band: each market's hours on the home page hold together in a
// text-nowrap span, so a phone never starts a line with AM or PM
// ("Saturdays, 9:00 AM – 12:00 / PM" at 320 px). The day before them
// may wrap. Read off the built HTML; where Hugo is not installed (CI's
// test job) this is skipped.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;
const series = JSON.parse(readFileSync(join(root, "data", "series.json"),
  "utf8")).series;

describe("home page market hours", { skip: !hasHugo }, () => {
  let out;
  let lines;

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-market-hours-"));

    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], { cwd: root, encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);

    const html = readFileSync(join(out, "index.html"), "utf8");

    lines = [...html.matchAll(/<p class="place-when">([\s\S]*?)<\/p>/g)]
      .map((m) => m[1].trim());
  });

  after(() => rmSync(out, { recursive: true, force: true }));

  it("keeps each market's hours, AM and PM included, on one line", () => {
    assert.equal(lines.length,
      series.filter((s) => s.kind === "market").length, "every market");
    for (const line of lines) {
      const m = line.match(
        /^\w+s, <span class="text-nowrap">([^<]+)<\/span>$/);

      assert.ok(m, `the hours in one nowrap span: ${line}`);
      assert.match(m[1], /^\d{1,2}:\d{2}( [AP]M)? – \d{1,2}:\d{2} [AP]M$/,
        `the whole window, with its AM or PM: ${m[1]}`);
    }
  });
});
