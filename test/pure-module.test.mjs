// The purity check the refactor series' criteria tests share,
// assertPure (test/pure-module.mjs): its banned names, its door, and
// the `imports` option, which the order-form series needs (one file
// allows .js imports, six check none).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { assertPure } from "./pure-module.mjs";

const BANNED = ["document", "window"];

describe("assertPure", () => {
  let dir;

  // A module of `code`, as a file URL.
  const module = (name, code) => {
    const file = join(dir, name);

    writeFileSync(file, code);

    return pathToFileURL(file);
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "nff-pure-"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a module that names nothing banned and imports .mjs", () => {
    const url = module("ok.mjs",
      "import { a } from \"./a.mjs\";\nexport const b = a;\n");

    assert.doesNotThrow(() => assertPure(url, { banned: BANNED }));
  });

  it("fails a banned name, but not one in a comment", () => {
    const named = module("named.mjs", "export const t = document.title;\n");
    const noted = module("noted.mjs",
      "// document is never read here\nexport const t = 1;\n");

    assert.throws(() => assertPure(named, { banned: BANNED }),
      /named\.mjs reaches the DOM/);
    assert.doesNotThrow(() => assertPure(noted, { banned: BANNED }));
  });

  it("fails a .js import by default, as the cart series' files expect",
    () => {
      const url = module("js.mjs",
        "import { a } from \"./a.js\";\nexport const b = a;\n");

      assert.throws(() => assertPure(url, { banned: BANNED }),
        /js\.mjs imports \.\/a\.js/);
    });

  it("takes the pattern `imports` names", () => {
    const url = module("either.mjs",
      "import { a } from \"./a.js\";\nimport { c } from \"./c.mjs\";\n"
      + "export const b = a + c;\n");
    const css = module("css.mjs",
      "import s from \"./s.css\";\nexport const b = s;\n");

    assert.doesNotThrow(() => assertPure(url,
      { banned: BANNED, imports: /\.m?js$/ }));
    assert.throws(() => assertPure(css,
      { banned: BANNED, imports: /\.m?js$/ }), /css\.mjs imports/);
  });

  it("checks no import when `imports` is null, the door still", () => {
    const url = module("any.mjs",
      "import s from \"./s.css\";\nexport const b = s;\n");
    const door = module("door.mjs",
      "import { open } from \"../door.js\";\nexport const b = open;\n");

    assert.doesNotThrow(() => assertPure(url,
      { banned: BANNED, imports: null }));
    assert.throws(() => assertPure(door,
      { banned: BANNED, imports: null, door: /door\.js$/ }),
    /door\.mjs imports the door/);
  });
});
