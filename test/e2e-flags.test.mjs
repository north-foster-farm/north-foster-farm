// The implementer's own tests for e2e's flag handling (#630), beside
// the criteria in test/e2e-help.test.mjs: help exits 0, help wins over
// any other word, and bin/nff's global flags are refused on e2e.
// No request reaches GitHub in any of them: `api` throws on any call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FLAGS, NOT_DISPATCHED, e2eCommand, unknownFlags }
  from "../bin/e2e/dispatch.mjs";

const run = async (args, flags) => {
  const lines = [];
  const calls = [];
  const deps = {
    api: async (path) => {
      calls.push(path);
      throw new Error(`no request expected: ${path}`);
    },
    branch: async () => { calls.push("branch"); return "lane/x"; },
    changed: async () => { calls.push("changed"); return []; },
    table: { shared: [], entries: [] },
    wait: async () => {},
  };
  const code = await e2eCommand(args,
    { flags, out: (line) => lines.push(String(line)) }, deps);

  return { code, printed: lines.join("\n"), calls };
};

describe("bin/nff e2e flags", () => {
  it("--help and -h exit 0 and read nothing", async () => {
    for (const [args, flags] of [[[], { help: true }], [["-h"], {}]]) {
      const { code, printed, calls } = await run(args, flags);

      assert.equal(code, 0);
      assert.match(printed, /--help \| -h/);
      assert.deepEqual(calls, []);
    }
  });

  it("help wins over a bogus flag or a named spec", async () => {
    const { code, printed, calls } = await run(
      ["e2e/account.spec.mjs", "-h"], { bogus: true });

    assert.equal(code, 0);
    assert.doesNotMatch(printed, /Not a flag/);
    assert.deepEqual(calls, []);
  });

  it("--help=false is not help, and is not a flag to refuse", async () => {
    const { code, calls } = await run([], { help: "false" });

    assert.equal(code, 0);
    assert.deepEqual(calls, ["changed"]);
  });

  it("refuses bin/nff's global flags, naming each", async () => {
    for (const name of ["staging", "production", "preview", "no-email",
      "scratch", "development", "yes"]) {
      const { code, printed, calls } = await run([], { [name]: true });

      assert.equal(code, NOT_DISPATCHED, name);
      assert.match(printed, new RegExp(`Not a flag bin/nff e2e takes: `
        + `--${name}`));
      assert.deepEqual(calls, [], name);
    }
  });

  it("refuses --base with no ref, bare or empty", async () => {
    for (const base of [true, ""]) {
      const { code, printed, calls } = await run([], { base });

      assert.equal(code, NOT_DISPATCHED, String(base));
      assert.match(printed, /Not a ref to compare with: --base/);
      assert.match(printed, /--help \| -h/);
      assert.deepEqual(calls, [], String(base));
    }
  });

  it("knows exactly its own flags", () => {
    assert.deepEqual(FLAGS, ["all", "dry-run", "base", "help"]);
    assert.deepEqual(unknownFlags({ all: true, "dry-run": true,
      base: "origin/main", help: "false", dryrun: true }), ["dryrun"]);
  });
});
