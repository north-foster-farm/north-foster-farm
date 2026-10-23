import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkImage, markdown, MAX_BYTES, parseArgs, shotPath, shotUrl,
} from "../bin/shot/lib.mjs";

const NOW = new Date("2026-10-22T14:05:09Z");

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
    assert.doesNotThrow(() => checkImage("x.PNG", 10));
    assert.throws(() => checkImage("x.pdf", 10), /not a png/);
    assert.throws(() => checkImage("x.png", MAX_BYTES + 1), /10 MB/);
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
