import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { findOldPlace } from "../bin/check-places.mjs";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;
const OLD = ["Village", "Green"];

describe("the drop site's place (#541)", () => {
  it("is a street address; no tracked file names the old venue", () => {
    assert.deepEqual(findOldPlace(), []);
  });

  it("catches the old venue, wrapped or spaced oddly, in a tracked file",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "nff-places-"));
      const git = (...args) => execFileSync("git", args, { cwd: dir });

      try {
        git("init", "-q");
        writeFileSync(join(dir, "a.md"), `at the ${OLD.join(" ")}\n`);
        writeFileSync(join(dir, "b.md"), `at the ${OLD[0]}\n${OLD[1]}\n`);
        writeFileSync(join(dir, "c.md"), `${OLD.join("  ")}\n`);
        writeFileSync(join(dir, "ok.md"), "46 Institute Lane\n");
        git("add", ".");

        assert.deepEqual(findOldPlace(dir).map((h) => h.split(":")[0]),
          ["a.md", "b.md", "c.md"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
});

describe("the drop site's address on built pages (#541)", { skip: !hasHugo },
  () => {
    let out;
    const page = (p) => readFileSync(join(out, p, "index.html"), "utf8")
      .replace(/<[^>]+>/g, " ").replaceAll(String.fromCharCode(0xa0), " ")
      .replace(/\s+/g, " ");

    before(() => {
      out = mkdtempSync(join(tmpdir(), "nff-places-build-"));

      const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
        "production", "-d", out], { cwd: root, encoding: "utf8" });

      assert.equal(run.status, 0, run.stderr);
    });

    after(() => rmSync(out, { recursive: true, force: true }));

    it("never prints the street twice in a row on the About page", () => {
      const text = page("about");

      assert.match(text, /46 Institute Lane, North Scituate, RI 02857/);
      assert.doesNotMatch(text, /46 Institute Lane\s+46 Institute Lane/);
    });

    it("names the town once in the delivery policy's drop site line", () => {
      const text = page("delivery-policy");
      const line = text
        .match(/The drop site in North Scituate runs on.*?market days/);

      assert.ok(line, "the drop site sentence");
      assert.equal(line[0].match(/North Scituate/g).length, 1);
      assert.match(line[0], /at 46 Institute Lane: the same corner/);
    });
  });
