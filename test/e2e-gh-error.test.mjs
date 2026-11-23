// A failed gh call's message reaches the terminal through bin/nff
// unfiltered, so ghApi strips control characters from it at the source
// (security's review of #625). The stand-in gh here fails a POST with
// an OSC title sequence, a CSI color, a C1 byte and a bidi override on
// stderr; no recording is needed, since only the bytes matter.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ghApi } from "../bin/e2e/dispatch.mjs";
import { printable } from "../bin/e2e/printable.mjs";

const HOSTILE = "\u001b]0;owned\u0007HTTP 422: \u001b[31mbad\u001b[0m"
  + " \u009b2J‮ref‬\nsecond \u0000line";
// eslint-disable-next-line no-control-regex -- the point of the test
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/;

let home;
let oldPath;

before(() => {
  home = mkdtempSync(join(tmpdir(), "e2e-gh-error-"));
  writeFileSync(join(home, "hostile.txt"), HOSTILE);
  writeFileSync(join(home, "gh"), "#!/bin/sh\ncat >/dev/null\n"
    + `cat "${join(home, "hostile.txt")}" >&2\nexit 1\n`);
  chmodSync(join(home, "gh"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${home}${delimiter}${oldPath}`;
});

after(() => {
  process.env.PATH = oldPath;
  rmSync(home, { recursive: true, force: true });
});

describe("bin/e2e/dispatch.mjs ghApi on failure", () => {
  it("rejects with no control character in the message", async () => {
    const error = await ghApi("repos/o/r/actions/workflows/e2e.yml/"
      + "dispatches", { method: "POST", body: { ref: "x" } })
      .then(() => null, (e) => e);

    assert.ok(error, "ghApi resolved");
    assert.doesNotMatch(error.message, CONTROL);
    assert.match(error.message, /HTTP 422: bad 2Jref\nsecond line$/);
  });
});

describe("bin/e2e/dispatch.mjs printable", () => {
  it("drops bidi overrides and isolates", () => {
    assert.equal(printable("a‮b⁦c⁩d‬e"), "abcde");
  });
});
