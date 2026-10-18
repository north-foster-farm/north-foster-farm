import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkRange, resolveBase, SHAPE_PATHS, touchesShape,
} from "../bin/check-record-shape.mjs";

const commit = (files, message = "Change something\n\nBody.\n") =>
  ({ sha: "a".repeat(40), message, files });

describe("record shape: which files count", () => {
  it("matches a listed file and anything under a listed directory", () => {
    assert.deepEqual(touchesShape([
      "netlify/functions/lib/store.mjs",
      "netlify/migrations/2026-10-add-field.mjs",
      "netlify/functions/lib/mail.mjs",
      "layouts/index.html",
    ]), [
      "netlify/functions/lib/store.mjs",
      "netlify/migrations/2026-10-add-field.mjs",
    ]);
  });

  it("does not match a file that only shares a prefix", () => {
    assert.deepEqual(touchesShape(["netlify/functions/lib/store.mjs.bak",
      "netlify/migrationsX/a.mjs"]), []);
  });

  it("lists paths that exist", async () => {
    const { existsSync } = await import("node:fs");
    for (const path of SHAPE_PATHS.filter((p) => !p.endsWith("/"))) {
      assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
    }
  });
});

describe("record shape: the range check", () => {
  it("passes a range that touches nothing", () => {
    const result = checkRange([commit(["layouts/index.html"])]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.touched, []);
  });

  it("passes an empty range", () => {
    assert.equal(checkRange([]).ok, true);
  });

  it("fails a touch with no trailer, and names the commit", () => {
    const result = checkRange([commit(["netlify/functions/lib/records.mjs"])]);
    assert.equal(result.ok, false);
    assert.equal(result.touched.length, 1);
    assert.deepEqual(result.touched[0].files,
      ["netlify/functions/lib/records.mjs"]);
  });

  it("passes when any commit in the range carries the trailer", () => {
    const result = checkRange([
      commit(["netlify/functions/lib/records.mjs"]),
      commit(["docs/x.md"],
        "Note the change\n\nRecord-shape: order gains a note field\n"),
    ]);
    assert.equal(result.ok, true);
  });

  it("accepts Record-shape: none", () => {
    const result = checkRange([commit(["netlify/functions/lib/store.mjs"],
      "Tidy store\n\nRecord-shape: none\n")]);
    assert.equal(result.ok, true);
  });

  it("rejects an empty trailer and a mention in prose", () => {
    for (const message of [
      "Fix\n\nRecord-shape:\n",
      "Fix\n\nRecord-shape:   \n",
      "Fix\n\nWe did not add a Record-shape: trailer here.\n",
    ]) {
      const result = checkRange([commit(["netlify/functions/lib/store.mjs"],
        message)]);
      assert.equal(result.ok, false, message);
    }
  });

  it("passes a trailer on a range that touches nothing", () => {
    const result = checkRange([commit(["docs/x.md"],
      "Doc\n\nRecord-shape: none\n")]);
    assert.equal(result.ok, true);
  });
});

describe("record shape: choosing the base", () => {
  const has = () => true;
  const lacks = () => false;

  it("uses the base it is given when git has it", () => {
    assert.equal(resolveBase("abc123", has), "abc123");
  });

  it("falls back to main for none, all zeros or an unknown commit", () => {
    assert.equal(resolveBase("", has), "origin/main");
    assert.equal(resolveBase(undefined, has), "origin/main");
    assert.equal(resolveBase("0".repeat(40), has), "origin/main");
    assert.equal(resolveBase("abc123", lacks), "origin/main");
  });
});
