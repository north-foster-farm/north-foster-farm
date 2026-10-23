import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRANCH, checkImage, checkRepo, ensureBranch, markdown, MAX_BYTES,
  parseArgs, readImage, shotPath, shotUrl, upload,
} from "../bin/shot/lib.mjs";

const NOW = new Date("2026-10-22T14:05:09Z");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const ok = (stdout) => ({ ok: true, stdout, stderr: "" });
const fail = (stderr) => ({ ok: false, stdout: "", stderr });

describe("gh-shot", () => {
  it("reads files and options in any order", () => {
    const opts = parseArgs(["a.png", "--issue", "283", "b.jpg",
      "--alt", "Order page"]);
    assert.deepEqual(opts.files, ["a.png", "b.jpg"]);
    assert.equal(opts.issue, "283");
    assert.equal(opts.alt, "Order page");
    assert.equal(opts.repo, null);
  });

  it("refuses a bad issue, repo or option", () => {
    assert.throws(() => parseArgs(["--issue", "abc"]), /number/);
    assert.throws(() => parseArgs(["--repo", "nope"]), /owner\/name/);
    assert.throws(() => parseArgs(["--force"]), /Unknown option/);
    assert.throws(() => parseArgs(["--alt"]), /needs a value/);
  });

  it("takes only images GitHub renders inline", () => {
    assert.doesNotThrow(() => checkImage("x.PNG", PNG));
    assert.throws(() => checkImage("x.pdf", PNG), /not a png/);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]);
    assert.throws(() => checkImage("x.png", big), /10 MB/);
  });

  it("checks magic bytes, not just the extension", () => {
    const env = Buffer.from("API_KEY=hunter2\n");
    assert.throws(() => checkImage("x.png", env), /not a real png/);
    assert.throws(() => checkImage("x.jpg", PNG), /not a real jpg/);
    assert.doesNotThrow(() => checkImage("x.jpeg", JPEG));
    assert.doesNotThrow(() => checkImage("x.gif", Buffer.from("GIF87a")));
    assert.doesNotThrow(() => checkImage("x.gif", Buffer.from("GIF89a")));
    assert.throws(() => checkImage("x.gif", Buffer.from("GIF90a")),
      /not a real gif/);
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
    assert.doesNotThrow(() => checkImage("x.webp", webp));
    const wav = Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1");
    assert.throws(() => checkImage("x.webp", wav), /not a real webp/);
    assert.throws(() => checkImage("x.png", Buffer.alloc(0)),
      /not a real png/);
  });

  it("refuses a symlink even to a real image", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-shot-"));
    try {
      const real = join(dir, "real.png");
      const link = join(dir, "link.png");
      writeFileSync(real, PNG);
      symlinkSync(real, link);
      assert.deepEqual(readImage(real), PNG);
      assert.throws(() => readImage(link), /symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses . and .. segments in --repo", () => {
    for (const repo of ["./x", "x/.", "../x", "x/..", "../.."]) {
      assert.throws(() => parseArgs(["--repo", repo]), /owner\/name/);
    }
    assert.equal(parseArgs(["--repo", "a/b.c"]).repo, "a/b.c");
  });

  it("uploads only to the farm's repos unless --any-repo", () => {
    assert.doesNotThrow(() => checkRepo("north-foster-farm/nff-dashboard"));
    assert.doesNotThrow(
      () => checkRepo("North-Foster-Farm/north-foster-farm"));
    assert.throws(() => checkRepo("someone/else"), /--any-repo/);
    assert.doesNotThrow(() => checkRepo("someone/else", true));
    assert.throws(() => checkRepo("../x", true), /owner\/name/);
    assert.equal(parseArgs(["--any-repo"]).anyRepo, true);
    assert.equal(parseArgs([]).anyRepo, false);
  });

  it("carries on when a parallel upload made the branch first", () => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(" "));
      const url = args.find((arg) => arg.startsWith("repos/"));
      if (url.endsWith(`branches/${BRANCH}`)) {
        return calls.length === 1
          ? fail("HTTP 404 Not Found") : ok("{}");
      }
      if (url.endsWith("git/refs")) {
        return fail("HTTP 422 Reference already exists");
      }
      return ok('{"sha":"abc"}');
    };
    assert.equal(ensureBranch("o/r", run), false);
    assert.ok(calls.at(-1).endsWith(`branches/${BRANCH}`));
    const other = () => fail("HTTP 500 boom");
    assert.throws(() => ensureBranch("o/r", other), /Can't read/);
  });

  it("retries a contents PUT that hits a 409", () => {
    const calls = [];
    const conflicts = (n) => (args) => {
      calls.push(args.find((arg) => arg.startsWith("repos/")));
      const put = args.includes("PUT");
      const puts = calls.filter((c) => c.includes("/contents/")).length;
      return put && puts <= n ? fail("HTTP 409 conflict") : ok("{}");
    };
    const url = upload("o/r", "misc/a.png", PNG, conflicts(2));
    assert.match(url, /blob\/screenshots\/misc\/a\.png/);
    assert.equal(calls.filter((c) => c.includes("/contents/")).length, 3);
    assert.equal(calls.filter((c) => c.includes("/branches/")).length, 2);
    calls.length = 0;
    assert.throws(() => upload("o/r", "misc/a.png", PNG, conflicts(3)),
      /409/);
    const bad = () => fail("HTTP 422 nope");
    assert.throws(() => upload("o/r", "misc/a.png", PNG, bad), /422/);
  });

  it("files an image by issue, day and time", () => {
    assert.equal(
      shotPath("/tmp/Order Page (v2).PNG",
        { issue: "283", now: NOW, tag: "a1b2c3" }),
      "issue-283/2026-10-22/140509-a1b2c3-order-page-v2.png",
    );
    assert.equal(
      shotPath("___.jpg", { now: NOW, tag: "ffffff" }),
      "misc/2026-10-22/140509-ffffff-shot.jpg",
    );
  });

  it("links with a blob URL that survives a private repo", () => {
    const url = shotUrl("north-foster-farm/north-foster-farm",
      "misc/2026-10-22/a b.png");
    assert.equal(url, "https://github.com/north-foster-farm/"
      + "north-foster-farm/blob/screenshots/misc/2026-10-22/a%20b.png"
      + "?raw=true");
    assert.equal(markdown("a [b]", url), `![a b](${url})`);
  });
});
