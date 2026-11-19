// #658, boxes 6 and 7, which hold today and stay on in `npm test`.
// The contract and boxes 1 to 5 are in
// test/square-version-conflict.criteria.mjs and
// test/edit-switch-cancel.criteria.mjs (each `.test.mjs` once on).
//
// Box 7 has a second half no unit test can hold: the spec passes on
// staging in the next full run. That is a recorded check for the
// coordinator: in that run's log, `e2e/edit-switch.spec.mjs` passes
// on every project, and `git diff --exit-code <baseline> --
// e2e/edit-switch.spec.mjs` is empty against the commit that brought
// these tests in. Delete the hash test below once #658 is closed.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CONFLICT, conflict } from "./version-conflict.mjs";
import { recorded } from "./recorded.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// The criteria files, under whichever name each has: held out
// (`.criteria.mjs`) or turned on (`.test.mjs`).
const CRITERIA = ["square-version-conflict", "edit-switch-cancel"]
  .map((name) => [`test/${name}.test.mjs`, `test/${name}.criteria.mjs`]
    .find((path) => existsSync(new URL(path, root))));

// The spec at the baseline, 95371fb7 on `next` (last changed in
// edb93aba).
const SPEC = "e2e/edit-switch.spec.mjs";
const SPEC_SHA256 =
  "f0548391ef5cd8dfddbba73fe03ab3e1edfeb43525611b744e066d611e4a2cfa";

describe("#658: the recorded conflict and the e2e spec", () => {
  it("box 6: the version-conflict fixture is recorded from a real " +
    "request to Square's sandbox, with its source and date beside it, " +
    "and is the body the other tests use", () => {
    const file = conflict();
    const { _source: source, status, request, response } = file;

    // Its source and date.
    assert.equal(source.service, "square");
    assert.equal(source.environment, "sandbox");
    assert.match(source.recorded, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(source.recorded)));
    assert.match(source.by, /bin\/fixtures\/record/);
    assert.match(source.squareVersion, /^\d{4}-\d{2}-\d{2}$/);

    // A PUT on an order at a stale version, refused as a conflict.
    assert.equal(request.method, "PUT");
    assert.match(request.path, /^\/v2\/orders\/[^/]+$/);
    assert.equal(typeof request.body.order.version, "number");
    assert.equal(status, 400);
    assert.equal(response.errors.length, 1);
    assert.equal(response.errors[0].code, "VERSION_MISMATCH");
    assert.equal(response.errors[0].category, "INVALID_REQUEST_ERROR");
    assert.equal(response.errors[0].field, "order.version");

    // The recorder makes it from a real request: the cancel's PUT sent
    // again after the cancel moved the order's version on.
    assert.match(read("bin/fixtures/record"),
      new RegExp(`\\bsend ${CONFLICT} square\\b`));
    assert.deepEqual(file, recorded("square", CONFLICT));

    // The criteria tests take it from here and write none by hand. Their
    // comments, which quote the contract, are left out of the search.
    assert.equal(CRITERIA.filter(Boolean).length, 2,
      "both criteria files exist");
    for (const path of CRITERIA) {
      const text = read(path).split("\n")
        .filter((line) => !/^\s*\/\//.test(line)).join("\n");

      assert.match(text, /from "\.\/version-conflict\.mjs"/, path);
      assert.ok(!text.includes("VERSION_MISMATCH\""), path);
      assert.ok(!/errors:\s*\[/.test(text), `${path} writes an error body`);
    }
  });

  it("box 7: e2e/edit-switch.spec.mjs is unchanged from the baseline",
    () => {
      const hash = createHash("sha256").update(readFileSync(new URL(SPEC,
        root))).digest("hex");

      assert.equal(hash, SPEC_SHA256,
        `${SPEC} changed; #658 requires it unchanged`);
    });
});
