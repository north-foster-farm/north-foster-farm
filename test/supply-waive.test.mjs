import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { tooNew } from "../bin/supply/lockfile.mjs";
import { supplyCommand, waiverEntry } from "../bin/supply/waive.mjs";

const NOW = new Date("2026-10-18T12:00:00Z");
const ADVISORY = "GHSA-AAAA-bbbb-1234";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "waive-"));
  const lines = [];
  const cli = (args, flags = {}) => supplyCommand(args[0], args.slice(1), {
    root, flags, now: NOW, out: (line) => lines.push(line),
  });
  const waivers = () => JSON.parse(
    readFileSync(join(root, "security/cooldown-waivers.json"), "utf8"),
  );

  return { root, lines, cli, waivers };
};

describe("bin/nff supply waive", () => {
  it("records one version, an incident note and a line for the PR",
    async () => {
      const { root, lines, cli, waivers } = setup();

      await cli(["waive", "left-pad", "1.3.1"],
        { advisory: ADVISORY, reason: "exploited in the wild" });

      assert.deepEqual(waivers(), [{
        package: "left-pad",
        version: "1.3.1",
        advisory: "GHSA-aaaa-bbbb-1234",
        reason: "exploited in the wild",
        date: "2026-10-18",
      }]);

      const [note] = readdirSync(join(root, "incidents"));

      assert.equal(note, "2026-10-18-cooldown-waiver-left-pad-1.3.1.md");
      assert.match(readFileSync(join(root, "incidents", note), "utf8"),
        /Case B/);
      assert.match(lines.join("\n"),
        /For the pull request: Cooldown waived for left-pad@1\.3\.1/);
    });

  it("makes the supply check pass that version and no other", async () => {
    const { cli, waivers } = setup();

    await cli(["waive", "pkg", "2.0.0"], { advisory: ADVISORY, reason: "r" });

    const day = 24 * 60 * 60 * 1000;
    const published = {
      "pkg@2.0.0": new Date(NOW - day).toISOString(),
      "pkg@2.0.1": new Date(NOW - day).toISOString(),
    };
    const result = tooNew([
      { name: "pkg", version: "2.0.0" },
      { name: "pkg", version: "2.0.1" },
    ], published, NOW.getTime(), 7, waivers());

    assert.deepEqual(result.young, ["pkg@2.0.1"]);
  });

  it("refuses a range, a missing advisory or reason, and a repeat",
    async () => {
      const { cli } = setup();
      const flags = { advisory: ADVISORY, reason: "r" };

      await assert.rejects(cli(["waive", "pkg", "^2.0.0"], flags),
        /one exact version/);
      await assert.rejects(cli(["waive", "pkg", "2.0.0"], { reason: "r" }),
        /--advisory/);
      await assert.rejects(cli(["waive", "pkg", "2.0.0"],
        { advisory: ADVISORY }), /--reason/);
      await assert.rejects(cli(["waive", "Bad Name", "2.0.0"], flags),
        /not a package/);
      await cli(["waive", "pkg", "2.0.0"], flags);
      await assert.rejects(cli(["waive", "pkg", "2.0.0"], flags),
        /already waived/);
    });

  it("lists and drops waivers, in any file named by --file", async () => {
    const { root, lines, cli } = setup();
    const flags = { advisory: ADVISORY, reason: "r", file: "other.json" };

    assert.equal(waiverEntry({
      name: "@s/p", version: "1.0.0-rc.1", advisory: ADVISORY, reason: " r ",
    }, NOW).reason, "r");

    await cli(["waivers"], flags);
    assert.deepEqual(lines.splice(0), ["No cooldown waivers."]);

    await cli(["waive", "pkg", "2.0.0"], flags);
    lines.length = 0;
    await cli(["waivers"], flags);
    assert.match(lines[0], /^pkg@2\.0\.0 {2}GHSA-aaaa-bbbb-1234 {2}2026-10-18/);
    assert.ok(existsSync(join(root, "other.json")));
    assert.ok(!existsSync(join(root, "security/cooldown-waivers.json")));

    await cli(["unwaive", "pkg", "2.0.0"], flags);
    await assert.rejects(cli(["unwaive", "pkg", "2.0.0"], flags),
      /No waiver for pkg@2\.0\.0/);
  });
});
