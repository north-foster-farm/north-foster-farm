// One pinned Node (#504): .nvmrc is the only pin, check:node holds this
// Node to it, Netlify reads it (no NODE_VERSION), and npm refuses the
// wrong Node through devEngines.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mismatch, pinOf } from "../bin/check-node.mjs";

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("the Node pin", () => {
  it("reads one exact version from .nvmrc", () => {
    assert.equal(pinOf("24.22.1\n"), "24.22.1");
    assert.equal(pinOf("v24.22.1"), "24.22.1");
    assert.match(pinOf(read(".nvmrc")), /^\d+\.\d+\.\d+$/);
  });

  it("passes the pinned Node and names the mismatch otherwise", () => {
    assert.equal(mismatch("24.22.1", "v24.22.1"), null);
    assert.match(mismatch("24.22.1", "v26.12.1"),
      /Node 26\.12\.1 is running, but \.nvmrc pins 24\.22\.1/);
    assert.match(mismatch("", "v24.22.1"), /empty/);
  });

  it("is the Node these tests run on", () => {
    assert.equal(mismatch(read(".nvmrc")), null);
  });

  it("is the only pin: Netlify sets no NODE_VERSION", () => {
    assert.doesNotMatch(read("netlify.toml"), /NODE_VERSION/);
  });

  it("runs first in npm run check and in every Netlify build", () => {
    const pkg = JSON.parse(read("package.json"));

    assert.match(pkg.scripts.check, /^npm run check:node && /);
    // Every build command; [dev]'s `bin/dev` is the local server.
    const commands = read("netlify.toml").match(/^command = ".*"$/gm)
      .filter((c) => c !== 'command = "bin/dev"');

    assert.ok(commands.length >= 3);
    for (const c of commands) {
      assert.match(c, /^command = "npm run check:node && /);
    }
  });

  it("is the Node the docs name", () => {
    const version = pinOf(read(".nvmrc"));

    for (const doc of ["README.md", "CLAUDE.md", "docs/cloud-lanes.md",
      "docs/security.md"]) {
      assert.ok(read(doc).includes(`Node ${version}`), `${doc}: ${version}`);
      assert.doesNotMatch(read(doc), /Node 26\b/, doc);
    }
  });

  it("makes npm refuse another Node through devEngines", () => {
    const { devEngines } = JSON.parse(read("package.json"));

    const version = pinOf(read(".nvmrc"));

    assert.deepEqual(devEngines, {
      runtime: { name: "node", version, onFail: "error" },
    });
  });
});
