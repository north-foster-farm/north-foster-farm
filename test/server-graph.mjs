// The readers the server import cycles series (#925,
// docs/refactors/server-cycles.md) shares: where a lib/ module is,
// and its source with the comments taken out. Moved here as they
// were from server-imports.test.mjs, server-imports-log.test.mjs and
// the phase 3 criteria file, which each held the same copy, so the
// tests area's duplication gate (jscpd) does not count it three times.
// It is setup, not a test: npm test runs only *.test.mjs.
//
// A module is found as .mjs, or as .mts if #795 (TypeScript) has
// landed when the phase starts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const LIB = join(root, "netlify/functions/lib");
export const rel = (path) => relative(root, path);

// A module in lib/ by its name, as .mjs or .mts, or null.
const moduleOf =(name) => [".mjs", ".mts"]
  .map((ext) => join(LIB, `${name}${ext}`))
  .find((path) => existsSync(path)) || null;

export const need = (name) => {
  const path = moduleOf(name);

  assert.ok(path, `netlify/functions/lib/${name}.mjs does not exist`);

  return path;
};

export const load = async (name) => import(pathToFileURL(need(name)).href);

// The source with its comments taken out, so a comment that names a
// module is not read as an import. Strings and template literals are
// kept as they are, so a URL's "//" is not a comment.
export const code = (text) => {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const pair = text.slice(i, i + 2);

    if (pair === "//") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (pair === "/*") {
      const end = text.indexOf("*/", i + 2);

      i = end === -1 ? text.length : end + 2;
    } else if (c === "\"" || c === "'" || c === "`") {
      let j = i + 1;

      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }

  return out;
};

export const source = (file) => code(readFileSync(file, "utf8"));
