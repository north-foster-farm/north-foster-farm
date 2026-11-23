// The implementer's own test for #615, beside the criteria tests: a
// choice of everything (--all, or a shared or unmapped path) sends no
// pages, so the keyboard walk covers the whole site. The coordinator
// settled that on 2026-11-18. GitHub answers with #613's recording,
// e2e-dispatch.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { dispatchInputs, e2eCommand } from "../bin/e2e/dispatch.mjs";

const F = JSON.parse(readFileSync(
  new URL("fixtures/github/e2e-dispatch.json", import.meta.url), "utf8"));

const TABLE = {
  shared: ["layouts/_default/**"],
  entries: [
    {
      paths: ["content/about/**"],
      specs: ["e2e/keyboard.spec.mjs"],
      pages: ["/about/"],
    },
    { paths: ["content/faq/**"], specs: ["e2e/faq.spec.mjs"] },
  ],
};

const world = ({ changed = [], flags = {} } = {}) => {
  const run = F.runPassed;
  const posts = [];
  const lines = [];
  const api = async (path, { method = "GET", body } = {}) => {
    if (method === "POST") {
      posts.push(body);

      return { ...F.dispatch.response, workflow_run_id: run.id,
        html_url: run.html_url };
    }
    if (new RegExp(`/actions/runs/${run.id}$`).test(path)) return run;
    throw new Error(`unrecorded ${method} ${path}`);
  };

  return {
    io: { flags, out: (line) => lines.push(String(line)) },
    deps: {
      api,
      table: TABLE,
      branch: async () => "lane/pages-input",
      changed: async () => changed,
      wait: async () => {},
    },
    posts,
    printed: () => lines.join("\n"),
  };
};

describe("bin/nff e2e: no pages for a choice of everything (#615)", () => {
  it("dispatchInputs leaves pages out when the choice is all", () => {
    const inputs = dispatchInputs({ all: true, specs: ["e2e/a.spec.mjs"],
      pages: ["/about/"] });

    assert.deepEqual(inputs, { specs: "e2e/a.spec.mjs" });
  });

  for (const [how, opts] of [
    ["--all", { flags: { all: true } }],
    ["a shared path", { changed: ["layouts/_default/baseof.html"] }],
    ["an unmapped path", { changed: ["somewhere/new.txt",
      "content/about/index.md"] }],
  ]) {
    it(`${how} sends every spec and no pages`, async () => {
      const w = world(opts);

      assert.equal(await e2eCommand([], w.io, w.deps), 0, w.printed());
      assert.equal(w.posts.length, 1);
      assert.equal(w.posts[0].inputs.specs,
        "e2e/faq.spec.mjs e2e/keyboard.spec.mjs");
      assert.equal(w.posts[0].inputs.pages, undefined);
      assert.match(w.printed(), /\/about\/ \(not sent/);
    });
  }
});
